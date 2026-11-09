// Pure layout data (no gi imports) for the "Touch" style: a compact touch keyboard in
// the spirit of the Windows 11 touch keyboard (own design, no copied assets).
//
//   abc    4 rows, big letter keys; digits as hints on the top row (swipe up / long press)
//   sym    "&123": symbols on the left, number pad on the right, arrow keys
//   sym2   more symbols + navigation block (Pos1/Ende/Bild/Einfg/Entf)
//   sym3   F1–F12, media/brightness keys, system keys
//   emoji  emoji panel: categories in the bottom row, pages of 3 x 12
//
// Docked rows are TOUCH_TOTAL_UNITS wide. The split variants (thumb mode) use the same
// grid as the classic split layouts: left 7 u + gap 7 u + right 8.5 u (SPLIT_* in
// layouts.js), so extension.js can lay out the two halves identically.
//
// Extra key fields (in addition to layouts.js):
//   type 'layer'  switches the layer: layer 'abc'|'sym'|'sym2'|'sym3'|'emoji'|'emoji-page';
//                 emojiCat (category index) / pageStep (+1 / -1)
//   alts          long press shows these alternatives in a popup (slide + release picks)
//   upChar        swipe up on the key types this (shown as a small hint top-right)
//   ctrlHint      short text shown on the key while Strg is active (Kopieren, Einfügen …)
//   cursorSpace   space bar: horizontal drag moves the text cursor
//   emoji         emoji key (no bold, no repeat)
//   pageLabel     page indicator key of the symbol layers

export const TOUCH_TOTAL_UNITS = 14.25;
// Thumb mode in the touch style: the halves are 75 % as wide as in the classic split
// (same 7 u + 8.5 u halves, narrower keys), so the grid is 22.5 / 0.75 = 30 u and the
// free middle grows to 14.5 u.
// The two inner letter columns appear on both halves (left Q…Z, right T…P), so the halves
// are 8 u and 9.5 u and the free middle is 12.5 u.
export const TOUCH_SPLIT_TOTAL_UNITS = 30;
export const TOUCH_SPLIT_LEFT_UNITS = 8;
export const TOUCH_SPLIT_GAP_UNITS = 12.5;
const SPLIT_GAP_UNITS = TOUCH_SPLIT_GAP_UNITS;

// ---------------------------------------------------------------- alternatives

const ALTS = {
    a: 'äáàâãåæā', e: 'éèêë€ē', i: 'íìîïī', o: 'öóòôõøœō', u: 'üúùûū', s: 'ßśš',
    c: 'çćč', n: 'ñń', y: 'ýÿ', z: 'žźż', l: 'ł', d: 'ð', t: 'þ', g: 'ğ', r: 'ř',
    'ä': 'æ', 'ö': 'øœ',
    ',': ';\'"', '.': '…:!?', '-': '_–—', '?': '¿!¡', '\'': '"‚‘’„“”',
    '$': '€£¥¢', '"': '„“”«»', '!': '¡', '%': '‰', '*': '•×', '/': '÷', '=': '≠≈',
    '<': '≤«', '>': '≥»', '+': '±', '1': '¹½¼', '2': '²', '3': '³¾', '0': '°',
    '(': '[{', ')': ']}', '&': '§', '#': '№', '@': '©®',
};

const CTRL_HINTS = {
    a: 'Alles', c: 'Kopieren', v: 'Einfügen', x: 'Ausschn.', z: 'Rückg.', y: 'Wiederh.',
    s: 'Speich.', f: 'Suchen',
};

// ---------------------------------------------------------------- helpers

function isLetter(c) {
    return c.length === 1 && c.toLowerCase() !== c.toUpperCase();
}

