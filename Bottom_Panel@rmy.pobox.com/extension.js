// Copyright (C) 2011-2012 R M Yorston
// Licence: GPLv2+

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;
const WindowManager = imports.ui.windowManager;
const WorkspaceSwitcherPopup = imports.ui.workspaceSwitcherPopup;

const Config = imports.misc.config;

const _f = imports.gettext.domain('frippery-bottom-panel').gettext;

const BOTTOM_PANEL_TOOLTIP_SHOW_TIME = 0.15;
const BOTTOM_PANEL_TOOLTIP_HIDE_TIME = 0.1;
const BOTTOM_PANEL_HOVER_TIMEOUT = 300;

const OVERRIDES_SCHEMA = 'org.gnome.shell.overrides';

/*
 * This is a base class for containers that manage the tooltips of their
 * children.  Each child actor with a tooltip should be connected to
 * the container hover handler:
 *
 *    item.actor.connect('notify::hover', Lang.bind(this, function() {
 *                          this._onHover(item); }));
 *
 */
const TooltipContainer = new Lang.Class({
    Name: 'TooltipContainer',

    _init: function() {
        this._showTooltipTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this._tooltipShowing = false;
    },

    _onHover: function(item) {
        if ( item.actor.hover ) {
            if (this._showTooltipTimeoutId == 0) {
                let timeout = this._tooltipShowing ?
                                0 : BOTTOM_PANEL_HOVER_TIMEOUT;
                this._showTooltipTimeoutId = Mainloop.timeout_add(timeout,
                    Lang.bind(this, function() {
                        this._tooltipShowing = true;
                        item.showTooltip();
                        return false;
                    }));
                if (this._resetHoverTimeoutId > 0) {
                    Mainloop.source_remove(this._resetHoverTimeoutId);
                    this._resetHoverTimeoutId = 0;
                }
            }
        } else {
            if (this._showTooltipTimeoutId > 0) {
                Mainloop.source_remove(this._showTooltipTimeoutId);
                this._showTooltipTimeoutId = 0;
            }
            item.hideTooltip();
            if (this._tooltipShowing) {
                this._resetHoverTimeoutId = Mainloop.timeout_add(
                    BOTTOM_PANEL_HOVER_TIMEOUT,
                    Lang.bind(this, function() {
                        this._tooltipShowing = false;
                        return false;
                    }));
            }
        }
    }
});

/*
 * This is a base class for child items that have a tooltip and which allow
 * the hover handler in the parent container class to show/hide the tooltip.
 */
const TooltipChild = new Lang.Class({
    Name: 'TooltipChild',

    showTooltip: function() {
        this.tooltip.opacity = 0;
        this.tooltip.show();

        let [stageX, stageY] = this.actor.get_transformed_position();

        let itemHeight = this.actor.allocation.y2 - this.actor.allocation.y1;
        let itemWidth = this.actor.allocation.x2 - this.actor.allocation.x1;
        let tooltipWidth = this.tooltip.get_width();

        let node = this.tooltip.get_theme_node();
        let yOffset = node.get_length('-y-offset');

        let y = stageY - itemHeight - yOffset;
        let x = Math.floor(stageX + itemWidth/2 - tooltipWidth/2);

        let parent = this.tooltip.get_parent();
        let parentWidth = parent.allocation.x2 - parent.allocation.x1;

        if ( Clutter.get_default_text_direction() == Clutter.TextDirection.LTR ) {
            // stop long tooltips falling off the right of the screen
            x = Math.min(x, parentWidth-tooltipWidth-6);
            // but whatever happens don't let them fall of the left
            x = Math.max(x, 6);
        }
        else {
            x = Math.max(x, 6);
            x = Math.min(x, parentWidth-tooltipWidth-6);
        }

        this.tooltip.set_position(x, y);
        Tweener.addTween(this.tooltip,
                     { opacity: 255,
                       time: BOTTOM_PANEL_TOOLTIP_SHOW_TIME,
                       transition: 'easeOutQuad',
                     });
    },

    hideTooltip: function () {
        this.tooltip.opacity = 255;
        Tweener.addTween(this.tooltip,
                     { opacity: 0,
                       time: BOTTOM_PANEL_TOOLTIP_HIDE_TIME,
                       transition: 'easeOutQuad',
                       onComplete: Lang.bind(this, function() {
                           this.tooltip.hide();
                       })
                     });
    }
});

const MAX_BOTH = Meta.MaximizeFlags.HORIZONTAL | Meta.MaximizeFlags.VERTICAL;

