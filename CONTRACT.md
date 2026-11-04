# Module contract (integration spec)

Extension dir: `tablet-osk@kruegertim/` — GNOME Shell 46, ESM, gjs 1.80.
Imports: `import St from 'gi://St'`, `import * as Main from 'resource:///org/gnome/shell/ui/main.js'`,
extension API `resource:///org/gnome/shell/extensions/extension.js`, prefs API
`resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`.
Reference copies of the shell's own JS (keyboard.js, layout.js, edgeDragAction.js, panelMenu.js …):
`/tmp/claude-1000/-home-tim/c2826ed9-40d5-50d7-a424-44b8bfc778d9/scratchpad/shelljs/org/gnome/shell/ui/`.

Settings: `schemas/org.gnome.shell.extensions.tablet-osk.gschema.xml`
(keys: layout 'qwertz'|'qwerty', show-f-row b, key-height-mm d, shrink-workarea b, auto-show b,
ignore-physical-keyboard b, show-panel-icon b, swipe-gestures b, fallback-dpi d).

Every module: no side effects at import time; everything created in constructor/enable is torn
down in `destroy()` (disconnect all signals — prefer `connectObject(..., this)` / `disconnectObject(this)`,
remove all GLib sources). No global monkey-patching except where stated.

## A — `layouts.js`, `injector.js`, `keyboard.js`, `stylesheet.css`

`injector.js`
```js
export class KeyInjector {
  constructor()                    // seat.create_virtual_device(KEYBOARD_DEVICE)
  press(keyval) / release(keyval)  // notify_keyval with Clutter.get_current_event_time()*1000
  tap(keyval, modifierKeyvals=[])  // press mods, press+release key, release mods (reverse)
  typeChar(str, modifierKeyvals=[]) // for printable chars: keysym via Clutter.unicode_to_keysym;
                                    // without modifiers and with Main.inputMethod.currentFocus use
                                    // Main.inputMethod.commit(str) so output is layout-independent;
                                    // otherwise notify_keyval (mutter maps keysym -> keycode of current keymap)
  releaseAll()
  destroy()
}
```

`keyboard.js`
```js
export const OskKeyboard = GObject.registerClass({
  Signals: {'hide-request': {}},          // emitted by the "hide keyboard" key
}, class OskKeyboard extends St.BoxLayout { // vertical
  constructor({settings})        // reads layout + show-f-row, rebuilds itself on change
  get handle()                   // St.Widget drag handle bar at the very top (full width, ~18px
                                 // incl. a visible grip pill); module B attaches swipe-down to it
  setKeyHeight(px)               // relayout rows; total height ≈ rows*px + gaps + handle
  get preferredHeight()          // height in px for the current key height & row count
  resetModifiers()               // clear latched modifiers (called on hide)
  destroy()
});
```
Layout spec (15-unit grid, full monitor width, dark keys, red accent #d1281c, labels: main centre,
shift label top-left, AltGr label bottom-right, Fn label in accent colour):
- F-row (if show-f-row): Esc, F1–F12 (Fn: mute, vol-, vol+, mic-mute, bright-, bright+, display,
  wlan, settings, bluetooth, keyboard, favorite → XF86 keysyms), Pos1(Home), Ende(End), Einfg(Insert), Entf(Delete).
- R1: ^ 1 2 3 4 5 6 7 8 9 0 ß ´ Backspace(2u). Compact mode: Esc is placed first in this row
  (shrink ^ accordingly) and Fn+1..´ = F1–F12.
- R2: Tab 1.5, Q W E R T Z U I O P Ü +, ISO-Enter top part 1.5
- R3: Caps 1.75, A S D F G H J K L Ö Ä #, Enter bottom 1.25 (both Enter parts = one logical key, visually joined)
- R4: Shift 1, < Y X C V B N M , . -, Bild↑(Prior), ↑, Bild↓(Next)
- R5: Fn, Strg 1.25, Super, Alt, Space 5.75, AltGr, Hide-key (emits hide-request), ← ↓ →
  (Fn+← = Pos1, Fn+→ = Ende)