function ch(char, opts = {}) {
    const letter = isLetter(char);
    const key = {
        id: opts.id ?? `c_${char}`, w: opts.w ?? 1, type: 'char', char,
        label: char, repeat: !ALTS[char],
    };
    if (letter) {
        key.letter = true;
        key.shiftChar = char.toUpperCase();
        key.label = char; // case follows Shift/Caps in the touch style
    } else if (opts.shift) {
        key.shiftChar = opts.shift;
        key.shiftLabel = opts.shift;
    }
    if (ALTS[char])
        key.alts = [...ALTS[char]];
    if (opts.up) {
        key.upChar = opts.up;
        key.alts = [opts.up, ...key.alts ?? []];
        key.repeat = false;
    }
    if (letter && CTRL_HINTS[char])
        key.ctrlHint = CTRL_HINTS[char];
    return key;
}

function sp(id, label, keysym, w = 1, extra = {}) {
    return {id, w, type: 'special', label, keysym, special: true, ...extra};
}

function ic(id, icon, keysym, w = 1, extra = {}) {
    return {id, w, type: 'special', icon, keysym, special: true, ...extra};
}

function mod(id, label, modifier, w = 1, extra = {}) {
    return {id, w, type: 'modifier', label, modifier, special: true, ...extra};
}

function layerKey(id, label, layer, w = 1, extra = {}) {
    return {id, w, type: 'layer', label, layer, special: true, ...extra};
}

function gap(w = SPLIT_GAP_UNITS) {
    return {id: 'split-gap', type: 'gap', w};
}

function pad(w) {
    // small indent inside a row (not a split gap)
    return {id: 'pad', type: 'gap', w, pad: true};
}

const backspace = w => sp('BackSpace', '⌫', 'BackSpace', w, {repeat: true});
const enter = w => ({id: 'Return', w, type: 'enter', keysym: 'Return', label: '↵', special: true});
const tab = w => sp('Tab', '⇥', 'Tab', w);
const esc = w => sp('Escape', 'Esc', 'Escape', w);
const shift = (id, w) => mod(id, '⇧', 'shift', w);
const ctrl = w => mod('Ctrl', 'Strg', 'ctrl', w);
const hide = w => ({id: 'Hide', w, type: 'hide', icon: 'keyboard-hide-symbolic', special: true});
const emojiKey = w => layerKey('EmojiLayer', '☺', 'emoji', w);
// Opens the settings panel (the touch style has no Fn key for Fn+Space).
const settingsKey = w => ({id: 'Settings', w, type: 'special', icon: 'emblem-system-symbolic', special: true,
    action: 'settings'});
const left = () => sp('Left', '←', 'Left', 1, {repeat: true});
const right = () => sp('Right', '→', 'Right', 1, {repeat: true});
const up = () => sp('Up', '↑', 'Up', 1, {repeat: true});
const down = () => sp('Down', '↓', 'Down', 1, {repeat: true});

function space(id, w) {
    return {id, w, type: 'char', char: ' ', shiftChar: ' ', label: '', repeat: true, space: true,
        cursorSpace: true};
}

const chars = (s, opts) => [...s].map(c => ch(c, opts));

// Top letter row with digit hints 1 … 0 on the first ten keys.
function topRow(letters) {
    const digits = '1234567890';
    return [...letters].map((c, i) => ch(c, i < 10 ? {up: digits[i]} : {}));
}

// ---------------------------------------------------------------- abc

// Row stagger like a real keyboard: A row 0.5 u right of the Q row, Y row another 0.5 u
// (so D sits below between E and R, B below between G and H).
// Angled left Shift (like a mirrored ISO Enter): a stub left of "?" in the A row
// reaches down into the wide lower part. Both parts are one logical key.
function shiftTop(w) {
    return mod('Shift', '', 'shift', w, {joinPart: 'top', joinGroup: 'shift'});
}

function shiftBottom(w) {
    return mod('Shift', '⇧', 'shift', w, {joinPart: 'bottom', joinGroup: 'shift'});
}

const question = (w = 1) => ch('?', {shift: '!', w});

// ↑ above ↓ in one key slot between ← and →.
function upDown() {
    return {id: 'UpDown', w: 1, type: 'stack', parts: [up(), down()]};
}