const WindowListItemMenu = new Lang.Class({
    Name: 'WindowListItemMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(actor, app, metaWindow) {
        this.parent(actor, 0.0, St.Side.BOTTOM, 0);

        Main.uiGroup.add_actor(this.actor);
        this.actor.hide();

        this.metaWindow = metaWindow;
        this.app = app;

        this.connect('open-state-changed', Lang.bind(this, this._onToggled));

        let text = metaWindow.minimized ? _f('Unminimize') : _f('Minimize');
        this.itemMinimizeWindow = new PopupMenu.PopupMenuItem(text);
        this.itemMinimizeWindow.connect('activate', Lang.bind(this,
                this._onMinimizeWindowActivate));
        this.addMenuItem(this.itemMinimizeWindow);

        text = metaWindow.get_maximized == MAX_BOTH ?
                _f('Unmaximize') : _f('Maximize');
        this.itemMaximizeWindow = new PopupMenu.PopupMenuItem(text);
        this.itemMaximizeWindow.connect('activate', Lang.bind(this,
                this._onMaximizeWindowActivate));
        this.addMenuItem(this.itemMaximizeWindow);

        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);

        let flag = metaWindow.above;
        this.itemOnTopWindow = new PopupMenu.PopupSwitchMenuItem(
                _f('Always on Top'), flag);
        this.itemOnTopWindow.connect('toggled', Lang.bind(this,
                this._onOnTopWindowToggle));
        this.addMenuItem(this.itemOnTopWindow);

        let flag = metaWindow.is_on_all_workspaces();
        this.itemStickyWindow = new PopupMenu.PopupSwitchMenuItem(
                _f('Always on Visible Workspace'), flag);
        this.itemStickyWindow.connect('toggled', Lang.bind(this,
                this._onStickyWindowToggle));
        this.addMenuItem(this.itemStickyWindow);

        this.itemMove = [];

        let directions = [
            { text: _f('Move to Workspace Left'),
              direction: Meta.MotionDirection.LEFT },
            { text: _f('Move to Workspace Right'),
              direction: Meta.MotionDirection.RIGHT },
            { text: _f('Move to Workspace Up'),
              direction: Meta.MotionDirection.UP },
            { text: _f('Move to Workspace Down'),
              direction: Meta.MotionDirection.DOWN }
        ];

        for ( let i=0; i<directions.length; ++i ) {
            let item = new PopupMenu.PopupMenuItem(directions[i].text);
            item.direction = directions[i].direction;
            item.connect('activate', Lang.bind(this,
                            this._onMoveWindowActivate));
            this.addMenuItem(item);
            this.itemMove.push(item);
        }

        separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);

        let item = new PopupMenu.PopupMenuItem(_f('Close'));
        item.connect('activate', Lang.bind(this, this._onCloseWindowActivate));
        this.addMenuItem(item);
    },

    _onToggled: function(actor, state) {
        if ( !state ) {
            return;
        }

        let text = this.metaWindow.minimized ?
                _f('Unminimize') : _f('Minimize');
        this.itemMinimizeWindow.label.set_text(text);

        text = this.metaWindow.get_maximized() == MAX_BOTH ?
                _f('Unmaximize') : _f('Maximize');
        this.itemMaximizeWindow.label.set_text(text);

        let flag = this.metaWindow.above;
        this.itemOnTopWindow.setToggleState(flag);

        flag = this.metaWindow.is_on_all_workspaces();
        this.itemStickyWindow.setToggleState(flag);

        let ws1 = global.screen.get_active_workspace();

        for ( let i=0; i<this.itemMove.length; ++i ) {
            let ws2 = ws1.get_neighbor(this.itemMove[i].direction);
            if ( ws1 != ws2 ) {
                this.itemMove[i].actor.show();
            }
            else {
                this.itemMove[i].actor.hide();
            }
        }
    },

    _onMinimizeWindowActivate: function(actor, event) {
        if ( this.metaWindow.minimized ) {
            this.metaWindow.activate(global.get_current_time());
            this.itemMinimizeWindow.label.set_text(_f('Minimize'));
        }
        else {
            this.metaWindow.minimize(global.get_current_time());
            this.itemMinimizeWindow.label.set_text(_f('Unminimize'));
        }
    },

    _onMaximizeWindowActivate: function(actor, event) {
        if ( this.metaWindow.get_maximized() == MAX_BOTH ) {
            this.metaWindow.unmaximize(MAX_BOTH);
            this.itemMaximizeWindow.label.set_text(_f('Maximize'));
        }
        else {
            this.metaWindow.maximize(MAX_BOTH);
            this.itemMaximizeWindow.label.set_text(_f('Unmaximize'));
        }
    },

    _onOnTopWindowToggle: function(item, event) {
        if ( item.state ) {
            this.metaWindow.make_above();
        }
        else {
            this.metaWindow.unmake_above();
        }
    },

    _onStickyWindowToggle: function(item, event) {
        if ( item.state ) {
            this.metaWindow.stick();
        }
        else {
            this.metaWindow.unstick();
        }
    },

    _onMoveWindowActivate: function(item, event) {
        let ws1 = global.screen.get_active_workspace();
        let ws2 = ws1.get_neighbor(item.direction);
        if ( ws1 != ws2 ) {
            this.metaWindow.change_workspace(ws2);
        }
    },

    _onCloseWindowActivate: function(actor, event) {
        this.metaWindow.delete(global.get_current_time());
    }
});

