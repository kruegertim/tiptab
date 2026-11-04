export const inputMethod = {
    currentFocus: null, content_purpose: 0, content_hints: 0,
    _text: null, _cursor: null, _handlers: [],
    constructor: {$gtype: {signals: ['surrounding-text-set', 'input-panel-state']}},
    connectObject(...args) { args.pop(); for (let i = 0; i < args.length; i += 2) this._handlers.push([args[i], args[i + 1]]); },
    disconnectObject() { this._handlers = []; },
    emit(name, ...a) { for (const [n, f] of this._handlers) if (n === name) f(this, ...a); },
    getSurroundingText() { return [this._text, this._cursor, this._cursor]; },
};