function abcBottom(split) {
    if (split) {
        return [layerKey('SymLayer', '&123', 'sym', 1.5), ctrl(1.25), emojiKey(1),
            space('space', 4.25), gap(), space('space_r', 4), left(), up(), down(), right(), settingsKey(1.5)];
    }
    // No hide key here: swipe down hides the keyboard. Arrows as an inverted T: ↑ sits in
    // the Shift row above ↓ (see shiftRowTail()).
    return [layerKey('SymLayer', '&123', 'sym', 1.5), ctrl(1.25), emojiKey(1),
        space('space', 6.25), settingsKey(1), left(), down(), {...right(), w: 1.25}];
}

// Right end of the Shift row (docked): ↑ above ↓, then the right Shift.
function shiftRowTail() {
    return [up(), shift('Shift_R', 1.25)];
}

function abcQwertz(split) {
    if (split) {
        // left: Q at 1.25, A at 1.5, Y at 2 (real stagger 0.25 / 0.5); right: T, G, B likewise.
        // The two inner columns are on both halves: left Q…Z / A…H / Y…N, right T…Ü / G…Ä / B…-.
        const top = topRow('qwertzuiopü');
        const topR = topRow('qwertzuiopü');
        return [
            [esc(1.25), ...top.slice(0, 6), pad(0.75), gap(), ...topR.slice(4), backspace(2.5)],
            [question(1.5), ...chars('asdfgh'), pad(0.5), gap(), pad(0.25), ...chars('ghjklöä'), enter(2.25)],
            [shift('Shift', 2), ...chars('yxcvbn'), gap(), pad(0.75), ...chars('bnm,.-'), shift('Shift_R', 2.75)],
            abcBottom(true),
        ];
    }
    return [
        [tab(1), ...topRow('qwertzuiopü'), backspace(2.25)],
        [question(1.5), ...chars('asdfghjklöä'), enter(1.75)],
        [shift('Shift', 2), ...chars('yxcvbnm,.-'), ...shiftRowTail()],
        abcBottom(false),
    ];
}

function abcQwerty(split) {
    if (split) {
        const top = topRow('qwertyuiop');
        const topR = topRow('qwertyuiop');
        return [
            [esc(1.25), ...top.slice(0, 6), pad(0.75), gap(), ...topR.slice(4), ch('-', {shift: '_'}), backspace(2.5)],
            [question(1.5), ...chars('asdfgh'), pad(0.5), gap(), pad(0.25), ...chars('ghjkl'),
                ch(';', {shift: ':'}), ch('\'', {shift: '"'}), enter(2.25)],
            [shift('Shift', 2), ...chars('zxcvbn'), gap(), pad(0.75), ...chars('bnm,.'), ch('/', {shift: '?'}),
                shift('Shift_R', 2.75)],
            abcBottom(true),
        ];
    }
    return [
        [tab(1), ...topRow('qwertyuiop'), ch('-', {shift: '_'}), backspace(2.25)],
        [question(1.5), ...chars('asdfghjkl'), ch(';', {shift: ':'}), ch('\'', {shift: '"'}),
            enter(1.75)],
        [shift('Shift', 2), ...chars('zxcvbnm,./'), ...shiftRowTail()],
        abcBottom(false),
    ];
}

// ---------------------------------------------------------------- symbols

function pageKey(n, w) {
    const next = n === 3 ? 'sym' : `sym${n + 1}`;
    return layerKey(`Page${n}`, `${n}/3`, next, w, {pageLabel: true});
}

function abcKey(w) {
    return layerKey('AbcLayer', 'abc', 'abc', w);
}

// Number pad block: rows 1–3 = 7 8 9 / 4 5 6 / 1 2 3, row 4 = 0 (2 u) , .
const NUM_ROWS = ['789', '456', '123'];

function bottomSym(split, tailKeys) {
    if (split)
        return [abcKey(1.5), ctrl(1.25), emojiKey(1.25), space('space', 3), gap(), ...tailKeys];
    return [abcKey(1.5), ctrl(1.25), emojiKey(1), space('space', 2.25), ...tailKeys];
}

