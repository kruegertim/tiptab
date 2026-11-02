export class DataLoader {
    constructor({readFile, dataDir}) { this.readFile = readFile; this.dataDir = dataDir; this.cache = new Map(); }
    path(lang) { return `${this.dataDir}/${lang}.json`; }
    has(lang) { return this.cache.has(lang); }
    load(lang) {
        if (this.cache.has(lang)) return this.cache.get(lang);
        const raw = this.readFile(this.path(lang));
        const obj = raw instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(raw)) : raw;
        globalThis.__preparsedUsed = !(raw instanceof Uint8Array);
        const r = {lexicon: obj.words, bigrams: obj.bigrams};
        this.cache.set(lang, r);
        return r;
    }
}