const WindowListItem = new Lang.Class({
    Name: 'WindowListItem',
    Extends: TooltipChild,

    _init: function(app, metaWindow) {
        this.actor = new St.Bin({ reactive: true,
                                  track_hover: true,
                                  can_focus: true });

        let title = metaWindow.title;

        this.tooltip = new St.Label({ style_class: 'bottom-panel-tooltip'});
        this.tooltip.set_text(title);
        this.tooltip.hide();
        Main.layoutManager.addChrome(this.tooltip);
        this.actor.label_actor = this.tooltip;

        this._itemBox = new St.BoxLayout({style_class: 'window-list-item-box'});
        this.metaWindow = metaWindow;
        this.actor.add_actor(this._itemBox);

        this.icon = app.create_icon_texture(16);

        if ( !metaWindow.showing_on_its_workspace() ) {
            title = '[' + title + ']';
        }

        this.label = new St.Label({ style_class: 'window-list-item-label',
                                    text: title });
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._itemBox.add(this.icon, { x_fill: false, y_fill: false });
        this._itemBox.add(this.label, { x_fill: true, y_fill: false });

        this.rightClickMenu = new WindowListItemMenu(this.actor, app, metaWindow);

        this._notifyTitleId = metaWindow.connect('notify::title', Lang.bind(this, this._onTitleChanged));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
    },

    _onTitleChanged: function(w) {
        let title = w.title;
        this.tooltip.set_text(title);
        if ( !w.showing_on_its_workspace() ) {
            title = '[' + title + ']';
        }
        this.label.set_text(title);
    },

    _onDestroy: function() {
        this.metaWindow.disconnect(this._notifyTitleId);
        this.tooltip.destroy();
        this.rightClickMenu.destroy();
    },

    _onButtonPress: function(actor, event) {
        let button = event.get_button();
        if ( this.rightClickMenu.isOpen ) {
            this.rightClickMenu.close();
        }
        else if ( button == 1 ) {
            if ( this.metaWindow.has_focus() ) {
                this.metaWindow.minimize(global.get_current_time());
            }
            else {
                this.metaWindow.activate(global.get_current_time());
            }
        }
        else if ( button == 3 ) {
            this.hideTooltip();
            this.rightClickMenu.open();
        }
    },

    doMinimize: function() {
        this.label.text = '[' + this.metaWindow.title + ']';
        this.icon.opacity = 127;
    },

    doMap: function() {
        this.label.text = this.metaWindow.title;
        this.icon.opacity = 255;
    },

    doFocus: function() {
        if ( this.metaWindow.has_focus() ) {
            this._itemBox.add_style_pseudo_class('focused');
        }
        else {
            this._itemBox.remove_style_pseudo_class('focused');
        }
    }
});

const WindowList = new Lang.Class({
    Name: 'WindowList',
    Extends: TooltipContainer,

    _init: function() {
        this.parent();

        this.actor = new St.BoxLayout({ name: 'windowList',
                                        style_class: 'window-list-box' });
        this.actor._delegate = this;
        this._windows = [];

        let tracker = Shell.WindowTracker.get_default();
        tracker.connect('notify::focus-app', Lang.bind(this, this._onFocus));

        global.window_manager.connect('switch-workspace',
                                        Lang.bind(this, this._refreshItems));
        global.window_manager.connect('minimize',
                                        Lang.bind(this, this._onMinimize));
        global.window_manager.connect('map', Lang.bind(this, this._onMap));

        this._workspaces = [];
        this._changeWorkspaces();

        global.screen.connect('notify::n-workspaces',
                                Lang.bind(this, this._changeWorkspaces));

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._refreshItems();
    },

    _onFocus: function() {
        for ( let i = 0; i < this._windows.length; ++i ) {
            this._windows[i].doFocus();
        }
    },

    _onHover: function(item) {
        if ( item.rightClickMenu.isOpen ) {
            item.hideTooltip();
        }
        else {
            this.parent(item);
        }
    },

    _addListItem: function(metaWindow) {
        let tracker = Shell.WindowTracker.get_default();
        if ( metaWindow && tracker.is_window_interesting(metaWindow) ) {
            let app = tracker.get_window_app(metaWindow);
            if ( app ) {
                let item = new WindowListItem(app, metaWindow);
                this._windows.push(item);
                this.actor.add(item.actor);
                item.actor.connect('notify::hover',
                        Lang.bind(this, function() {
                            this._onHover(item);
                        }));
                this._menuManager.addMenu(item.rightClickMenu);
            }
        }
    },

    _refreshItems: function() {
        this.actor.destroy_all_children();
        this._windows = [];

        let metaWorkspace = global.screen.get_active_workspace();
        let windows = metaWorkspace.list_windows();
        windows.sort(function(w1, w2) {
            return w1.get_stable_sequence() - w2.get_stable_sequence();
        });

        // Create list items for each window
        for ( let i = 0; i < windows.length; ++i ) {
            this._addListItem(windows[i]);
        }

        this._onFocus();
    },

    _onMinimize: function(shellwm, actor) {
        for ( let i=0; i<this._windows.length; ++i ) {
            if ( this._windows[i].metaWindow == actor.get_meta_window() ) {
                this._windows[i].doMinimize();
                return;
            }
        }
    },

    _onMap: function(shellwm, actor) {
        for ( let i=0; i<this._windows.length; ++i ) {
            if ( this._windows[i].metaWindow == actor.get_meta_window() ) {
                this._windows[i].doMap();
                return;
            }
        }
    },

    _windowAdded: function(metaWorkspace, metaWindow) {
        if ( metaWorkspace.index() != global.screen.get_active_workspace_index() ) {
            return;
        }

        for ( let i=0; i<this._windows.length; ++i ) {
            if ( this._windows[i].metaWindow == metaWindow ) {
                return;
            }
        }

        this._addListItem(metaWindow);
    },

    _windowRemoved: function(metaWorkspace, metaWindow) {
        if ( metaWorkspace.index() != global.screen.get_active_workspace_index() ) {
            return;
        }

        for ( let i=0; i<this._windows.length; ++i ) {
            if ( this._windows[i].metaWindow == metaWindow ) {
                this.actor.remove_actor(this._windows[i].actor);
                this._windows[i].actor.destroy();
                this._windows.splice(i, 1);
                break;
            }
        }
    },

    _changeWorkspaces: function() {
        for ( let i=0; i<this._workspaces.length; ++i ) {
            let ws = this._workspaces[i];
            ws.disconnect(ws._windowAddedId);
            ws.disconnect(ws._windowRemovedId);
        }

        this._workspaces = [];
        for ( let i=0; i<global.screen.n_workspaces; ++i ) {
            let ws = global.screen.get_workspace_by_index(i);
            this._workspaces[i] = ws;
            ws._windowAddedId = ws.connect('window-added',
                                    Lang.bind(this, this._windowAdded));
            ws._windowRemovedId = ws.connect('window-removed',
                                    Lang.bind(this, this._windowRemoved));
        }
    }
});