function sym1(split) {
    if (split) {
        return [
            [esc(2), ...chars('!@#$%'), gap(), ...chars('&()'), ...chars(NUM_ROWS[0]), backspace(2.5)],
            [tab(2), ...chars('"\'/\\-'), gap(), ...chars('_=+'), ...chars(NUM_ROWS[1]), enter(2.5)],
            [pageKey(1, 2), ...chars('*€:;<'), gap(), ...chars('>?~'), ...chars(NUM_ROWS[2]), hide(2.5)],
            bottomSym(true, [left(), right(), ch(','), ch('0', {w: 2}), ch('.'), space('space_r', 2.5)]),
        ];
    }
    return [
        [tab(1), ...chars('!@#$%&()'), ...chars(NUM_ROWS[0]), backspace(2.25)],
        [esc(1), ...chars('"\'/\\-_=+'), ...chars(NUM_ROWS[1]), enter(2.25)],
        [pageKey(1, 1), ...chars('*€:;<>'), up(), ch('?'), ...chars(NUM_ROWS[2]), hide(2.25)],
        bottomSym(false, [left(), down(), right(), ch('0', {w: 2}), ch(','), ch('.', {w: 2.25})]),
    ];
}

const POS1 = () => sp('Home', 'Pos1', 'Home', 1, {repeat: true});
const ENDE = () => sp('End', 'Ende', 'End', 1, {repeat: true});
const PGUP = () => sp('Prior', 'Bild↑', 'Prior', 1, {repeat: true});
const PGDN = () => sp('Next', 'Bild↓', 'Next', 1, {repeat: true});
const INS = () => sp('Insert', 'Einfg', 'Insert', 1);
const DEL = () => sp('Delete', 'Entf', 'Delete', 1, {repeat: true});
const alt = w => mod('Alt', 'Alt', 'alt', w);
const sup = w => mod('Super', '◆', 'super', w);

function sym2(split) {
    if (split) {
        return [
            [esc(2), ...chars('[]{}^'), gap(), ...chars('°~`'), POS1(), PGUP(), INS(), backspace(2.5)],
            [tab(2), ...chars('|´§µ²'), gap(), ...chars('³£¥'), ENDE(), PGDN(), DEL(), enter(2.5)],
            [pageKey(2, 2), ...chars('«»„“”'), gap(), ...chars('…¬–'), ch('·'), up(), ch('—'), hide(2.5)],
            bottomSym(true, [alt(1), sup(1), sp('Print', 'Druck', 'Print'), left(), down(), right(),
                space('space_r', 2.5)]),
        ];
    }
    return [
        [tab(1), ...chars('[]{}^°~`'), POS1(), PGUP(), INS(), backspace(2.25)],
        [esc(1), ...chars('|´§µ²³£¥'), ENDE(), PGDN(), DEL(), enter(2.25)],
        [pageKey(2, 1), ...chars('«»„“”…'), up(), ch('¬'), ...chars('–—·'), hide(2.25)],
        bottomSym(false, [left(), down(), right(), alt(1.5), sup(1.5), sp('Print', 'Druck', 'Print', 2.25)]),
    ];
}

function fkeys(from, to) {
    const keys = [];
    for (let i = from; i <= to; i++)
        keys.push(sp(`F${i}`, `F${i}`, `F${i}`));
    return keys;
}