- Shift: one-shot, double tap = lock (caps-lock style visual). AltGr/Fn/Strg/Alt/Super: one-shot latch
  (tap = latched for next key, tap again = off). Caps: real Caps_Lock keysym toggle + visual.
- AltGr labels (de): q@ e€ 7{ 8[ 9] 0} ß\ +~ <| 2² 3³ m µ. Output for AltGr/shift chars is
  computed by the OSK (commit the resulting character), not by sending ISO_Level3_Shift.
- QWERTY (us) variant: standard US ANSI keys, row 4 Shift 2u + 10 keys (Z X C V B N M , . /), no <key,
  `-=[]\;'` placement, Enter single key.
- Keys with Strg/Alt/Super latched send real modifier keyvals + keysym (e.g. Ctrl+C).
- Inject keysyms so the output does not depend on the active xkb layout where possible.
- Key repeat on long press for Backspace/arrows/space/chars (delay 500ms, 50ms interval).

## B — `visibility.js`, `indicator.js`, `physicalKeyboard.js`

```js
export class PhysicalKeyboardMonitor {   // physicalKeyboard.js
  constructor(onChanged)                 // onChanged(present:boolean)
  get present()                          // true if an external (USB/Bluetooth) keyboard is connected
  destroy()
}
```
Use `Clutter.get_default_backend().get_default_seat()` `list_devices()`, `device-added`/`device-removed`.
Count KEYBOARD_DEVICE devices that are physical (not virtual: `device.get_device_mode() !== FLOATING`?
check), excluding names matching built-ins: /AT Translated|i8042|Power Button|Sleep Button|Lid Switch|
Video Bus|Extra Buttons|Intel HID|HDA|Consumer Control|System Control|virtual|ydotool|gnome-shell/i,
plus our own virtual device. Mutter exposes device node / vendor / product ids — log the device list
with console.log once so we can tune it. Note: a Logitech USB receiver (mouse) also registers as
keyboard → treat "Logitech USB Receiver" keyboard nodes as external keyboard = present? Document the
decision (we consider any non-builtin keyboard-capable device as external; logging helps tune).

```js
export class PanelIndicator { // indicator.js — PanelMenu.Button with icon 'input-keyboard-symbolic'
  constructor({onToggle, settings}) // click/tap toggles; adds itself to Main.panel status area
                                   // via Main.panel.addToStatusArea(uuid, this); honours show-panel-icon
  setActive(visible)               // highlight while keyboard visible
  destroy()
}

export class VisibilityController { // visibility.js
  constructor({settings, show, hide, isVisible, getHandle, getKeyboardActor, physicalKeyboard})
    // show()/hide(): callbacks into extension.js (they animate). isVisible(): bool.
    // getHandle(): keyboard handle actor for swipe-down. getKeyboardActor(): keyboard container
    // (clicks on it must NOT count as focus loss).
  destroy()
}
```
Auto-show/hide (only when settings auto-show && (!physicalKeyboard.present || ignore-physical-keyboard)):
- Wayland/X11 apps: `Main.inputMethod` signals `'input-panel-state'` (Clutter.InputPanelState.ON/OFF/TOGGLE),
  `'focus-in'`/`'focus-out'`; shell entries: `global.stage` `notify::key-focus` (focus instanceof Clutter.Text
  → show). Debounce (≈100–150ms idle) so focus moves between fields do not flicker; hiding on focus-out
  must be ignored when the focus moved into the keyboard itself.
- Manual show (icon/swipe) must stay visible until manual hide or until a later focus-out after a
  focus-in (pick sensible rule; manual open should not instantly close).
- Swipe up from the bottom screen edge shows (touch via `EdgeDragAction`-like Clutter.GestureAction
  on global.stage CAPTURE phase, **and** mouse: a thin (≈4px) reactive bottom-edge strip actor
  added with Main.layoutManager.addTopChrome that recognises press+drag-up > 40px; strip hidden while
  keyboard visible). Swipe down on the handle (press+drag-down > 40px, touch or mouse) hides; a tap on
  the handle does nothing. Honour swipe-gestures setting.
- Top-bar icon toggles.

## C — `workarea.js`, `prefs.js`