let nrows = 1;

function get_ncols() {
    let ncols = Math.floor(global.screen.n_workspaces/nrows);
    if ( global.screen.n_workspaces%nrows != 0 )
       ++ncols

    return ncols;
}

const DynamicWorkspacesSwitch = new Lang.Class({
    Name: 'DynamicWorkspacesSwitch',
    Extends: PopupMenu.Switch,

    _init: function() {
        this._settings = new Gio.Settings({ schema: OVERRIDES_SCHEMA });
        let state = this._settings.get_boolean('dynamic-workspaces');

        this.parent(state);

        this.actor.can_focus = true;
        this.actor.reactive = true;
        this.actor.add_style_class_name("dynamic-workspaces-switch");

        this.actor.connect('button-release-event',
                Lang.bind(this, this._onButtonReleaseEvent));
        this.actor.connect('key-press-event',
                Lang.bind(this, this._onKeyPressEvent));
        this.actor.connect('key-focus-in',
                Lang.bind(this, this._onKeyFocusIn));
        this.actor.connect('key-focus-out',
                Lang.bind(this, this._onKeyFocusOut));
    },

    _onButtonReleaseEvent: function(actor, event) {
        this.toggle();
        return true;
    },

    _onKeyPressEvent: function(actor, event) {
        let symbol = event.get_key_symbol();

        if (symbol == Clutter.KEY_space || symbol == Clutter.KEY_Return) {
            this.toggle();
            return true;
        }

        return false;
    },

    _onKeyFocusIn: function(actor) {
        actor.add_style_pseudo_class('active');
    },

    _onKeyFocusOut: function(actor) {
        actor.remove_style_pseudo_class('active');
    },

    updateState: function() {
        this.setToggleState(this._settings.get_boolean('dynamic-workspaces'));
    },

    toggle: function() {
        this.parent();
        this._settings.set_boolean('dynamic-workspaces', this.state);
    }
});

const WorkspaceDialog = new Lang.Class({
    Name: 'WorkspaceDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function() {
        this.parent({ styleClass: 'workspace-dialog' });

        let table = new St.Table({homogeneous: false, reactive: true,
                              styleClass: 'workspace-dialog-table'});
        this.contentLayout.add(table, { y_align: St.Align.START });

        let label = new St.Label(
                        { style_class: 'applications-menu-dialog-label',
                          text: _f('Number of workspaces') });
        table.add(label, { row: 0, col: 0 });

        let entry = new St.Entry({ style_class: 'workspace-dialog-entry', can_focus: true });

        this._workspaceEntry = entry.clutter_text;
        table.add(entry, { row: 0, col: 1 });
        this.setInitialKeyFocus(this._workspaceEntry);

        label = new St.Label({ style_class: 'workspace-dialog-label',
                                   text: _f('Rows in workspace switcher') });
        table.add(label, { row: 1, col: 0 });

        entry = new St.Entry({ style_class: 'workspace-dialog-entry', can_focus: true });

        this._rowEntry = entry.clutter_text;
        table.add(entry, { row: 1, col: 1 });

        label = new St.Label({ style_class: 'workspace-dialog-label',
                                   text: _f('Dynamic workspaces') });
        table.add(label, { row: 2, col: 0 });

        this._dynamicWorkspaces = new DynamicWorkspacesSwitch();
        table.add(this._dynamicWorkspaces.actor, { row: 2, col: 1 });

        let buttons = [{ action: Lang.bind(this, this.close),
                         label:  _("Cancel"),
                         key:    Clutter.Escape},
                       { action: Lang.bind(this, function() {
                                        this._updateValues();
                                        this.close();}),
                         label:  _("OK"),
                         key:    Clutter.Return }];

        this.setButtons(buttons);
    },

    open: function() {
        this._workspaceEntry.set_text(''+global.screen.n_workspaces);
        this._rowEntry.set_text(''+nrows);
        this._dynamicWorkspaces.updateState();

        this.parent();
    },

    _updateValues: function() {
        let num = parseInt(this._workspaceEntry.get_text());
        if ( !isNaN(num) && num >= 2 && num <= 32 ) {
            let old_num = global.screen.n_workspaces;
            if ( num > old_num ) {
                for ( let i=old_num; i<num; ++i ) {
                    global.screen.append_new_workspace(false,
                            global.get_current_time());
                }
            }
            else if ( num < old_num ) {
                for ( let i=old_num-1; i>=num; --i ) {
                    let ws = global.screen.get_workspace_by_index(i);
                    global.screen.remove_workspace(ws,
                            global.get_current_time());
                }
            }
        }

        let rows = parseInt(this._rowEntry.get_text());
        if ( !isNaN(rows) && rows > 0 && rows < 6 && rows != nrows ) {
            nrows = rows;
            bottomPanel.workspaceSwitcher._createButtons();

            let rowFilePath = GLib.get_home_dir() + '/.frippery_rows';
            let rowFile = Gio.file_new_for_path(rowFilePath);
            rowFile.replace_contents(''+rows+'\n', null, false, 0, null);
        }
    }
});
Signals.addSignalMethods(WorkspaceDialog.prototype);