const MEDIA = {
    mute: () => ic('AudioMute', 'audio-volume-muted-symbolic', 'AudioMute'),
    voldown: () => ic('AudioLowerVolume', 'audio-volume-low-symbolic', 'AudioLowerVolume', 1, {repeat: true}),
    volup: () => ic('AudioRaiseVolume', 'audio-volume-high-symbolic', 'AudioRaiseVolume', 1, {repeat: true}),
    mic: () => ic('AudioMicMute', 'microphone-sensitivity-muted-symbolic', 'AudioMicMute'),
    briDown: () => ic('MonBrightnessDown', 'display-brightness-symbolic', 'MonBrightnessDown', 1,
        {repeat: true, fnLabel: '−'}),
    briUp: () => ic('MonBrightnessUp', 'display-brightness-symbolic', 'MonBrightnessUp', 1,
        {repeat: true, fnLabel: '+'}),
    display: () => ic('Display', 'video-display-symbolic', 'Display'),
    prev: () => ic('AudioPrev', 'media-skip-backward-symbolic', 'AudioPrev'),
    play: () => ic('AudioPlay', 'media-playback-start-symbolic', 'AudioPlay'),
    next: () => ic('AudioNext', 'media-skip-forward-symbolic', 'AudioNext'),
    wlan: () => ic('WLAN', 'network-wireless-symbolic', 'WLAN'),
    bt: () => ic('Bluetooth', 'bluetooth-active-symbolic', 'Bluetooth'),
    tools: () => ic('Tools', 'emblem-system-symbolic', 'Tools'),
};

function sym3(split) {
    const m = MEDIA;
    if (split) {
        return [
            [esc(2), ...fkeys(1, 5), gap(), ...fkeys(6, 8), m.mute(), m.voldown(), m.volup(), backspace(2.5)],
            [tab(2), ...fkeys(9, 12), m.mic(), gap(), m.briDown(), m.briUp(), m.display(), m.prev(), m.play(),
                m.next(), enter(2.5)],
            [pageKey(3, 2), sp('Menu', 'Menü', 'Menu'), sp('Pause', 'Pause', 'Pause'),
                sp('Scroll_Lock', 'Rollen', 'Scroll_Lock'), m.wlan(), m.bt(), gap(),
                m.tools(), POS1(), ENDE(), INS(), up(), DEL(), hide(2.5)],
            bottomSym(true, [alt(1), sup(1), sp('Print', 'Druck', 'Print'), left(), down(), right(),
                space('space_r', 2.5)]),
        ];
    }
    return [
        [esc(1), ...fkeys(1, 8), m.mute(), m.voldown(), m.volup(), backspace(2.25)],
        [tab(1), ...fkeys(9, 12), m.mic(), m.briDown(), m.briUp(), m.display(), m.prev(), m.play(), m.next(),
            enter(2.25)],
        [pageKey(3, 1), sp('Menu', 'Menü', 'Menu'), sp('Print', 'Druck', 'Print'), sp('Pause', 'Pause', 'Pause'),
            sp('Scroll_Lock', 'Rollen', 'Scroll_Lock'), m.wlan(), m.bt(), up(), m.tools(),
            POS1(), ENDE(), INS(), hide(2.25)],
        bottomSym(false, [left(), down(), right(), alt(2.25), sup(3)]),
    ];
}

// ---------------------------------------------------------------- emoji

