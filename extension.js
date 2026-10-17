import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const label = (text, style = 'nd-text') => new St.Label({text, style_class: style});
const box = (vertical = false, style = '') => new St.BoxLayout({vertical, style_class: style});
function button(text, action, style = 'nd-button') {
    const b = new St.Button({label: text, style_class: style, can_focus: true});
    b.connect('clicked', action);
    return b;
}
function iconButton(iconName, text, action, style = 'nd-button', iconSize = 16, showLabel = true) {
    const b = new St.Button({style_class: style, can_focus: true, accessible_name: text});
    const content = box(false, 'nd-icon-label');
    content.x_align = Clutter.ActorAlign.CENTER;
    const icon = new St.Icon({icon_name: iconName, icon_size: iconSize, style_class: 'nd-icon'});
    content.add_child(icon);
    if (showLabel) {
        b._ndLabel = label(text, 'nd-button-label');
        content.add_child(b._ndLabel);
    }
    b.set_child(content);
    b._ndIcon = icon;
    b.connect('clicked', action);
    return b;
}
function tile(title) {
    const b = box(true, 'nd-tile');
    b.add_child(label(title, 'nd-eyebrow'));
    return b;
}
function readText(path) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (obj, result) => {
            try {
                const [ok, bytes] = obj.load_contents_finish(result);
                resolve(ok ? new TextDecoder().decode(bytes) : '');
            } catch { resolve(''); }
        });
    });
}
function readFilesystem(path) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.query_filesystem_info_async('filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT,
            null, (source, result) => {
                try {
                    const info = source.query_filesystem_info_finish(result);
                    resolve({size: info.get_attribute_uint64('filesystem::size'),
                        free: info.get_attribute_uint64('filesystem::free')});
                } catch { resolve(null); }
            });
    });
}
function historyChart(style) {
    const chart = box(false, `nd-chart ${style}`);
    const bars = [];
    for (let i = 0; i < 22; i++) {
        const bar = new St.Widget({style_class: 'nd-chart-bar', width: 5, height: 3,
            y_align: Clutter.ActorAlign.END});
        chart.add_child(bar);
        bars.push(bar);
    }
    return {chart, bars, values: []};
}
function pushHistory(history, percent) {
    history.values.push(Math.max(0, Math.min(100, percent)));
    if (history.values.length > history.bars.length) history.values.shift();
    const offset = history.bars.length - history.values.length;
    for (let i = 0; i < history.bars.length; i++) {
        const value = i < offset ? 0 : history.values[i - offset];
        history.bars[i].height = Math.max(3, Math.round(value * 0.72));
        history.bars[i].opacity = i < offset ? 60 : 255;
    }
}
function clearHistory(history) {
    history.values = [];
    for (const bar of history.bars) {
        bar.height = 3;
        bar.opacity = 60;
    }
}
function formatDuration(microseconds) {
    if (!Number.isFinite(microseconds) || microseconds < 0) return '—:——';
    const seconds = Math.floor(microseconds / 1000000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function formatRate(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '—';
    const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
    let value = bytesPerSecond;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value < 10 && index ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

const ACCENTS = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800',
    orange: '#ed6f18', red: '#e24b41', pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
};
const PING_SERVER = {host: 'jogar.mush.com.br', port: 25565};
const DEFAULT_APPEARANCE = {
    mode: 'auto', background: '#171c1d', surface: '#252c2d',
    accent: '#69bcc6', text: '#e1e8e6',
};
const validColor = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
function rgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function mix(a, b, amount) {
    const first = rgb(a), second = rgb(b);
    return `#${first.map((v, i) => Math.round(v * (1 - amount) + second[i] * amount)
        .toString(16).padStart(2, '0')).join('')}`;
}
function lightness(hex) {
    const values = rgb(hex).map(v => {
        const n = v / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function readableOn(hex) { return lightness(hex) > 0.35 ? '#172024' : '#ffffff'; }

export default class AevumExtension extends Extension {
    enable() {
        this._alive = true;
        this._generation = (this._generation ?? 0) + 1;
        this._mediaGeneration = 0;
        this._artGeneration = 0;
        this._dateMenu = Main.panel.statusArea.dateMenu;
        if (!this._dateMenu?.menu?.box)
            throw new Error(_('The date and time menu is unavailable.'));
        this._menu = this._dateMenu.menu;
        this._menu.actor.add_style_class_name('nd-menu');
        this._appearance = this._loadAppearance();
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceIds = [
            this._interface.connect('changed::color-scheme', () => this._applyTheme()),
            this._interface.connect('changed::accent-color', () => this._applyTheme()),
        ];
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._themeContextId = this._themeContext.connect('changed', () => {
            if (this._loadedTheme === this._themeContext.get_theme()) return;
            if (this._themeFile) {
                try { this._themeFile.delete(null); } catch (e) { console.debug(`Aevum: ${e.message}`); }
                this._themeFile = null;
            }
            this._applyTheme();
        });
        this._original = this._menu.box.get_children().map(actor => ({actor, visible: actor.visible}));
        this._root = box(true, 'nd-root');
        this._menu.box.insert_child_at_index(this._root, 0);
        this._tabs = new Map();
        this._tabsBox = box(false, 'nd-tabs');
        this._tabRows = [box(false, 'nd-tab-row'), box(false, 'nd-tab-row')];
        this._tabsBox.add_child(this._tabRows[0]);
        this._tabsBox.add_child(this._tabRows[1]);
        for (const [key, title, icon] of [
            ['dashboard', _('Overview'), 'view-grid-symbolic'],
            ['media', _('Media'), 'applications-multimedia-symbolic'],
            ['performance', _('System'), 'computer-symbolic'],
            ['notifications', _('Notifications'), 'preferences-system-notifications-symbolic'],
            ['appearance', _('Appearance'), 'preferences-desktop-appearance-symbolic'],
        ]) {
            const tab = iconButton(icon, title, () => this._select(key), 'nd-tab', 14);
            tab.x_expand = true;
            this._tabs.set(key, tab);
            this._tabRows[0].add_child(tab);
        }
        this._root.add_child(this._tabsBox);
        this._pages = new Map();
        this._pageContent = new Map();
        this._buildDashboard();
        this._buildMedia();
        this._updateMedia();
        this._buildPerformance();
        this._buildAppearance();
        this._notice = label('', 'nd-notice');
        this._notice.clutter_text.line_wrap = true;
        this._notice.hide();
        this._root.add_child(this._notice);
        this._applyTheme();
        this._openId = this._menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._lastCpu = null;
                this._cpu.text = '—';
                clearHistory(this._cpuHistory);
                clearHistory(this._memoryHistory);
                this._lastNetwork = null;
                this._pingCancellable?.cancel();
                this._pingRunning = false;
                this._pingLastAt = 0;
                this._pingSession = (this._pingSession ?? 0) + 1;
                this._pingValue.text = '—';
                this._pingDetail.text = _('Waiting for test…');
                this._calendar.setDate(new Date());
                this._refresh();
                this._refreshMedia();
                this._refreshPosition();
            }
        });
        this._control = Volume.getMixerControl();
        this._controlIds = [
            this._control.connect('default-sink-changed', () => this._bindSink()),
            this._control.connect('state-changed', () => this._bindSink()),
        ];
        this._bindSink();
        this._nameId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _o, _i, _n, params) => {
                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (name.startsWith('org.mpris.MediaPlayer2.')) {
                    if (name === this._playerName && oldOwner !== newOwner)
                        this._dropPlayer();
                    this._refreshMedia();
                }
            });
        this._select('dashboard');
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._updateLayout());
        this._updateLayout();
        this._refresh();
        this._refreshMedia();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._menu.isOpen) {
                this._refresh();
                this._refreshPosition();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildDashboard() {
        const page = box(false, 'nd-grid');
        this._dashboardGrid = page;
        const left = box(true, 'nd-column');
        this._dashboardColumns = [left];
        const clock = tile(_('NOW'));
        this._clock = label('--:--', 'nd-clock');
        this._date = label('', 'nd-muted');
        clock.add_child(this._clock);
        clock.add_child(this._date);
        left.add_child(clock);
        const identity = tile(_('YOUR SPACE'));
        identity.add_child(label(GLib.get_user_name(), 'nd-heading'));
        identity.add_child(label(`${GLib.get_os_info('NAME') ?? 'Linux'} · GNOME 48`, 'nd-muted'));
        identity.add_child(iconButton('preferences-system-symbolic', _('Settings'), () => this._launch('org.gnome.Settings.desktop')));
        identity.add_child(iconButton('weather-clear-symbolic', _('Weather'), () => this._launch('org.gnome.Weather.desktop')));
        left.add_child(identity);
        page.add_child(left);
        const calendar = tile(_('CALENDAR'));
        calendar.add_style_class_name('nd-calendar-tile');
        calendar.x_expand = true;
        this._calendar = new Calendar.Calendar();
        this._calendar.add_style_class_name('nd-calendar');
        this._calendar.x_align = Clutter.ActorAlign.CENTER;
        this._eventSource = new Calendar.EmptyEventSource();
        this._calendar.setEventSource(this._eventSource);
        this._calendar.setDate(new Date());
        calendar.add_child(this._calendar);
        page.add_child(calendar);
        const right = box(true, 'nd-column');
        this._dashboardColumns.push(right);
        const sound = tile(_('AUDIO OUTPUT'));
        this._volumeLabel = label(_('Waiting for audio'), 'nd-muted');
        this._slider = new Slider.Slider(0);
        this._slider.accessible_name = _('Audio output volume');
        this._slider.connect('notify::value', () => {
            if (!this._sink || this._syncingVolume) return;
            const normal = this._control.get_vol_max_norm();
            this._sink.volume = Math.round(this._slider.value * normal);
            this._sink.push_volume();
            if (this._sink.is_muted && this._slider.value > 0) this._sink.change_is_muted(false);
        });
        this._mute = iconButton('audio-volume-high-symbolic', _('Mute'), () => {
            if (this._sink) this._sink.change_is_muted(!this._sink.is_muted);
        });
        sound.add_child(this._volumeLabel);
        sound.add_child(this._slider);
        sound.add_child(this._mute);
        right.add_child(sound);
        const now = tile(_('NOW PLAYING'));
        this._miniTrack = label(_('No player open'), 'nd-track');
        this._miniTrack.clutter_text.line_wrap = true;
        now.add_child(this._miniTrack);
        now.add_child(iconButton('applications-multimedia-symbolic', _('Open media'), () => this._select('media')));
        right.add_child(now);
        page.add_child(right);
        this._addPage('dashboard', page);
    }

    _addPage(key, page) {
        const scroll = new St.ScrollView({
            style_class: 'nd-page-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            child: page,
        });
        this._root.add_child(scroll);
        this._pages.set(key, scroll);
        this._pageContent.set(key, page);
    }

    _buildMedia() {
        const page = box(true, 'nd-media-page');
        this._artworkBox = box(true, 'nd-artwork-box');
        this._artworkBox.x_align = Clutter.ActorAlign.CENTER;
        this._musicIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 64,
            style_class: 'nd-music-icon'});
        this._musicIcon.y_expand = true;
        this._musicIcon.x_align = Clutter.ActorAlign.CENTER;
        this._musicIcon.y_align = Clutter.ActorAlign.CENTER;
        this._artworkBox.add_child(this._musicIcon);
        page.add_child(this._artworkBox);
        this._track = label(_('Open your music player'), 'nd-track nd-large-track');
        this._track.clutter_text.line_wrap = true;
        this._artist = label(_('Compatible with players that support MPRIS.'), 'nd-muted nd-media-artist');
        this._artist.clutter_text.line_wrap = true;
        page.add_child(this._track);
        page.add_child(this._artist);
        const progress = box(true, 'nd-media-progress');
        progress.x_align = Clutter.ActorAlign.CENTER;
        this._mediaProgress = progress;
        this._positionSlider = new Slider.Slider(0);
        this._positionSlider.accessible_name = _('Track position');
        this._positionSlider.connect('notify::value', () => this._queueSeek());
        this._positionTimes = label('—:—— / —:——', 'nd-muted nd-media-time');
        progress.add_child(this._positionSlider);
        progress.add_child(this._positionTimes);
        page.add_child(progress);
        const controls = box(false, 'nd-media-controls');
        controls.x_align = Clutter.ActorAlign.CENTER;
        this._prev = iconButton('media-skip-backward-symbolic', _('Previous track'),
            () => this._playerCall('Previous'), 'nd-transport', 22, false);
        this._play = iconButton('media-playback-start-symbolic', _('Play or pause'),
            () => this._playerCall('PlayPause'), 'nd-transport nd-play', 22, false);
        this._next = iconButton('media-skip-forward-symbolic', _('Next track'),
            () => this._playerCall('Next'), 'nd-transport', 22, false);
        this._prev.accessible_name = _('Previous track');
        this._play.accessible_name = _('Play or pause');
        this._next.accessible_name = _('Next track');
        for (const b of [this._prev, this._play, this._next]) controls.add_child(b);
        page.add_child(controls);
        this._addPage('media', page);
    }

    _buildPerformance() {
        const page = box(true, 'nd-system-page');
        const row = box(false, 'nd-grid');
        this._systemGrid = row;
        const cpu = tile(_('PROCESSOR'));
        this._cpu = label('—', 'nd-metric nd-cpu-metric');
        cpu.add_child(this._cpu);
        this._cpuHistory = historyChart('nd-chart-cpu');
        clearHistory(this._cpuHistory);
        cpu.add_child(this._cpuHistory.chart);
        cpu.add_child(label(_('History · up to 22 s'), 'nd-muted'));
        const memory = tile(_('RAM'));
        this._memory = label('—', 'nd-metric nd-memory-metric');
        this._memoryDetail = label(_('Calculating…'), 'nd-muted');
        memory.add_child(this._memory);
        this._memoryHistory = historyChart('nd-chart-memory');
        clearHistory(this._memoryHistory);
        memory.add_child(this._memoryHistory.chart);
        memory.add_child(this._memoryDetail);
        const disk = tile(_('DISK · /'));
        this._disk = label('—', 'nd-metric nd-disk-metric');
        this._diskDetail = label(_('Calculating…'), 'nd-muted');
        disk.add_child(this._disk);
        const diskChart = box(false, 'nd-disk-chart');
        this._diskSegments = [];
        for (let i = 0; i < 20; i++) {
            const segment = new St.Widget({style_class: 'nd-disk-segment', width: 6, height: 18,
                y_align: Clutter.ActorAlign.CENTER});
            diskChart.add_child(segment);
            this._diskSegments.push(segment);
        }
        disk.add_child(diskChart);
        disk.add_child(this._diskDetail);
        for (const t of [cpu, memory, disk]) { t.x_expand = true; row.add_child(t); }
        page.add_child(row);
        const networkRow = box(false, 'nd-grid');
        this._networkGrid = networkRow;
        const network = tile(_('NETWORK'));
        this._networkInterface = label(_('Detecting interface…'), 'nd-muted');
        this._download = label('↓ —', 'nd-network-rate');
        this._upload = label('↑ —', 'nd-network-rate');
        network.add_child(this._networkInterface);
        network.add_child(this._download);
        network.add_child(this._upload);
        const ping = tile(_('PING'));
        ping.add_child(label(_('DESTINATION'), 'nd-eyebrow'));
        ping.add_child(label(_('Mush · BR'), 'nd-muted'));
        this._pingValue = label('—', 'nd-metric');
        this._pingDetail = label(_('Waiting for test…'), 'nd-muted');
        ping.add_child(this._pingValue);
        ping.add_child(this._pingDetail);
        for (const t of [network, ping]) { t.x_expand = true; networkRow.add_child(t); }
        page.add_child(networkRow);
        page.add_child(iconButton('computer-symbolic', _('Open System Monitor'),
            () => this._launch('org.gnome.SystemMonitor.desktop')));
        this._addPage('performance', page);
    }

    _loadAppearance() {
        const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'aevum', 'appearance.json']);
        this._appearancePath = path;
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (ok) {
                const saved = JSON.parse(new TextDecoder().decode(bytes));
                const result = {...DEFAULT_APPEARANCE};
                if (['auto', 'light', 'dark', 'custom'].includes(saved.mode)) result.mode = saved.mode;
                for (const key of ['background', 'surface', 'accent', 'text'])
                    if (validColor(saved[key])) result[key] = saved[key].toLowerCase();
                return result;
            }
        } catch (e) {
            if (!(e instanceof GLib.Error)) console.warn(`Aevum: appearance: ${e.message}`);
        }
        return {...DEFAULT_APPEARANCE};
    }

    _saveAppearance() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._appearancePath), 0o700);
            GLib.file_set_contents(this._appearancePath, JSON.stringify(this._appearance));
            return true;
        } catch (e) {
            this._showNotice(_('Could not save appearance: %s').replace('%s', e.message));
            return false;
        }
    }

    _showNotice(message) {
        if (!this._notice) return;
        this._notice.text = message;
        this._notice.show();
    }

    _buildAppearance() {
        const page = box(true, 'nd-appearance-page');
        page.add_child(label(_('PANEL APPEARANCE'), 'nd-eyebrow'));
        const description = label(_('Automatic mode follows GNOME’s light or dark mode and accent color.'), 'nd-muted');
        description.clutter_text.line_wrap = true;
        page.add_child(description);
        const modes = box(false, 'nd-appearance-options');
        this._appearanceModes = modes;
        this._modeButtons = new Map();
        for (const [key, title] of [['auto', _('Automatic')], ['dark', _('Creator’s theme')], ['light', _('Light')], ['custom', _('Custom')]]) {
            const choice = button(title, () => this._setMode(key), 'nd-choice');
            choice.x_expand = true;
            this._modeButtons.set(key, choice);
            modes.add_child(choice);
        }
        page.add_child(modes);
        page.add_child(label(_('ACCENT COLORS'), 'nd-eyebrow'));
        const swatches = box(false, 'nd-swatches');
        for (const [name, color] of Object.entries(ACCENTS)) {
            const swatch = button('●', () => this._chooseAccent(color), 'nd-swatch');
            swatch.accessible_name = _('%s color').replace('%s', {
                blue: _('blue'), teal: _('teal'), green: _('green'), yellow: _('yellow'),
                orange: _('orange'), red: _('red'), pink: _('pink'), purple: _('purple'),
                slate: _('slate blue'),
            }[name]);
            swatch.set_style(`color: ${color};`);
            swatches.add_child(swatch);
        }
        page.add_child(swatches);
        page.add_child(label(_('CUSTOM COLORS · HEXADECIMAL'), 'nd-eyebrow'));
        const fields = box(false, 'nd-color-fields');
        this._appearanceFields = fields;
        this._colorEntries = new Map();
        for (const [key, title] of [['background', _('Background')], ['surface', _('Cards')], ['accent', _('Accent')], ['text', _('Text')]]) {
            const column = box(true, 'nd-color-field');
            column.x_expand = true;
            column.add_child(label(title, 'nd-muted'));
            const entry = new St.Entry({style_class: 'nd-color-entry', text: this._appearance[key],
                hint_text: '#RRGGBB', can_focus: true});
            entry.clutter_text.connect('activate', () => this._saveCustomColors());
            this._colorEntries.set(key, entry);
            column.add_child(entry);
            fields.add_child(column);
        }
        page.add_child(fields);
        page.add_child(button(_('Apply colors'), () => this._saveCustomColors(), 'nd-button nd-apply'));
        this._appearanceHint = label('', 'nd-muted');
        this._appearanceHint.clutter_text.line_wrap = true;
        page.add_child(this._appearanceHint);
        this._addPage('appearance', page);
        this._syncAppearanceUi();
    }

    _syncAppearanceUi() {
        for (const [key, choice] of this._modeButtons ?? []) {
            if (key === this._appearance.mode) choice.add_style_class_name('nd-choice-active');
            else choice.remove_style_class_name('nd-choice-active');
        }
        if (this._appearanceHint)
            this._appearanceHint.text = this._appearance.mode === 'auto'
                ? _('Follows changes to GNOME appearance settings.')
                : this._appearance.mode === 'custom' ? _('Custom colors are active.')
                    : _('Fixed theme with GNOME’s accent color.');
    }

    _setMode(mode) {
        this._appearance.mode = mode;
        this._saveAppearance();
        this._applyTheme();
    }

    _chooseAccent(color) {
        if (this._appearance.mode !== 'custom') {
            const palette = this._palette();
            for (const key of ['background', 'surface', 'text']) this._appearance[key] = palette[key];
        }
        this._appearance.mode = 'custom';
        this._appearance.accent = color;
        for (const [key, entry] of this._colorEntries) entry.text = this._appearance[key];
        this._saveAppearance();
        this._applyTheme();
    }

    _saveCustomColors() {
        const colors = {};
        for (const [key, entry] of this._colorEntries) {
            const value = entry.text.trim();
            if (!validColor(value)) {
                const colorName = {background: _('Background'), surface: _('Cards'),
                    accent: _('Accent'), text: _('Text')}[key];
                this._showNotice(_('Invalid color for %s: use #RRGGBB.').replace('%s', colorName));
                entry.grab_key_focus();
                return;
            }
            colors[key] = value.toLowerCase();
        }
        Object.assign(this._appearance, colors, {mode: 'custom'});
        const saved = this._saveAppearance();
        this._applyTheme();
        if (saved) this._notice.hide();
    }

    _palette() {
        if (this._appearance.mode === 'custom') return {...this._appearance};
        const dark = this._appearance.mode === 'dark' ||
            (this._appearance.mode === 'auto' && this._interface.get_string('color-scheme') === 'prefer-dark');
        const accent = ACCENTS[this._interface.get_string('accent-color')] ?? ACCENTS.blue;
        if (this._appearance.mode === 'auto')
            return dark
                ? {background: '#36363a', surface: '#48484b', text: '#fdfdfd', accent}
                : {background: '#f6f5f4', surface: '#ffffff', text: '#2e3436', accent};
        return dark
            ? {background: '#171c1d', surface: '#252c2d', text: '#e1e8e6', accent: mix(accent, '#ffffff', 0.25)}
            : {background: '#edf1f2', surface: '#ffffff', text: '#1b292d', accent: mix(accent, '#111b20', 0.12)};
    }

    _themeCss() {
        const {background, surface, text: foreground, accent} = this._palette();
        const isLight = lightness(surface) > 0.45;
        const systemDark = this._appearance.mode === 'auto' && !isLight;
        const border = mix(surface, foreground, isLight ? 0.17 : 0.12);
        const muted = mix(foreground, surface, isLight ? 0.34 : 0.29);
        const action = systemDark ? surface : mix(surface, accent, isLight ? 0.12 : 0.18);
        const hover = systemDark ? mix(surface, foreground, 0.1) : mix(surface, accent, isLight ? 0.22 : 0.32);
        const calendarDay = mix(surface, foreground, 0.06);
        const calendarHover = mix(surface, accent, isLight ? 0.17 : 0.24);
        const notificationCard = isLight ? surface : mix(background, foreground, 0.09);
        const accentText = isLight ? mix(accent, '#111b20', 0.22) : mix(accent, '#ffffff', 0.16);
        const warm = isLight ? '#a45e00' : '#eba851';
        const pink = isLight ? '#a1376f' : '#d986ae';
        return `
.nd-root { color: ${foreground}; background-color: ${background}; border-radius: 16px; }
.nd-menu .popup-menu-content, .nd-menu.popup-menu-content {
    padding: 0; background-color: ${background}; border: 0; box-shadow: none;
}
.nd-menu { color: ${foreground}; }
.nd-root .nd-tabs { background-color: ${background}; }
.nd-root .nd-tab { color: ${muted}; }
.nd-root .nd-tab:hover, .nd-root .nd-tab:focus { background-color: ${hover}; color: ${foreground}; }
.nd-root .nd-tab-active { background-color: ${systemDark ? accent : action}; color: ${systemDark ? readableOn(accent) : accentText}; }
.nd-root .nd-tile, .nd-root .nd-media-page, .nd-root .nd-system-page,
.nd-root .nd-appearance-page { background-color: ${surface}; border-color: ${border}; }
.nd-root .nd-eyebrow, .nd-root .nd-clock, .nd-root .nd-track,
.nd-root .nd-metric, .nd-root .nd-music-icon, .nd-root .calendar-month-label { color: ${accentText}; }
.nd-root .nd-heading { color: ${foreground}; }
.nd-root .nd-muted { color: ${muted}; }
.nd-root .nd-button, .nd-root .nd-transport, .nd-root .nd-choice { background-color: ${action}; color: ${foreground}; }
.nd-root .nd-button:hover, .nd-root .nd-button:focus,
.nd-root .nd-transport:hover, .nd-root .nd-transport:focus,
.nd-root .nd-choice:hover, .nd-root .nd-choice:focus { background-color: ${hover}; color: ${foreground}; }
.nd-root .nd-swatch:hover, .nd-root .nd-swatch:focus { background-color: ${hover}; }
.nd-root .nd-choice-active, .nd-root .nd-play { background-color: ${accent}; color: ${readableOn(accent)}; }
.nd-root .nd-chart-cpu .nd-chart-bar { background-color: ${accent}; }
.nd-root .nd-chart-memory .nd-chart-bar { background-color: ${warm}; }
.nd-root .nd-network-rate { color: ${accentText}; }
.nd-root .nd-disk-segment { background-color: ${border}; }
.nd-root .nd-disk-segment-active { background-color: ${pink}; }
.nd-root .nd-memory-metric { color: ${warm}; }
.nd-root .nd-disk-metric { color: ${pink}; }
.nd-root .nd-notice { color: ${warm}; }
.nd-root .nd-calendar .calendar-day,
.nd-root .nd-calendar .calendar-day-heading { background-color: ${calendarDay}; color: ${foreground}; }
.nd-root .nd-calendar .calendar-day:hover,
.nd-root .nd-calendar .calendar-day:focus { background-color: ${calendarHover}; color: ${foreground}; }
.nd-root .nd-calendar .calendar-day.calendar-weekend,
.nd-root .nd-calendar .calendar-day.calendar-other-month { color: ${muted}; }
.nd-root .nd-calendar .calendar-month-label { color: ${accentText} !important; background-color: ${calendarDay}; }
.nd-root .nd-calendar .pager-button { background-color: ${action}; color: ${foreground}; }
.nd-root .nd-calendar .pager-button:hover { background-color: ${hover}; }
.nd-root .nd-calendar .calendar-day.calendar-today,
.nd-root .nd-calendar .calendar-day.calendar-today:hover,
.nd-root .nd-calendar .calendar-day.calendar-today:focus {
    background-color: ${accent}; color: ${readableOn(accent)} !important;
}
.nd-menu .message-list { border-color: ${border}; }
.nd-menu .message, .nd-menu .events-button,
.nd-menu .world-clocks-button, .nd-menu .weather-button { background-color: ${notificationCard}; color: ${foreground}; }
.nd-menu .message:second-in-stack,
.nd-menu .message:lower-in-stack { background-color: ${notificationCard}; }
.nd-menu .message:hover, .nd-menu .events-button:hover,
.nd-menu .world-clocks-button:hover, .nd-menu .weather-button:hover { background-color: ${calendarHover}; color: ${foreground}; }
.nd-menu .message .message-header,
.nd-menu .events-title, .nd-menu .event-placeholder,
.nd-menu .world-clocks-header, .nd-menu .weather-header,
.nd-menu .message-list-placeholder { color: ${muted}; }
.nd-menu .message .message-header .message-header-content .event-time,
.nd-menu .events-button .events-box .events-title,
.nd-menu .events-button .events-box .events-list .event-placeholder,
.nd-menu .world-clocks-button .world-clocks-header,
.nd-menu .weather-button .weather-box .weather-header-box .weather-header { color: ${muted}; }
.nd-menu .message-list-controls, .nd-menu .datemenu-today-button { color: ${foreground}; }
.nd-menu .datemenu-today-button .date-label { color: ${foreground}; }
.nd-menu .message-notification-group .message-collapse-button,
.nd-menu .message .message-header .message-expand-button,
.nd-menu .message .message-header .message-close-button { background-color: ${action}; color: ${foreground}; }
.nd-menu .message-notification-group .message-collapse-button:hover,
.nd-menu .message .message-header .message-expand-button:hover,
.nd-menu .message .message-header .message-close-button:hover { background-color: ${hover}; color: ${foreground}; }
.nd-menu .datemenu-calendar-column .calendar-day,
.nd-menu .datemenu-calendar-column .calendar-day-heading,
.nd-menu .datemenu-calendar-column .calendar-month-label,
.nd-menu .datemenu-calendar-column .pager-button { background-color: ${calendarDay}; color: ${foreground}; }
.nd-menu .datemenu-calendar-column .calendar-day:hover,
.nd-menu .datemenu-calendar-column .pager-button:hover { background-color: ${calendarHover}; color: ${foreground}; }
.nd-menu .datemenu-calendar-column .calendar-day.calendar-weekend,
.nd-menu .datemenu-calendar-column .calendar-day.calendar-other-month { color: ${muted}; }
.nd-menu .datemenu-calendar-column .calendar-month-label { color: ${foreground} !important; }
.nd-menu .datemenu-calendar-column .calendar-day.calendar-today,
.nd-menu .datemenu-calendar-column .calendar-day.calendar-today:hover {
    background-color: ${accent}; color: ${readableOn(accent)} !important;
}
.nd-root .slider { color: ${accent}; -barlevel-active-background-color: ${accent}; }
.nd-root .nd-color-entry { background-color: ${background}; color: ${foreground}; border-color: ${border}; }
`;
    }

    _applyTheme() {
        if (!this._root) return;
        const theme = this._themeContext.get_theme();
        this._loadedTheme = theme;
        if (this._themeFile) {
            theme.unload_stylesheet(this._themeFile);
            try { this._themeFile.delete(null); } catch (e) { console.debug(`Aevum: ${e.message}`); }
            this._themeFile = null;
        }
        try {
            const directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'aevum']);
            GLib.mkdir_with_parents(directory, 0o700);
            const path = GLib.build_filenamev([directory, `theme-${GLib.get_monotonic_time()}.css`]);
            GLib.file_set_contents(path, this._themeCss());
            const file = Gio.File.new_for_path(path);
            theme.load_stylesheet(file);
            this._themeFile = file;
        } catch (e) {
            console.error(`Aevum: could not apply theme: ${e.message}`);
        }
        this._syncAppearanceUi();
    }

    _select(key) {
        this._activePageKey = key;
        for (const [name, tab] of this._tabs) {
            if (name === key) tab.add_style_class_name('nd-tab-active');
            else tab.remove_style_class_name('nd-tab-active');
        }
        for (const [name, page] of this._pages) page.visible = name === key;
        for (const item of this._original) item.actor.visible = key === 'notifications' && item.visible;
        if (this._notice) this._notice.hide();
        this._updatePageHeight();
        if (key === 'performance' && this._menu.isOpen) this._probePing();
    }

    _updatePageHeight() {
        const page = this._pages?.get(this._activePageKey);
        if (!page) return;
        const monitor = Main.layoutManager.primaryMonitor;
        const maxHeight = Math.max(180, (monitor?.height ?? global.stage.height) - 150);
        const [, naturalHeight] = this._pageContent.get(this._activePageKey)
            .get_preferred_height(this._panelWidth ?? 760);
        page.height = naturalHeight > maxHeight ? maxHeight : -1;
    }

    _updateLayout() {
        if (!this._root) return;
        const width = Main.layoutManager.primaryMonitor?.width ?? global.stage.width;
        const panelWidth = Math.min(760, Math.max(240, width - 48));
        this._panelWidth = panelWidth;
        const compact = panelWidth < 700;
        this._root.set_style(`width: ${panelWidth}px;`);
        if (compact) this._root.add_style_class_name('nd-compact');
        else this._root.remove_style_class_name('nd-compact');
        this._tabsBox.vertical = compact;
        this._tabRows[1].visible = compact;
        let index = 0;
        for (const tab of this._tabs.values()) {
            const row = compact && index >= 3 ? this._tabRows[1] : this._tabRows[0];
            if (tab.get_parent() !== row) {
                tab.get_parent().remove_child(tab);
                row.add_child(tab);
            }
            index++;
        }
        this._dashboardGrid.vertical = compact;
        this._systemGrid.vertical = compact;
        this._networkGrid.vertical = compact;
        this._appearanceModes.vertical = compact;
        this._appearanceFields.vertical = compact;
        for (const column of this._dashboardColumns) {
            column.width = compact ? -1 : 175;
            column.x_expand = compact;
        }
        const artworkWidth = Math.min(300, panelWidth - 48);
        this._artworkBox.width = artworkWidth;
        if (this._artwork) this._artwork.width = artworkWidth;
        this._mediaProgress.width = Math.min(520, panelWidth - (compact ? 60 : 96));
        this._updatePageHeight();
    }

    _launch(id) {
        const app = Gio.DesktopAppInfo.new(id);
        if (app) { app.launch([], global.create_app_launch_context(0, -1)); this._menu.close(); }
        else {
            this._notice.text = _('Application not found: %s. Install it or open its settings from the applications menu.')
                .replace('%s', id.replace('.desktop', ''));
            this._notice.show();
        }
    }

    _unbindSink() {
        if (this._sink) for (const id of this._sinkIds ?? []) this._sink.disconnect(id);
        this._sinkIds = [];
        this._sink = null;
    }

    _bindSink() {
        this._unbindSink();
        this._sink = this._control.get_default_sink();
        if (this._sink) this._sinkIds = [
            this._sink.connect('notify::volume', () => this._syncVolume()),
            this._sink.connect('notify::is-muted', () => this._syncVolume()),
        ];
        this._syncVolume();
    }

    _syncVolume() {
        this._syncingVolume = true;
        try {
            const value = this._sink ? this._sink.volume / this._control.get_vol_max_norm() : 0;
            this._slider.value = Math.min(1, value);
            this._slider.reactive = Boolean(this._sink);
            this._mute.reactive = Boolean(this._sink);
            this._volumeLabel.text = !this._sink ? _('No audio output') : this._sink.is_muted
                ? _('Sound muted') : _('Volume · %s%').replace('%s', Math.round(value * 100));
            this._mute._ndIcon.icon_name = this._sink?.is_muted
                ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
            this._mute._ndLabel.text = this._sink?.is_muted ? _('Unmute') : _('Mute');
            this._mute.accessible_name = this._sink?.is_muted ? _('Unmute') : _('Mute');
        } finally { this._syncingVolume = false; }
    }

    async _refresh() {
        if (!this._alive || this._reading) return;
        const generation = this._generation;
        this._reading = true;
        const now = GLib.DateTime.new_now_local();
        this._clock.text = now.format('%H:%M');
        this._date.text = now.format(_('%a, %B %d'));
        const values = await Promise.all([readText('/proc/stat'), readText('/proc/meminfo'),
            readFilesystem('/'), readText('/proc/net/dev'),
            readText('/proc/net/route')]);
        if (!this._alive || generation !== this._generation) return;
        this._reading = false;
        const [stat, mem, filesystem, netDev, netRoute] = values;
        const raw = stat.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
        if (raw?.length >= 8) {
            const total = raw.slice(0, 8).reduce((a, b) => a + b, 0);
            const idle = raw[3] + raw[4];
            if (this._lastCpu && total > this._lastCpu.total) {
                const percent = Math.round(Math.max(0, Math.min(100,
                    (1 - (idle - this._lastCpu.idle) / (total - this._lastCpu.total)) * 100)));
                this._cpu.text = `${percent}%`;
                pushHistory(this._cpuHistory, percent);
            }
            this._lastCpu = {total, idle};
        }
        const totalMem = Number(mem.match(/^MemTotal:\s+(\d+)/m)?.[1]);
        const available = Number(mem.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
        if (totalMem > 0 && Number.isFinite(available)) {
            const percent = Math.round((1 - available / totalMem) * 100);
            this._memory.text = `${percent}%`;
            this._memoryDetail.text = `${((totalMem - available) / 1048576).toFixed(1)} / ${(totalMem / 1048576).toFixed(1)} GiB`;
            pushHistory(this._memoryHistory, percent);
        }
        if (filesystem?.size > 0 && Number.isFinite(filesystem.free)) {
            const used = Math.max(0, filesystem.size - filesystem.free);
            const percent = Math.max(0, Math.min(100, Math.round(used / filesystem.size * 100)));
            this._disk.text = `${percent}%`;
            this._diskDetail.text = `${(used / 1073741824).toFixed(1)} / ${(filesystem.size / 1073741824).toFixed(1)} GiB`;
            const active = Math.round(percent / 5);
            this._diskSegments.forEach((segment, index) => {
                if (index < active) segment.add_style_class_name('nd-disk-segment-active');
                else segment.remove_style_class_name('nd-disk-segment-active');
            });
        }
        this._refreshNetwork(netDev, netRoute);
        if (this._menu.isOpen && this._activePageKey === 'performance') this._probePing();
    }

    _refreshNetwork(netDev, netRoute) {
        const interfaces = new Map();
        for (const line of netDev.split('\n')) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const name = line.slice(0, colon).trim();
            const values = line.slice(colon + 1).trim().split(/\s+/);
            if (name !== 'lo' && values.length >= 16)
                interfaces.set(name, {rx: Number(values[0]), tx: Number(values[8])});
        }
        const route = netRoute.split('\n').slice(1).map(line => line.trim().split(/\s+/))
            .find(fields => fields[1] === '00000000' && (parseInt(fields[3], 16) & 1) && interfaces.has(fields[0]));
        const name = route?.[0] ?? interfaces.keys().next().value;
        const counters = interfaces.get(name);
        this._networkInterface.text = name ? _('Interface: %s').replace('%s', name) : _('No network interface');
        if (!counters || !Number.isFinite(counters.rx) || !Number.isFinite(counters.tx)) {
            this._lastNetwork = null;
            this._download.text = '↓ —';
            this._upload.text = '↑ —';
            return;
        }
        const now = GLib.get_monotonic_time();
        const previous = this._lastNetwork;
        if (previous?.name === name && now > previous.at &&
            counters.rx >= previous.rx && counters.tx >= previous.tx) {
            const seconds = (now - previous.at) / 1000000;
            this._download.text = `↓ ${formatRate((counters.rx - previous.rx) / seconds)}`;
            this._upload.text = `↑ ${formatRate((counters.tx - previous.tx) / seconds)}`;
        } else {
            this._download.text = `↓ ${_('Calculating…')}`;
            this._upload.text = `↑ ${_('Calculating…')}`;
        }
        this._lastNetwork = {name, ...counters, at: now};
    }

    _probePing() {
        const now = GLib.get_monotonic_time();
        if (this._pingRunning || now - (this._pingLastAt ?? 0) < 5000000) return;
        this._pingLastAt = now;
        const server = PING_SERVER;
        const client = new Gio.SocketClient();
        client.set_timeout(3);
        const cancellable = new Gio.Cancellable();
        this._pingCancellable = cancellable;
        this._pingRunning = true;
        const generation = this._generation;
        const session = this._pingSession;
        client.connect_to_host_async(server.host, server.port, cancellable, (source, result) => {
            let latency = null;
            try {
                const connection = source.connect_to_host_finish(result);
                latency = (GLib.get_monotonic_time() - now) / 1000;
                connection.close(null);
            } catch (e) { console.debug(`Aevum: ping: ${e.message}`); }
            if (!this._alive || generation !== this._generation) return;
            if (session !== this._pingSession) return;
            this._pingRunning = false;
            this._pingCancellable = null;
            this._pingValue.text = latency === null ? '—' : `${Math.round(latency)} ms`;
            this._pingDetail.text = latency === null
                ? _('Destination not responding') : _('Game server · TCP 25565');
        });
    }

    _dropPlayer() {
        if (this._player && this._playerId) this._player.disconnect(this._playerId);
        if (this._player && this._playerSignalId) this._player.disconnect(this._playerSignalId);
        if (this._seekTimer) GLib.Source.remove(this._seekTimer);
        this._seekTimer = 0;
        this._seeking = false;
        this._seekRequest = (this._seekRequest ?? 0) + 1;
        this._positionGeneration = (this._positionGeneration ?? 0) + 1;
        this._playerId = 0;
        this._playerSignalId = 0;
        this._player = null;
        this._playerName = null;
        this._trackId = null;
        this._trackTitle = null;
        this._trackLength = 0;
        this._seekGuard = null;
        this._setPosition(0);
        this._artTrackKey = null;
        this._setArtwork('');
    }

    _refreshPosition() {
        if (!this._alive || !this._player || !this._trackLength || !this._menu.isOpen || this._seeking)
            return;
        const generation = ++this._positionGeneration;
        const playerName = this._playerName;
        const trackId = this._trackId;
        Gio.DBus.session.call(playerName, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 1500, null,
            (connection, result) => {
                let position;
                try {
                    const value = connection.call_finish(result).deep_unpack()[0];
                    position = Number(value instanceof GLib.Variant ? value.deep_unpack() : value);
                }
                catch { return; }
                if (!Number.isFinite(position)) return;
                if (!this._alive || generation !== this._positionGeneration ||
                    playerName !== this._playerName || trackId !== this._trackId || this._seeking)
                    return;
                const guard = this._seekGuard;
                if (guard) {
                    if (guard.trackId !== trackId) this._seekGuard = null;
                    else if (Math.abs(position - guard.target) > 2000000 &&
                        GLib.get_monotonic_time() < guard.until) return;
                    else this._seekGuard = null;
                }
                this._setPosition(position);
            });
    }

    _setPosition(position) {
        const clamped = Math.max(0, Math.min(this._trackLength, position));
        this._currentPosition = clamped;
        this._syncingPosition = true;
        try { this._positionSlider.value = this._trackLength ? clamped / this._trackLength : 0; }
        finally { this._syncingPosition = false; }
        this._positionTimes.text = this._trackLength
            ? `${formatDuration(clamped)} / ${formatDuration(this._trackLength)}`
            : '—:—— / —:——';
    }

    _queueSeek() {
        if (this._syncingPosition || !this._trackLength || !this._trackId ||
            !this._player?.get_cached_property('CanSeek')?.deep_unpack()) return;
        this._seeking = true;
        const request = this._seekRequest = (this._seekRequest ?? 0) + 1;
        this._positionGeneration++;
        this._setPosition(this._positionSlider.value * this._trackLength);
        this._seekGuard = {trackId: this._trackId, target: this._currentPosition, until: 0};
        if (this._seekTimer) GLib.Source.remove(this._seekTimer);
        this._seekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._seekTimer = 0;
            const player = this._player;
            const trackId = this._trackId;
            const position = Math.round(Math.max(0, Math.min(this._trackLength - 1, this._currentPosition)));
            player.call('SetPosition', new GLib.Variant('(ox)', [trackId, position]),
                Gio.DBusCallFlags.NONE, 3000, null, (proxy, result) => {
                    let succeeded = true;
                    try { proxy.call_finish(result); }
                    catch (e) {
                        succeeded = false;
                        console.debug(`Aevum: track seek: ${e.message}`);
                    }
                    if (this._player !== player || this._seekRequest !== request) return;
                    this._seeking = false;
                    if (succeeded && this._seekGuard?.trackId === trackId)
                        this._seekGuard.until = GLib.get_monotonic_time() + 3000000;
                    else this._seekGuard = null;
                    this._refreshPosition();
                });
            return GLib.SOURCE_REMOVE;
        });
    }

    _setArtwork(url) {
        if (url === this._artUrl) return;
        this._artUrl = url;
        const generation = ++this._artGeneration;
        this._artCancellable?.cancel();
        this._artCancellable = null;
        this._artwork?.destroy();
        this._artwork = null;
        this._musicIcon?.show();
        if (!url || !/^(https?:\/\/|file:\/\/)/i.test(url)) return;

        const cancellable = new Gio.Cancellable();
        this._artCancellable = cancellable;
        const show = bytes => {
            if (!this._alive || generation !== this._artGeneration) return;
            try {
                if (bytes.length > 8 * 1024 * 1024) return;
                const loader = new GdkPixbuf.PixbufLoader();
                loader.write(bytes);
                loader.close();
                const original = loader.get_pixbuf();
                const scale = Math.min(300 / original.width, 190 / original.height);
                const width = Math.max(1, Math.round(original.width * scale));
                const height = Math.max(1, Math.round(original.height * scale));
                const pixbuf = original.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR);
                const content = new St.ImageContent({preferredWidth: width, preferredHeight: height});
                const context = global.stage.context.get_backend().get_cogl_context();
                const format = pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888;
                content.set_bytes(context, pixbuf.get_pixels(), format, pixbuf.width, pixbuf.height, pixbuf.rowstride);
                this._artwork = new St.Widget({content,
                    width: Math.min(300, (this._panelWidth ?? 760) - 48), height: 190,
                    content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
                    style_class: 'nd-artwork'});
                this._artworkBox.add_child(this._artwork);
                this._musicIcon.hide();
            } catch (e) {
                console.debug(`Aevum: artwork unavailable: ${e.message}`);
            }
        };
        if (url.toLowerCase().startsWith('file://')) {
            const file = Gio.File.new_for_uri(url);
            file.load_contents_async(cancellable, (source, result) => {
                try {
                    const [ok, bytes] = source.load_contents_finish(result);
                    if (ok) show(bytes);
                } catch (e) {
                    if (!cancellable.is_cancelled()) console.debug(`Aevum: ${e.message}`);
                }
            });
        } else {
            this._artSession ??= new Soup.Session();
            let message;
            try { message = Soup.Message.new('GET', url); }
            catch { return; }
            if (!message) return;
            this._artSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (message.status_code === Soup.Status.OK) show(bytes.get_data());
                    } catch (e) {
                        if (!cancellable.is_cancelled()) console.debug(`Aevum: ${e.message}`);
                    }
                });
        }
    }

    _refreshMedia() {
        if (!this._alive) return;
        const generation = ++this._mediaGeneration;
        const lifecycle = this._generation;
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, 3000, null,
            (connection, result) => {
                let names;
                try { [names] = connection.call_finish(result).deep_unpack(); }
                catch { return; }
                if (!this._alive || lifecycle !== this._generation || generation !== this._mediaGeneration) return;
                names = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.')).sort();
                this._availablePlayers = names;
                if (!names.includes(this._selectedPlayerName)) this._selectedPlayerName = names[0] ?? null;
                const selected = this._selectedPlayerName;
                if (this._player && selected === this._playerName) {
                    this._updateMedia();
                    return;
                }
                this._dropPlayer();
                if (!names.length) { this._updateMedia(); return; }
                Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                    null, selected, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', null,
                    (_source, res) => {
                        let proxy;
                        try { proxy = Gio.DBusProxy.new_for_bus_finish(res); } catch { return; }
                        if (!this._alive || lifecycle !== this._generation || generation !== this._mediaGeneration) return;
                        this._player = proxy;
                        this._playerName = selected;
                        this._playerId = proxy.connect('g-properties-changed', () => this._updateMedia());
                        this._playerSignalId = proxy.connect('g-signal', (_proxy, _sender, signal, parameters) => {
                            if (signal !== 'Seeked' || this._seeking) return;
                            const position = Number(parameters.deep_unpack()[0]);
                            if (!Number.isFinite(position)) return;
                            this._seekGuard = {trackId: this._trackId, target: position,
                                until: GLib.get_monotonic_time() + 3000000};
                            this._positionGeneration++;
                            this._setPosition(position);
                        });
                        this._updateMedia();
                    });
            });
    }

    _updateMedia() {
        const unpack = value => value instanceof GLib.Variant ? unpack(value.deep_unpack()) : value;
        const metadata = this._player?.get_cached_property('Metadata')?.deep_unpack() ?? {};
        const rawTitle = unpack(metadata['xesam:title']);
        const title = rawTitle || this._trackTitle || (this._player ? _('Player connected') : _('Open your music player'));
        const artists = unpack(metadata['xesam:artist']);
        const trackKey = String(rawTitle || unpack(metadata['mpris:trackid']) || '');
        const trackId = unpack(metadata['mpris:trackid']);
        const rawLength = Number(unpack(metadata['mpris:length']));
        const validTrackId = typeof trackId === 'string' && trackId.startsWith('/') &&
            trackId !== '/org/mpris/MediaPlayer2/TrackList/NoTrack' ? trackId : null;
        // Some players send incomplete Metadata when seeking within a track.
        // The previous duration and ID remain valid until the track changes.
        const sameTitle = Boolean(rawTitle && this._trackTitle && rawTitle === this._trackTitle);
        const trackChanged = Boolean((rawTitle && this._trackTitle && rawTitle !== this._trackTitle) ||
            (validTrackId && validTrackId !== this._trackId && !sameTitle && !this._seeking));
        const nextTrackId = validTrackId || (trackChanged ? null : this._trackId);
        const length = Number.isFinite(rawLength) && rawLength > 0
            ? rawLength : trackChanged ? 0 : this._trackLength;
        const identityChanged = trackChanged;
        const lengthChanged = length !== this._trackLength;
        if (identityChanged) {
            if (this._seekTimer) GLib.Source.remove(this._seekTimer);
            this._seekTimer = 0;
            this._seeking = false;
            this._seekGuard = null;
            this._seekRequest = (this._seekRequest ?? 0) + 1;
            this._positionGeneration = (this._positionGeneration ?? 0) + 1;
        }
        this._trackId = nextTrackId;
        this._trackLength = length;
        if (identityChanged) this._setPosition(0);
        else if (lengthChanged) this._setPosition(this._currentPosition ?? 0);
        if (rawTitle) this._trackTitle = String(rawTitle);
        this._positionSlider.reactive = Boolean(this._trackLength && this._trackId &&
            this._player?.get_cached_property('CanSeek')?.deep_unpack());
        this._positionSlider.can_focus = this._positionSlider.reactive;
        const artUrl = String(unpack(metadata['mpris:artUrl']) || '');
        if (artUrl) {
            this._artTrackKey = trackKey;
            this._setArtwork(artUrl);
        } else if (trackKey && trackKey !== this._artTrackKey) {
            // Some players omit artwork in later updates for the same track.
            this._artTrackKey = trackKey;
            this._setArtwork('');
        }
        this._track.text = String(title);
        this._miniTrack.text = String(title);
        this._artist.text = Array.isArray(artists) ? artists.join(', ') : this._player ? _('MPRIS player connected') : _('No MPRIS player found.');
        const playing = this._player?.get_cached_property('PlaybackStatus')?.deep_unpack() === 'Playing';
        this._play._ndIcon.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        for (const [b, capability] of [[this._play, playing ? 'CanPause' : 'CanPlay'], [this._next, 'CanGoNext'], [this._prev, 'CanGoPrevious']]) {
            b.reactive = Boolean(this._player?.get_cached_property(capability)?.deep_unpack());
            b.can_focus = b.reactive;
            b.opacity = b.reactive ? 255 : 90;
        }
        this._refreshPosition();
    }

    _playerCall(method) {
        this._player?.call(method, null, Gio.DBusCallFlags.NONE, 3000, null,
            (proxy, result) => { try { proxy.call_finish(result); } catch (e) { console.debug(`Aevum: ${e.message}`); } });
    }

    disable() {
        this._alive = false;
        for (const id of this._interfaceIds ?? []) this._interface.disconnect(id);
        this._interfaceIds = [];
        this._interface = null;
        if (this._themeContextId) this._themeContext.disconnect(this._themeContextId);
        this._themeContextId = 0;
        if (this._themeFile) {
            this._themeContext.get_theme().unload_stylesheet(this._themeFile);
            try { this._themeFile.delete(null); } catch (e) { console.debug(`Aevum: ${e.message}`); }
            this._themeFile = null;
        }
        this._themeContext = null;
        this._loadedTheme = null;
        this._generation = (this._generation ?? 0) + 1;
        this._mediaGeneration++;
        this._artGeneration++;
        this._artCancellable?.cancel();
        this._artCancellable = null;
        this._pingCancellable?.cancel();
        this._pingCancellable = null;
        this._artSession?.abort();
        this._artSession = null;
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = 0;
        if (this._monitorsId) Main.layoutManager.disconnect(this._monitorsId);
        this._monitorsId = 0;
        if (this._openId) this._menu.disconnect(this._openId);
        this._openId = 0;
        if (this._nameId) Gio.DBus.session.signal_unsubscribe(this._nameId);
        this._nameId = 0;
        this._dropPlayer();
        this._unbindSink();
        for (const id of this._controlIds ?? []) this._control.disconnect(id);
        this._controlIds = [];
        this._control = null;
        this._root?.destroy();
        this._root = null;
        this._menu?.actor.remove_style_class_name('nd-menu');
        this._eventSource?.destroy();
        this._eventSource = null;
        for (const item of this._original ?? []) item.actor.visible = item.visible;
        this._original = [];
        this._lastCpu = null;
        this._lastNetwork = null;
        this._pingRunning = false;
        this._pingLastAt = 0;
        this._cpuHistory = null;
        this._memoryHistory = null;
        this._diskSegments = null;
        this._availablePlayers = null;
        this._selectedPlayerName = null;
        this._reading = false;
        this._pages?.clear();
        this._pageContent?.clear();
        this._tabs?.clear();
        this._modeButtons?.clear();
        this._colorEntries?.clear();
        this._dateMenu = null;
        this._menu = null;
        for (const key of ['_calendar', '_clock', '_date', '_volumeLabel', '_slider', '_mute', '_miniTrack', '_track', '_artist', '_prev', '_play', '_next', '_artworkBox', '_musicIcon', '_artwork', '_cpu', '_memory', '_memoryDetail', '_disk', '_diskDetail', '_networkGrid', '_networkInterface', '_download', '_upload', '_pingValue', '_pingDetail', '_notice', '_appearanceHint', '_mediaProgress', '_positionSlider', '_positionTimes', '_tabsBox', '_tabRows', '_dashboardGrid', '_dashboardColumns', '_systemGrid', '_appearanceModes', '_appearanceFields']) this[key] = null;
    }
}