const WorkspaceButton = new Lang.Class({
    Name: 'WorkspaceButton',
    Extends: TooltipChild,

    _init: function(index) {
        this.actor = new St.Button({ name: 'workspaceButton',
                                 style_class: 'workspace-button',
                                 reactive: true });
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this.label = new St.Label();
        this.actor.set_child(this.label);

        this.tooltip = new St.Label({ style_class: 'bottom-panel-tooltip'});
        this.tooltip.hide();
        Main.layoutManager.addChrome(this.tooltip);
        this.actor.label_actor = this.tooltip;

        this.setIndex(index);
    },

    _onClicked: function() {
        if ( this.index >= 0 && this.index < global.screen.n_workspaces ) {
            let metaWorkspace = global.screen.get_workspace_by_index(this.index);
            metaWorkspace.activate(global.get_current_time());
        }

        return true;
    },

    _onDestroy: function() {
        this.tooltip.destroy();
    },

    setIndex: function(index) {
        if ( index < 0 || index >= global.screen.n_workspaces ) {
            return;
        }

        this.index = index;

        let active = global.screen.get_active_workspace_index();

        if ( index == active ) {
            this.label.set_text('-' + (index+1).toString() + '-');
            this.actor.add_style_pseudo_class('outlined');
        }
        else if ( index < global.screen.n_workspaces ) {
            this.label.set_text((index+1).toString());
            this.actor.remove_style_pseudo_class('outlined');
        }
        else {
            this.label.set_text('');
            this.actor.remove_style_pseudo_class('outlined');
        }
        this.tooltip.set_text(Meta.prefs_get_workspace_name(index));
    }
});

const WorkspaceSwitcher = new Lang.Class({
    Name: 'WorkspaceSwitcher',
    Extends: TooltipContainer,

    _init: function() {
        this.parent();

        this.actor = new St.BoxLayout({ name: 'workspaceSwitcher',
                                        style_class: 'workspace-switcher',
                                        reactive: true });
        this.actor.connect('button-release-event', this._showDialog);
        this.actor.connect('scroll-event', this._onScroll);
        this.actor._delegate = this;
        this.button = [];
        this._createButtons();

        global.screen.connect('notify::n-workspaces',
                                Lang.bind(this, this._createButtons));
        global.window_manager.connect('switch-workspace',
                                Lang.bind(this, this._updateButtons));
    },

    _createButtons: function() {
        this.actor.destroy_all_children();
        this.button = [];

        this.row_indicator = null;
        if ( nrows > 1 ) {
            this.row_indicator = new St.DrawingArea({ reactive: true,
                                    style_class: 'workspace-row-indicator' });
            this.row_indicator.connect('repaint', Lang.bind(this, this._draw));
            this.row_indicator.connect('button-press-event', Lang.bind(this, this._rowButtonPress));
            this.row_indicator.connect('scroll-event', Lang.bind(this, this._rowScroll));
            this.actor.add(this.row_indicator);
        }

        let ncols = get_ncols();
        let active = global.screen.get_active_workspace_index();
        let row = Math.floor(active/ncols);

        let index = row*ncols;
        for ( let i=0; i<ncols; ++i ) {
            let btn = new WorkspaceButton(index++);
            this.actor.add(btn.actor);
            btn.actor.connect('notify::hover',
                       Lang.bind(this, function() {
                            this._onHover(btn);
                        }));
            this.button[i] = btn;
        }

        global.screen.override_workspace_layout(Meta.ScreenCorner.TOPLEFT,
                false, nrows, ncols);
    },

    _updateButtons: function() {
        let ncols = get_ncols();
        let active = global.screen.get_active_workspace_index();
        let row = Math.floor(active/ncols);

        let index = row*ncols;
        for ( let i=0; i<this.button.length; ++i ) {
            this.button[i].setIndex(index++);
        }

        if ( this.row_indicator ) {
            this.row_indicator.queue_repaint();
        }
    },

    _showDialog: function(actor, event) {
        let button = event.get_button();
        if ( button == 3 ) {
            if ( this._workspaceDialog == null ) {
                this._workspaceDialog = new WorkspaceDialog();
            }
            this._workspaceDialog.open();
            return true;
        }
        return false;
    },

    _onScroll: function(actor, event) {
        let direction = event.get_scroll_direction();
        let ncols = get_ncols();
        let active = global.screen.get_active_workspace_index();
        let index = global.screen.n_workspaces;

        if ( direction == Clutter.ScrollDirection.UP ) {
            if ( active%ncols > 0 ) {
                index = active-1;
            }
        }
        if ( direction == Clutter.ScrollDirection.DOWN ) {
            if ( active < global.screen.n_workspaces-1 &&
                         active%ncols != ncols-1 ) {
                index = active+1;
            }
        }

        if ( index >= 0 && index < global.screen.n_workspaces ) {
            let metaWorkspace = global.screen.get_workspace_by_index(index);
            metaWorkspace.activate(global.get_current_time());
        }

        return true;
    },

    _rowButtonPress: function(actor, event) {
        if ( event.get_button() != 1 ) {
            return false;
        }

        let ncols = get_ncols();
        let active = global.screen.get_active_workspace_index();
        let row = Math.floor(active/ncols);

        let [x, y] = event.get_coords();
        let [wx, wy] = actor.get_transformed_position();
        let [w, h] = actor.get_size();
        y -= wy;

        let new_row = Math.floor(nrows*y/h);
        let index = global.screen.n_workspaces;
        if ( new_row != row ) {
            index = new_row*ncols + active%ncols;
        }

        if ( index >= 0 && index < global.screen.n_workspaces ) {
            let metaWorkspace = global.screen.get_workspace_by_index(index);
            metaWorkspace.activate(global.get_current_time());
        }

        return true;
    },

    _rowScroll: function(actor, event) {
        let direction = event.get_scroll_direction();
        let ncols = get_ncols();
        let active = global.screen.get_active_workspace_index();
        let row = Math.floor(active/ncols);

        let index = global.screen.n_workspaces;
        if ( direction == Clutter.ScrollDirection.DOWN ) {
            index = (row+1)*ncols + active%ncols;
        }
        if ( direction == Clutter.ScrollDirection.UP ) {
            index = (row-1)*ncols + active%ncols;
        }

        if ( index >= 0 && index < global.screen.n_workspaces ) {
            let metaWorkspace = global.screen.get_workspace_by_index(index);
            metaWorkspace.activate(global.get_current_time());
        }

        return true;
    },

    _draw: function(area) {
        let [width, height] = area.get_surface_size();
        let themeNode = this.row_indicator.get_theme_node();
        let cr = area.get_context();

        let active_color = themeNode.get_color('-active-color');
        let inactive_color = themeNode.get_color('-inactive-color');

        let ncols = get_ncols();
        let active = global.screen.get_active_workspace_index();
        let row = Math.floor(active/ncols);

        for ( let i=0; i<nrows; ++i ) {
            let y = (i+1)*height/(nrows+1);
            cr.moveTo(0, y);
            cr.lineTo(width, y);
            let color = row == i ? active_color : inactive_color;
            Clutter.cairo_set_source_color(cr, color);
            cr.setLineWidth(2.0);
            cr.stroke();
        }
    }
});