export const EMOJI_CATEGORIES = [
    ['🕘', 'Zuletzt', ''], // filled at runtime from the recently used list
    ['😀', 'Smileys',
        '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀💩🤡👻👽🤖'],
    ['👍', 'Gesten',
        '👋🤚🖐✋🖖👌🤌🤏✌🤞🤟🤘🤙👈👉👆👇☝👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍💅💪🦾👀👁👅👄💋🧠🫶👶🧒👦👧🧑👱👨🧔👩🧓👴👵🙋🙆🙅🤷🤦💁🙇'],
    ['❤', 'Symbole',
        '❤🧡💛💚💙💜🖤🤍🤎💔❣💕💞💓💗💖💘💝✨⭐🌟💫🔥💥💯✅❌❎➕➖➗✖❓❗⁉‼⚠🚫⛔🔞📵🔴🟠🟡🟢🔵🟣⚫⚪🔶🔷🔺🔻💬💭🗯♻🆗🆕🆒🆓🔝🔜🎵🎶➡⬅⬆⬇↔↕🔄🔃'],
    ['🐱', 'Natur',
        '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐔🐧🐦🐤🦆🦅🦉🐺🐗🐴🦄🐝🐛🦋🐌🐞🐢🐍🐙🦀🐠🐟🐬🐳🦈🐊🐘🦒🐄🐑🐈🐕🌵🎄🌲🌳🌴🌱🌿🍀🍁🍂🌷🌹🌺🌸🌼🌻☀🌤⛅🌧⛈🌩❄☃🌈🌊'],
    ['🍕', 'Essen',
        '🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍒🍑🥭🍍🥥🥝🍅🥑🥦🥒🌶🌽🥕🥔🥐🥖🥨🧀🥚🍳🥞🥓🥩🍗🍔🍟🍕🌭🥪🌮🌯🥗🍝🍜🍣🍱🍤🍦🍰🎂🍫🍬🍭🍩🍪☕🍵🥤🍺🍻🥂🍷🥃🍸🍹🍾🧊'],
    ['⚽', 'Aktivität',
        '⚽🏀🏈⚾🎾🏐🏉🎱🏓🏸🏒⛳🏹🎣🥊🥋⛸🎿🏂🏋🤸🚴🏊🧘🏆🥇🥈🥉🏅🎖🎗🎫🎟🎪🎭🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🎻🎲♟🎯🎳🎮🧩🎉🎊🎈🎁🎀'],
    ['🚗', 'Reisen',
        '🚗🚕🚙🚌🚎🏎🚓🚑🚒🚐🚚🚛🚜🛵🏍🚲🛴🚨🚔🚍🚘🚖✈🛫🛬🚀🛸🚁⛵🚤🛳🚢🚂🚆🚇🚉🚊⚓⛽🚦🗺🗽🗼🏰🏯🏟🎡🎢⛲🏖🏝🏔⛰🌋🏕🏠🏡🏢🏥🏦🏨🏪🏫⛪🕌🌃🌆🌅🌄🌉'],
    ['💡', 'Objekte',
        '⌚📱💻⌨🖥🖨🖱💾💿📷📸📹🎥📞☎📺📻🎙⏰⏳📡🔋🔌💡🔦🕯💸💵💶💳💎⚖🔧🔨⚒🛠🔩⚙🔫💣🔪🛡🚬💊💉🩹🧬🔬🔭🧹🧺🧻🚽🚿🛁🔑🗝🚪🛋🛏🧸🖼🛍🛒🎁✉📩📨📦📝📁📂📅📌📎✂🔒🔓'],
];

const EMOJI_PER_ROW = 12;
const EMOJI_ROWS = 3;
export const EMOJI_PER_PAGE = EMOJI_PER_ROW * EMOJI_ROWS;

/** Emoji of category `cat` as an array of strings (grapheme-ish: splits by code point, keeps VS16/ZWJ). */
export function emojiList(cat, recent = []) {
    if (cat === 0)
        return recent.slice(0, EMOJI_PER_PAGE * 2);
    const s = EMOJI_CATEGORIES[cat]?.[2] ?? '';
    const out = [];
    for (const c of s) {
        const cp = c.codePointAt(0);
        // variation selector / ZWJ / skin tone modifiers stay with the previous emoji
        if (out.length && (cp === 0xFE0F || cp === 0x200D || (cp >= 0x1F3FB && cp <= 0x1F3FF) ||
            out[out.length - 1].endsWith('‍')))
            out[out.length - 1] += c;
        else
            out.push(c);
    }
    return out;
}

export function emojiPageCount(cat, recent = []) {
    return Math.max(1, Math.ceil(emojiList(cat, recent).length / EMOJI_PER_PAGE));
}

function emojiCell(e, i) {
    if (!e)
        return {id: `emoji-empty-${i}`, w: 1, type: 'gap', pad: true};
    return {id: `emoji-${i}`, w: 1, type: 'char', char: e, shiftChar: e, label: e, emoji: true};
}