```js
export class MonitorMetrics {          // workarea.js
  constructor(onChanged)               // reads physical size via D-Bus org.gnome.Mutter.DisplayConfig
                                       // GetResources (outputs carry 'width-mm'/'height-mm') async;
                                       // refresh on Main.layoutManager 'monitors-changed'
  pxPerMm(monitorIndex)                // logical px per mm for that monitor (account for monitor
                                       // scale: physical px / mm / scale), fallback settings fallback-dpi/25.4
  keyHeightPx(monitorIndex, mm)        // Math.round(mm * pxPerMm)
  destroy()
}
export class WorkArea {                // manages the keyboard container as layout chrome
  constructor(actor, settings)         // Main.layoutManager.addChrome(actor, {affectsStruts, trackFullscreen:false})
                                       // affectsStruts follows shrink-workarea; must reserve space only while
                                       // shown (verify how layout.js treats hidden actors; if needed re-add chrome
                                       // or toggle struts on setShown)
  setShown(bool)
  destroy()                            // removeChrome
}
```
`prefs.js`: `export default class extends ExtensionPreferences { fillPreferencesWindow(window) }`
Adw page(s): Layout (combo QWERTZ/QWERTY), "Mit F-Reihe" switch (off = Kompakt), key height
(SpinRow mm, 7–20 step 0.5), shrink work area switch, auto-show switch, show panel icon, swipe gestures,
testing group: ignore-physical-keyboard switch. German UI strings.

## Integration — `extension.js` (coordinator)
Creates container (St.Widget) at bottom of primary monitor, OskKeyboard inside, WorkArea, MonitorMetrics,
PhysicalKeyboardMonitor, PanelIndicator, VisibilityController; slide animation; suppresses the built-in
OSK (Main.keyboard) while enabled and restores it on disable.

## Amendment 1 — in-keyboard settings panel + floating mode (Tim's request)

New schema keys: `mode` 'docked'|'floating', `floating-opacity` d 0.3–1.0, `floating-x` i, `floating-y` i,
`floating-width` i (-1 = defaults: centred, bottom, 70 % of monitor width).

### A (keyboard.js) additions
- Handle bar gets a **gear button** at its right end (touch target ≥ 9 mm ≈ keyHeight*0.8 square, icon
  'emblem-system-symbolic' / 'preferences-system-symbolic'), plus (in floating mode) the handle acts as
  grab bar. New signal `'settings-request'` emitted on gear tap. Gear must not trigger the swipe-down
  logic (stop event propagation on the gear).
- New method `setFloating(bool)`: in floating mode draw a **resize grip** at the bottom-right corner
  (≥ 9 mm square, visible diagonal-lines icon or '⇲'), expose it as getter `resizeGrip` (St.Widget), and give
  the keyboard rounded outer corners/border. In docked mode the grip is hidden.
- Keyboard width = allocation width (it already scales keys by width/15); key height is still set by
  setKeyHeight(px) — the coordinator computes it.

### D — `settingsPanel.js`, `floating.js`
```js
export const SettingsPanel = GObject.registerClass(class extends St.BoxLayout {
  constructor({settings, pxPerMm})  // pxPerMm(): function returning current logical px/mm
  // touch-optimised overlay shown inside the keyboard container (coordinator adds it as an overlay
  // child of the container on top of the keys, same size as the keyboard). Large rows (≥ 9 mm):
  // Tastenhöhe (slider 7–20 mm, live value label, +/- buttons), Modus Angedockt/Schwebend (segmented),
  // F-Reihe an/aus, Layout QWERTZ/QWERTY (segmented), Inhalt verkleinern an/aus (insensitive in floating
  // mode), Automatisch einblenden an/aus, Deckkraft slider 30–100 % (only sensitive in floating mode),
  // close button "Fertig". Bound directly to GSettings (two-way, react to external changes so the
  // Adw prefs window and the panel stay in sync). Scroll (St.ScrollView) if content taller than keyboard.
  // signal 'close-request'
});
export class FloatingController {
  constructor({settings, container, getGrabActor, getResizeGrip, onGeometryChanged})
  // In floating mode: press+drag on grab actor (keyboard handle) moves the container (touch + mouse,
  // using global.stage.grab), resize grip drag changes width (keeping aspect: height follows from key
  // height computed by coordinator → call onGeometryChanged()), clamps to the monitor's work area,
  // saves floating-x/-y/-width to GSettings on release (not during motion). Applies floating-opacity
  // (container.opacity = 255*v). enable()/disable() when mode switches; rebind() after keyboard rebuild.
  destroy()
}
```
In floating mode the coordinator: no strut (WorkArea.setShown(false) / affectsStruts off), no swipe-down
on the handle (handle = grab bar; hide via hide key / panel icon), swipe-up-from-edge still shows.
Floating key height = docked key height(mm→px) * floatingWidth / monitorWidth, min 6 mm.