const MessageButton = new Lang.Class({
    Name: 'MessageButton',

    _init: function() {
        this.actor = new St.Button({ name: 'messageButton',
                                     style_class: 'message-button',
                                     reactive: true });

        let text = '!';
        if ( Main.messageTray._summary.get_children().length == 0 ) {
            text = ' ';
        }
        this.messageLabel = new St.Label({ text: text });
        this.actor.set_child(this.messageLabel);
        this.actor.connect('clicked', Lang.bind(this, function() {
            Main.messageTray.toggleState();
        }));

        this.actorAddedId = Main.messageTray._summary.connect('actor-added',
            Lang.bind(this, function() {
                this.messageLabel.set_text('!');
        }));

        this.actorRemovedId = Main.messageTray._summary.connect('actor-removed',
            Lang.bind(this, function() {
                if ( Main.messageTray._summary.get_children().length == 0 ) {
                    this.messageLabel.set_text(' ');
                }
        }));
    }
});

const BottomPanel = new Lang.Class({
    Name: 'BottomPanel',

    _init : function() {
        this.actor = new St.BoxLayout({ style_class: 'bottom-panel',
                                        name: 'bottomPanel',
                                        reactive: true });
        this.actor._delegate = this;

        let windowList = new WindowList();
        this.actor.add(windowList.actor, { expand: true });

        this.workspaceSwitcher = new WorkspaceSwitcher();
        this.actor.add(this.workspaceSwitcher.actor);

        this.messageButton = new MessageButton();
        this.actor.add(this.messageButton.actor);

        Main.layoutManager.addChrome(this.actor, { affectsStruts: true,
                                                   trackFullscreen: true });

        this.actor.connect('style-changed', Lang.bind(this, this.relayout));
        this._monitorsChangedId = global.screen.connect('monitors-changed',
                Lang.bind(this, this.relayout));
        this._sessionUpdatedId = Main.sessionMode.connect('updated',
                Lang.bind(this, this._sessionUpdated));
    },

    relayout: function() {
        let primary = Main.layoutManager.primaryMonitor;

        let h = this.actor.get_theme_node().get_height();
        this.actor.set_position(primary.x, primary.y+primary.height-h);
        this.actor.set_size(primary.width, -1);
    },

    _sessionUpdated: function() {
        this.actor.visible = Main.sessionMode.hasWorkspaces;
    }
});

const FRIPPERY_TIMEOUT = 400;

