// Pure layout data (no gi imports) — 15-unit grid per row.
//
// Key fields:
//   id          unique id within a layout
//   w           width in units (row sum = 15)
//   type        'char' | 'special' | 'modifier' | 'hide' | 'enter'
//   label       main label (centre); icon: symbolic icon name instead of label
//   shiftLabel  top-left, altgrLabel bottom-right, fnLabel/fnIcon top-right (accent)
//   char / shiftChar / altgrChar   text committed for 'char' keys
//   letter      true for letters (Caps applies, label follows case)
//   keysym      Clutter keysym name without 'KEY_' prefix (e.g. 'BackSpace', 'AudioMute')
//   fnKeysym    keysym sent while Fn is latched
//   modifier    for type 'modifier': 'shift'|'caps'|'altgr'|'fn'|'ctrl'|'alt'|'super'
//   repeat      auto-repeat on long press
//   enterPart   'top' | 'bottom' for the two halves of the ISO Enter key
//   special     true -> special key style
//   labelPos    'tl' -> main label small, upper-left (ThinkPad style for text specials)
//   fnCentre    F-row: Fn icon drawn large in the centre

export const TOTAL_UNITS = 15;

// Keysyms Clutter does not export as KEY_* constants.
export const FALLBACK_KEYVALS = {
    Keyboard: 0x1008FFB3, // XF86Keyboard
};

// ---------------------------------------------------------------- helpers

function ch(id, char, shiftChar, altgrChar, w = 1) {
    const letter = char.length === 1 && char.toUpperCase().length === 1 && char.toLowerCase() !== char.toUpperCase();
    const key = {id, w, type: 'char', char, label: letter ? char.toUpperCase() : char, repeat: true};
    if (letter) {
        key.letter = true;
        key.shiftChar = shiftChar ?? char.toUpperCase();
    } else if (shiftChar) {
        key.shiftChar = shiftChar;
        key.shiftLabel = shiftChar;
    }
    if (altgrChar) {
        key.altgrChar = altgrChar;
        key.altgrLabel = altgrChar;
    }
    return key;
}

function sp(id, label, keysym, w = 1, extra = {}) {
    return {id, w, type: 'special', label, keysym, special: true, ...extra};
}

function mod(id, label, modifier, w = 1, extra = {}) {
    return {id, w, type: 'modifier', label, modifier, special: true, ...extra};
}

// ---------------------------------------------------------------- shared rows

const F_ICONS = [
    ['AudioMute', 'audio-volume-muted-symbolic'],
    ['AudioLowerVolume', 'audio-volume-low-symbolic'],
    ['AudioRaiseVolume', 'audio-volume-high-symbolic'],
    ['AudioMicMute', 'microphone-sensitivity-muted-symbolic'],
    ['MonBrightnessDown', 'display-brightness-symbolic', '−'],
    ['MonBrightnessUp', 'display-brightness-symbolic', '+'],
    ['Display', 'video-display-symbolic'],
    ['WLAN', 'network-wireless-symbolic'],
    ['Tools', 'emblem-system-symbolic'],
    ['Bluetooth', 'bluetooth-active-symbolic'],
    ['Keyboard', 'input-keyboard-symbolic'],
    ['Favorites', 'starred-symbolic'],
];

function fRow() {
    // Esc 1 + 12 * 0.875 + 4 * 0.875 = 15
    const row = [sp('Escape', 'Esc', 'Escape', 1, {labelPos: 'tl'})];
    for (let i = 1; i <= 12; i++) {
        const [fnKeysym, fnIcon, fnLabel] = F_ICONS[i - 1];
        row.push(sp(`F${i}`, `F${i}`, `F${i}`, 0.875, {fnKeysym, fnIcon, fnLabel, labelPos: 'tl', fnCentre: true}));
    }
    row.push(sp('Home', 'Pos1', 'Home', 0.875, {labelPos: 'tl'}));
    row.push(sp('End', 'Ende', 'End', 0.875, {labelPos: 'tl'}));
    row.push(sp('Insert', 'Einfg', 'Insert', 0.875, {labelPos: 'tl'}));
    row.push(sp('Delete', 'Entf', 'Delete', 0.875, {repeat: true, labelPos: 'tl'}));
    return row;
}

function backspace() {
    return sp('BackSpace', '⟵', 'BackSpace', 2, {repeat: true, fnKeysym: 'Delete', fnLabel: 'Entf'});
}

function tab() {
    return sp('Tab', '⇥', 'Tab', 1.5);
}

function caps() {
    return mod('Caps', '⇪', 'caps', 1.75);
}

function navCluster() {
    return [
        sp('Prior', 'Bild↑', 'Prior', 1, {repeat: true, labelPos: 'tl'}),
        sp('Up', '↑', 'Up', 1, {repeat: true}),
        sp('Next', 'Bild↓', 'Next', 1, {repeat: true, labelPos: 'tl'}),
    ];
}

function bottomRow() {
    // 1 + 1.25 + 1 + 1 + 5.75 + 1 + 1 + 3 = 15
    return [
        mod('Fn', 'Fn', 'fn', 1, {fnStyle: true, labelPos: 'tl'}),
        mod('Ctrl', 'Strg', 'ctrl', 1.25, {labelPos: 'tl'}),
        mod('Super', '◆', 'super', 1),
        mod('Alt', 'Alt', 'alt', 1, {labelPos: 'tl'}),
        // Fn+Space opens the settings panel (gear shown as the Fn label).
        {id: 'space', w: 5.75, type: 'char', char: ' ', shiftChar: ' ', label: '', repeat: true, space: true,
            fnAction: 'settings', fnIcon: 'emblem-system-symbolic'},
        mod('AltGr', 'AltGr', 'altgr', 1, {labelPos: 'tl'}),
        {id: 'Hide', w: 1, type: 'hide', icon: 'keyboard-hide-symbolic', special: true},
        sp('Left', '←', 'Left', 1, {repeat: true, fnKeysym: 'Home', fnLabel: 'Pos1'}),
        sp('Down', '↓', 'Down', 1, {repeat: true}),
        sp('Right', '→', 'Right', 1, {repeat: true, fnKeysym: 'End', fnLabel: 'Ende'}),
    ];
}