function emojiRows(cat, page, recent, split) {
    const list = emojiList(cat, recent);
    const start = page * EMOJI_PER_PAGE;
    const cells = [];
    for (let i = 0; i < EMOJI_PER_PAGE; i++)
        cells.push(emojiCell(list[start + i], i));
    const pages = emojiPageCount(cat, recent);
    const catKeys = EMOJI_CATEGORIES.map(([icon, name], i) =>
        layerKey(`EmojiCat${i}`, icon, 'emoji', 1, {emojiCat: i, emojiCatName: name, emojiCatKey: true}));
    const prev = layerKey('EmojiPrev', '‹', 'emoji-page', 1, {pageStep: -1, disabled: page <= 0});
    const next = layerKey('EmojiNext', '›', 'emoji-page', 1, {pageStep: +1, disabled: page >= pages - 1});
    const row = r => cells.slice(r * EMOJI_PER_ROW, (r + 1) * EMOJI_PER_ROW);
    if (split) {
        // left 7 = 6 emoji + 1 (Esc/Tab/abc-ish), right 8.5 = 6 emoji + 2.5
        const r = [0, 1, 2].map(row);
        return [
            [...r[0].slice(0, 6), pad(1), gap(), ...r[0].slice(6), backspace(2.5)],
            [...r[1].slice(0, 6), pad(1), gap(), ...r[1].slice(6), enter(2.5)],
            [...r[2].slice(0, 6), pad(1), gap(), ...r[2].slice(6), hide(2.5)],
            [abcKey(1.5), ...catKeys.slice(0, 5), pad(0.5), gap(), ...catKeys.slice(5), prev, next,
                space('space_r', 2.5)],
        ];
    }
    return [
        [...row(0), backspace(2.25)],
        [...row(1), enter(2.25)],
        [...row(2), hide(2.25)],
        [abcKey(1.5), ...catKeys, space('space', 1.75), prev, next],
    ];
}

// ---------------------------------------------------------------- mini ("T")

// Small square floating panel:   ↑    F11
//                                ↓    ⚙
//                                Strg Alt ⇧ R   (Strg+Alt+Shift(left)+R as one key)
export const MINI_TOTAL_UNITS = 2;

export function getMiniLayout() {
    return [
        [up(), sp('F11', 'F11', 'F11')],
        [down(), settingsKey(1)],
        [sp('ComboCASR', 'Strg Alt ⇧ R', 'r', 2, {combo: ['Control_L', 'Alt_L', 'Shift_L']})],
    ];
}

// ---------------------------------------------------------------- API

export const TOUCH_LAYERS = ['abc', 'sym', 'sym2', 'sym3', 'emoji'];

/**
 * @param {{layout: 'qwertz'|'qwerty', layer: string, split: boolean,
 *          emojiCat: number, emojiPage: number, recentEmoji: string[]}} opts
 * @returns {Array<Array<object>>} rows (always 4)
 */
export function getTouchLayout({layout = 'qwertz', layer = 'abc', split = false, emojiCat = 1, emojiPage = 0,
    recentEmoji = []} = {}) {
    let rows;
    switch (layer) {
    case 'sym': rows = sym1(split); break;
    case 'sym2': rows = sym2(split); break;
    case 'sym3': rows = sym3(split); break;
    case 'emoji': rows = emojiRows(emojiCat, emojiPage, recentEmoji, split); break;
    default: return layout === 'qwerty' ? abcQwerty(split) : abcQwertz(split);
    }
    return split ? widenSplitHalves(rows) : rows;
}

// The symbol and emoji split layers are designed for 7 u + 8.5 u halves; widen them to the
// 8 u + 9.5 u halves of the letter layer (outer keys +1 u, emoji rows get an inner pad).
function widenSplitHalves(rows) {
    return rows.map(row => {
        const out = [...row];
        const gapIdx = out.findIndex(k => k.id === 'split-gap');
        if (out[0].emoji)
            out.splice(gapIdx, 0, pad(1));
        else
            out[0] = {...out[0], w: out[0].w + 1};
        const last = out.length - 1;
        out[last] = {...out[last], w: out[last].w + 1};
        return out;
    });
}

export function rowUnits(row) {
    return row.reduce((s, k) => s + k.w, 0);
}

/** Uppercase variant of an alternative (keeps ß and multi-letter results unchanged). */
export function upperAlt(s) {
    if (s === 'ß')
        return 'ẞ';
    const u = s.toUpperCase();
    return [...u].length === [...s].length ? u : s;
}