const FripperySwitcherPopup = new Lang.Class({
    Name: 'FripperySwitcherPopup',
    Extends:  WorkspaceSwitcherPopup.WorkspaceSwitcherPopup,

    _getPreferredHeight : function (actor, forWidth, alloc) {
        let children = this._list.get_children();
        let primary = Main.layoutManager.primaryMonitor;

        let availHeight = primary.height;
        availHeight -= Main.panel.actor.height;
        availHeight -= bottomPanel.actor.height;
        availHeight -= this.actor.get_theme_node().get_vertical_padding();
        availHeight -= this._container.get_theme_node().get_vertical_padding();
        availHeight -= this._list.get_theme_node().get_vertical_padding();

        let [childMinHeight, childNaturalHeight] = children[0].get_preferred_height(-1);

        let height = nrows * childNaturalHeight;

        let spacing = this._itemSpacing * (nrows - 1);
        height += spacing;
        height = Math.min(height, availHeight);

        this._childHeight = (height - spacing) / nrows;

        alloc.min_size = height;
        alloc.natural_size = height;
    },

    _getPreferredWidth : function (actor, forHeight, alloc) {
        let children = this._list.get_children();
        let primary = Main.layoutManager.primaryMonitor;

        let availWidth = primary.width;
        availWidth -= this.actor.get_theme_node().get_horizontal_padding();
        availWidth -= this._container.get_theme_node().get_horizontal_padding();
        availWidth -= this._list.get_theme_node().get_horizontal_padding();

        let ncols = get_ncols();

        let [childMinHeight, childNaturalHeight] = children[0].get_preferred_height(-1);
        let childNaturalWidth = childNaturalHeight * primary.width/primary.height;

        let width = ncols * childNaturalWidth;

        let spacing = this._itemSpacing * (ncols - 1);
        width += spacing;
        width = Math.min(width, availWidth);

        this._childWidth = (width - spacing) / ncols;

        alloc.min_size = width;
        alloc.natural_size = width;
    },

    _allocate : function (actor, box, flags) {
        let children = this._list.get_children();
        let childBox = new Clutter.ActorBox();

        let ncols = get_ncols();

        for ( let ir=0; ir<nrows; ++ir ) {
            for ( let ic=0; ic<ncols; ++ic ) {
                let i = ncols*ir + ic;
                let x = box.x1 + ic * (this._childWidth + this._itemSpacing);
                childBox.x1 = x;
                childBox.x2 = x + this._childWidth;
                let y = box.y1 + ir * (this._childHeight + this._itemSpacing);
                childBox.y1 = y;
                childBox.y2 = y + this._childHeight;
                children[i].allocate(childBox, flags);
            }
        }
    },

    _redraw : function(direction, activeWorkspaceIndex) {
        this._list.destroy_all_children();

        for (let i = 0; i < global.screen.n_workspaces; i++) {
            let indicator = null;

           if (i == activeWorkspaceIndex && direction == Meta.MotionDirection.LEFT)
               indicator = new St.Bin({ style_class: 'ws-switcher-active-left' });
           else if (i == activeWorkspaceIndex && direction == Meta.MotionDirection.RIGHT)
               indicator = new St.Bin({ style_class: 'ws-switcher-active-right' });
           else if (i == activeWorkspaceIndex && direction == Meta.MotionDirection.UP)
               indicator = new St.Bin({ style_class: 'ws-switcher-active-up' });
           else if(i == activeWorkspaceIndex && direction == Meta.MotionDirection.DOWN)
               indicator = new St.Bin({ style_class: 'ws-switcher-active-down' });
           else
               indicator = new St.Bin({ style_class: 'ws-switcher-box' });

           this._list.add_actor(indicator);

        }
    },

    display : function(direction, activeWorkspaceIndex) {
        this._redraw(direction, activeWorkspaceIndex);
        if (this._timeoutId != 0)
            Mainloop.source_remove(this._timeoutId);
        this._timeoutId = Mainloop.timeout_add(FRIPPERY_TIMEOUT, Lang.bind(this, this._onTimeout));
        this._show();
    }
});

let myShowTray, origShowTray;
let myTrayDwellTimeout, origTrayDwellTimeout;
let myUpdateShowingNotification, origUpdateShowingNotification;
let myOnNotificationExpanded, origOnNotificationExpanded;
let myShowWorkspaceSwitcher, origShowWorkspaceSwitcher;
let pre_363 = true;