// Fn+number row = F1..F12 (compact mode only)
function addFnF(row, startIdx) {
    for (let i = 0; i < 12; i++) {
        const k = row[startIdx + i];
        k.fnKeysym = `F${i + 1}`;
        k.fnLabel = `F${i + 1}`;
    }
}

// ---------------------------------------------------------------- QWERTZ (de)

function qwertz(compact) {
    const r1 = [
        ch('dead_circumflex', '^', '°', null, compact ? 0.5 : 1),
        ch('1', '1', '!'),
        ch('2', '2', '"', '²'),
        ch('3', '3', '§', '³'),
        ch('4', '4', '$'),
        ch('5', '5', '%'),
        ch('6', '6', '&'),
        ch('7', '7', '/', '{'),
        ch('8', '8', '(', '['),
        ch('9', '9', ')', ']'),
        ch('0', '0', '=', '}'),
        ch('ssharp', 'ß', '?', '\\'),
        ch('dead_acute', '´', '`'),
        backspace(),
    ];
    if (compact) {
        r1.unshift(sp('Escape', 'Esc', 'Escape', 0.5, {labelPos: 'tl'}));
        addFnF(r1, 2);
    }

    const r2 = [
        tab(),
        ch('q', 'q', null, '@'), ch('w', 'w'), ch('e', 'e', null, '€'), ch('r', 'r'),
        ch('t', 't'), ch('z', 'z'), ch('u', 'u'), ch('i', 'i'), ch('o', 'o'), ch('p', 'p'),
        ch('udiaeresis', 'ü'),
        ch('plus', '+', '*', '~'),
        {id: 'Return', w: 1.5, type: 'enter', keysym: 'Return', label: '↵', enterPart: 'top', special: true},
    ];
    const r3 = [
        caps(),
        ch('a', 'a'), ch('s', 's'), ch('d', 'd'), ch('f', 'f'), ch('g', 'g'), ch('h', 'h'),
        ch('j', 'j'), ch('k', 'k'), ch('l', 'l'),
        ch('odiaeresis', 'ö'), ch('adiaeresis', 'ä'),
        ch('numbersign', '#', '\''),
        {id: 'Return', w: 1.25, type: 'enter', keysym: 'Return', label: '', enterPart: 'bottom', special: true},
    ];
    const r4 = [
        mod('Shift', '⇧', 'shift', 1),
        ch('less', '<', '>', '|'),
        ch('y', 'y'), ch('x', 'x'), ch('c', 'c'), ch('v', 'v'), ch('b', 'b'), ch('n', 'n'),
        ch('m', 'm', null, 'µ'),
        ch('comma', ',', ';'), ch('period', '.', ':'), ch('minus', '-', '_'),
        ...navCluster(),
    ];
    return [r1, r2, r3, r4, bottomRow()];
}

// ---------------------------------------------------------------- QWERTY (us)

function qwerty(compact) {
    const r1 = [
        ch('grave', '`', '~', null, compact ? 0.5 : 1),
        ch('1', '1', '!'), ch('2', '2', '@'), ch('3', '3', '#'), ch('4', '4', '$'),
        ch('5', '5', '%'), ch('6', '6', '^'), ch('7', '7', '&'), ch('8', '8', '*'),
        ch('9', '9', '('), ch('0', '0', ')'),
        ch('minus', '-', '_'), ch('equal', '=', '+'),
        backspace(),
    ];
    if (compact) {
        r1.unshift(sp('Escape', 'Esc', 'Escape', 0.5, {labelPos: 'tl'}));
        addFnF(r1, 2);
    }
    const r2 = [
        tab(),
        ...'qwertyuiop'.split('').map(c => ch(c, c)),
        ch('bracketleft', '[', '{'), ch('bracketright', ']', '}'),
        ch('backslash', '\\', '|', null, 1.5),
    ];
    const r3 = [
        caps(),
        ...'asdfghjkl'.split('').map(c => ch(c, c)),
        ch('semicolon', ';', ':'), ch('apostrophe', '\'', '"'),
        {id: 'Return', w: 2.25, type: 'enter', keysym: 'Return', label: '↵', special: true},
    ];
    const r4 = [
        mod('Shift', '⇧', 'shift', 2),
        ...'zxcvbnm'.split('').map(c => ch(c, c)),
        ch('comma', ',', '<'), ch('period', '.', '>'), ch('slash', '/', '?'),
        ...navCluster(),
    ];
    return [r1, r2, r3, r4, bottomRow()];
}

// ---------------------------------------------------------------- API

/**
 * @param {{layout: 'qwertz'|'qwerty', fRow: boolean}} opts
 * @returns {Array<Array<object>>} rows of key descriptors (fresh objects every call)
 */
export function getLayout({layout = 'qwertz', fRow: withFRow = true} = {}) {
    const compact = !withFRow;
    const rows = layout === 'qwerty' ? qwerty(compact) : qwertz(compact);
    if (withFRow)
        rows.unshift(fRow());
    return rows;
}

export function rowUnits(row) {
    return row.reduce((s, k) => s + k.w, 0);
}