### C (prefs.js) additions
Add rows for mode (ComboRow Angedockt/Schwebend) and floating opacity (SpinRow or Adw.ActionRow+Gtk.Scale
30–100 %, sensitive only in floating mode). Floating x/y/width are not shown (maybe a "Position
zurücksetzen" button that resets floating-x/-y/-width).

## Amendment 2 — prediction engine (iOS-like suggestions, autocorrect, dynamic hit areas)

New directory `tablet-osk@kruegertim/predict/` (pure JS ES modules, **no gi imports** except in `store.js`),
data in `tablet-osk@kruegertim/predict/data/`, build tools in `~/osk/tools/` (not shipped).

```js
// predict/engine.js  (pure, node-testable)
export class PredictionEngine {
  constructor({lexicon, bigrams, userDict})   // lexicon/bigrams: parsed data objects (see loader); userDict: UserDict
  setLanguage(lang)                           // 'de' | 'en' (engine may hold both lexicons lazily via loader)
  suggest(prefix, prevWord = null, max = 3)   // -> [{word, score, kind:'literal'|'completion'|'correction'|'next'}]
                                              //    iOS slot order: [literal-or-alt, BEST, alt]; prefix '' => next-word (bigram)
  autocorrect(word, prevWord = null)          // -> {replacement, confidence} | null  (only when confident; keep case pattern,
                                              //    never change words in lexicon/userDict, never numbers/URLs/mixed alnum)
  nextKeyProbs(prefix)                        // -> Map(char -> prob) over a-z äöüß (lowercase), smoothed, sums to 1
  learn(word)  / unlearn(word)                // userDict bookkeeping: word kept twice => learned
}
// predict/touch.js (pure)
export function resolveTouch({x, y}, keys, probs, {sigmaX, sigmaY, enabled})
  // keys: [{char, cx, cy, w, h}] (centres in px); returns char maximising P(char|prefix)*N(touch|centre);
  // must never pick a key whose visible rect is farther than ~0.5 key from the touch (cap), and if
  // the touch is in the inner 60% of a visible key return that key (iOS keeps clear hits).
// predict/loader.js — lazily loads data/<lang>.json(.gz?) via a passed-in readFile(path) function,
//    returns {lexicon, bigrams}; caches; parse cost measured.
// predict/store.js — UserDict persisted (JSON) at ~/.local/share/tablet-osk/userdict.json via Gio, debounced
//    writes, clear(); never stores anything when told the field is a password/PIN.
```
Performance budget: every call above < 5 ms on this laptop (measure with node, report p50/p95);
data file sizes small (target < 3 MB per language uncompressed, load < 150 ms).

## Amendment 3 — keyboard.js UI rework + prediction controller

### U (keyboard.js, stylesheet.css) — owner: UI agent
1. **Docked mode: no handle bar.** The top row is now the **suggestion bar** (~8 mm, part of preferredHeight):
   left = small gear button (emits 'settings-request'), then 3 equal suggestion slots (middle emphasised).
   Floating mode keeps a grab bar above the suggestion bar (the `handle` getter returns it; in docked mode
   `handle` returns null — VisibilityController/FloatingController already cope with null).
2. **Swipe down anywhere hides** (docked + floating): normal keys fire on **release**, not press. Track each
   pointer/touch sequence over the keyboard; if it moves down > 1 key height, |dy| > 2|dx| → cancel the pending
   key (no output, cancel repeat) and emit `'swipe-hide'` (coordinator hides; optional: follow finger with
   translation_y during the drag and snap back if cancelled). Key repeat (Backspace, arrows…) still starts after
   500 ms hold; once repeat started, the key already produced output (that's fine). Modifiers toggle on release.
   Horizontal moves within a key are ignored. A sequence that started on a key and is released on another key
   still activates the start key (iOS behaviour) unless it became a swipe.
3. **Keycap labels:** all bold; shift/AltGr glyphs same font size as the base glyph; multi-glyph keys use real
   keycap arrangement: shift char top-left, base char bottom-left, AltGr char bottom-right; letter keys show a
   single uppercase label (centre); keys with only base+shift: shift top-left, base bottom-left. Active level is
   highlighted (inactive glyphs dimmed to ~45 % when Shift or AltGr is latched/locked; base dimmed when a level
   is active). Glyph size scales with key size (fit check at 9 mm keys, compact and smallest floating width).
4. **Prediction hooks** (used by predictController.js):
   - `setSuggestions(slots)` — array of 3 `{text, kind}`|null (kind 'literal' → render in quotes);
     emits `'suggestion-activated'(index:int)`.
   - `setSuggestionsEnabled(bool)` — false → slots empty & non-reactive (password/terminal), gear stays.
   - `setCharFilter(fn)` — fn(char:string) called synchronously right before a printable char (incl. ' ' and
     punctuation) is output; may perform edits (autocorrect) first. Return value ignored.
   - `setKeyResolver(fn|null)` — for char keys: fn({x, y}, candidates) → char|null, where candidates =
     [{char, cx, cy, w, h}] (stage coords of all visible letter keys, lowercase base char). If it returns a char
     different from the hit key, that key is activated instead (visual press feedback stays on the touched key).
   - Emits `'text-typed'(str)` after printable output, `'key-sent'(keysymName)` for specials (already exists;
     BackSpace must also emit it).
   - Editing helpers: `deleteBackward(n)` (BackSpace taps, or Main.inputMethod.delete_surrounding when it has
     IM focus) and `typeText(str)` (commit, no shift/caps applied, one-shot modifiers untouched).
   - Shift auto-capitalisation is NOT required now.

### P (predictController.js, settingsPanel.js, prefs.js, schema) — owner: prediction agent
`export class PredictController { constructor({settings, keyboard, extensionPath}); destroy(); reset() }`
Uses predict/engine.js, loader.js, touch.js, store.js (Amendment 2). Context = Main.inputMethod._surroundingText /
_surroundingTextCursor when available (signal 'surrounding-text-set'), else an internal buffer of what the OSK
typed; reset on focus change (stage notify::key-focus, input-panel-state ON) and on hide.
Autocorrect on space/punctuation via charFilter (deleteBackward(word.length) + typeText(replacement)); immediate
BackSpace after an autocorrect restores the original word (and calls engine.unlearn/blocks that correction);
words typed & kept twice are learned. Suggestion tap: replace current partial word with the suggestion + ' '.
After space: next-word predictions. Disabled entirely (no learning, no suggestions) when
Main.inputMethod.content_purpose is PASSWORD, PIN or TERMINAL, or hints contain HIDDEN_TEXT/SENSITIVE_DATA.
Dynamic hit areas via setKeyResolver + touch.resolveTouch with nextKeyProbs(prefix).
New schema keys: `suggestions` b true, `autocorrect` b true, `dynamic-hitareas` b true,
`prediction-language` enum 'auto'|'de'|'en' (auto: qwertz→de, qwerty→en). Settings rows in settingsPanel.js
(gear panel) and prefs.js: "Vorschläge", "Autokorrektur", "Dynamische Trefferflächen", "Sprache"
(Automatisch/Deutsch/Englisch), button "Gelerntes Wörterbuch löschen" (calls a GSettings-free path: write a
`clear-userdict-request` counter key i, incremented by the button; the controller watches it and clears).
Data loads lazily (first show) via GLib idle; never blocks a key press > 5 ms.