function init(extensionMeta) {
    let localePath = extensionMeta.path + '/locale';
    imports.gettext.bindtextdomain('frippery-bottom-panel', localePath);

    // Yes, I know, I should use a schema
    let rowFilePath = GLib.get_home_dir() + '/.frippery_rows';
    let rowFile = Gio.file_new_for_path(rowFilePath);
    if ( rowFile.query_exists(null) ) {
        let [flag, str] = rowFile.load_contents(null);
        if ( flag ) {
            let rows = parseInt(str);
            if ( !isNaN(rows) && rows > 0 && rows < 6 ) {
                nrows = rows;
            }
        }
    }

    origShowTray = MessageTray.MessageTray.prototype._showTray;
    myShowTray = function() {
        let modal = !this._overviewVisible;

        if (!this._grabHelper.grab({ actor: this.actor,
                                     modal: modal,
                                     onUngrab: Lang.bind(this, this._escapeTray) })) {
            this._traySummoned = false;
            return false;
        }

        let h = bottomPanel.actor.get_theme_node().get_height();
        this._tween(this.actor, '_trayState', MessageTray.State.SHOWN,
                    { y: - this.actor.height - h,
                      time: MessageTray.ANIMATION_TIME,
                      transition: 'easeOutQuad'
                    });

        if (!this._overviewVisible)
            this._lightbox.show();

        return true;
    };

    origTrayDwellTimeout = MessageTray.MessageTray.prototype._trayDwellTimeout;
    myTrayDwellTimeout = function() {
        this._trayDwellTimeoutId = 0;

        return false;
    };

    origUpdateShowingNotification =
        MessageTray.MessageTray.prototype._updateShowingNotification;
    myUpdateShowingNotification = function() {
        this._notification.acknowledged = true;

        if (pre_363)
            Tweener.removeTweens(this._notificationWidget);

        if (this._notification.urgency == MessageTray.Urgency.CRITICAL ||
                (pre_363 && this._notification.expanded))
            this._expandNotification(true);

        let tweenParams = { opacity: 255,
                            time: MessageTray.ANIMATION_TIME,
                            transition: 'easeOutQuad',
                            onComplete: this._showNotificationCompleted,
                            onCompleteScope: this
                          };
        if (!pre_363 || !this._notification.expanded) {
            let h = bottomPanel.actor.get_theme_node().get_height();
            tweenParams.y = -this._notificationWidget.height - h;
        }

        this._tween(this._notificationWidget, '_notificationState', MessageTray.State.SHOWN, tweenParams);
    };

    origOnNotificationExpanded =
        MessageTray.MessageTray.prototype._onNotificationExpanded;
    myOnNotificationExpanded = function() {
        let h = bottomPanel.actor.get_theme_node().get_height();
        let expandedY = - this._notificationWidget.height - h;
        // Using the close button causes a segfault when the tray is next
        // invoked.  So don't display the close button.
        //this._closeButton.show();

        // Don't animate the notification to its new position if it has shrunk:
        // there will be a very visible "gap" that breaks the illusion.
        if (this._notificationWidget.y < expandedY) {
            this._notificationWidget.y = expandedY;
        } else if (this._notification.y != expandedY) {
            this._tween(this._notificationWidget, '_notificationState', MessageTray.State.SHOWN,
                        { y: expandedY,
                          opacity: 255,
                          time: MessageTray.ANIMATION_TIME,
                          transition: 'easeOutQuad'
                        });
        }
    };

    MessageTray.MessageTray.prototype.toggleState = function() {
        if (this._summaryState == MessageTray.State.SHOWN) {
            this._pointerInSummary = false;
            this._traySummoned = false;
        }
        else {
            this._pointerInSummary = true;
            this._traySummoned = true;
        }
        this._updateState();
    };

    origShowWorkspaceSwitcher =
        WindowManager.WindowManager.prototype._showWorkspaceSwitcher;

    myShowWorkspaceSwitcher = function(display, screen, window, binding) {
        if (screen.n_workspaces == 1)
            return;

        let [action,,,direction] = binding.get_name().split('-');
        let direction = Meta.MotionDirection[direction.toUpperCase()];
        let newWs;

        if (action == 'switch')
            newWs = this.actionMoveWorkspace(direction);
        else
            newWs = this.actionMoveWindow(window, direction);

        if (!Main.overview.visible) {
            if (this._workspaceSwitcherPopup == null) {
                this._workspaceSwitcherPopup = new FripperySwitcherPopup();
                this._workspaceSwitcherPopup.connect('destroy',
                    Lang.bind(this, function() {
                        this._workspaceSwitcherPopup = null;
                    }));
            }
            this._workspaceSwitcherPopup.display(direction, newWs.index());
        }
    };

    WindowManager.WindowManager.prototype._reset = function() {
        Meta.keybindings_set_custom_handler('switch-to-workspace-left',
                    Lang.bind(this, this._showWorkspaceSwitcher));
        Meta.keybindings_set_custom_handler('switch-to-workspace-right',
                    Lang.bind(this, this._showWorkspaceSwitcher));
        Meta.keybindings_set_custom_handler('switch-to-workspace-up',
                    Lang.bind(this, this._showWorkspaceSwitcher));
        Meta.keybindings_set_custom_handler('switch-to-workspace-down',
                    Lang.bind(this, this._showWorkspaceSwitcher));
        Meta.keybindings_set_custom_handler('move-to-workspace-left',
                    Lang.bind(this, this._showWorkspaceSwitcher));
        Meta.keybindings_set_custom_handler('move-to-workspace-right',
                    Lang.bind(this, this._showWorkspaceSwitcher));
        Meta.keybindings_set_custom_handler('move-to-workspace-up',
                    Lang.bind(this, this._showWorkspaceSwitcher));
        Meta.keybindings_set_custom_handler('move-to-workspace-down',
                    Lang.bind(this, this._showWorkspaceSwitcher));

        this._workspaceSwitcherPopup = null;
    };
}

let bottomPanel = null;

function enable() {
    MessageTray.MessageTray.prototype._showTray = myShowTray;
    MessageTray.MessageTray.prototype._trayDwellTimeout = myTrayDwellTimeout;
    MessageTray.MessageTray.prototype._updateShowingNotification =
        myUpdateShowingNotification;
    MessageTray.MessageTray.prototype._onNotificationExpanded =
        myOnNotificationExpanded;
    WindowManager.WindowManager.prototype._showWorkspaceSwitcher =
        myShowWorkspaceSwitcher;

    // we know this is 3.6, but what's the point version?
    let version = Config.PACKAGE_VERSION.split('.');
    if (version[2] >= 3)
        pre_363 = false;

    Main.wm._reset();

    bottomPanel = new BottomPanel();
    bottomPanel.relayout();
}

function disable() {
    global.screen.override_workspace_layout(Meta.ScreenCorner.TOPLEFT, false, -1, 1);

    MessageTray.MessageTray.prototype._showTray = origShowTray;
    MessageTray.MessageTray.prototype._trayDwellTimeout = origTrayDwellTimeout;
    MessageTray.MessageTray.prototype._updateShowingNotification =
        origUpdateShowingNotification;
    MessageTray.MessageTray.prototype._onNotificationExpanded =
        origOnNotificationExpanded;
    WindowManager.WindowManager.prototype._showWorkspaceSwitcher =
        origShowWorkspaceSwitcher;

    Main.wm._reset();

    if ( bottomPanel ) {
        let button = bottomPanel.messageButton;

        if ( button && button.actorAddedId ) {
            Main.messageTray._summary.disconnect(button.actorAddedId);
        }
        if ( button && button.actorRemovedId ) {
            Main.messageTray._summary.disconnect(button.actorRemovedId);
        }
        if ( this._monitorsChangedId ) {
            global.screen.disconnect(this._monitorsChangedId);
        }
        if ( this._sessionUpdatedId ) {
            Main.sessionMode.disconnect(this._sessionUpdatedId);
        }
        Main.layoutManager.removeChrome(bottomPanel.actor);
        bottomPanel = null;
    }
}
