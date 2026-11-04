export class UserDict {
    constructor() { this.words = new Map(); this.cleared = 0; this.private = false; globalThis.__fakeStore = this; }
    load() {}
    learn(w) { if (this.private) throw new Error('learn while private'); const k = w.toLowerCase(); this.words.set(k, (this.words.get(k) ?? 0) + 1); }
    clear() { this.words.clear(); this.cleared++; }
    flush() {}
}
