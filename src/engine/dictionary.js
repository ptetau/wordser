// Dictionary of real words.
//
// The rules call for the Oxford English Dictionary. The OED has no freely
// redistributable machine-readable form, so the bundled data/words.txt is a
// Scrabble-legal international English list (SOWPODS) used as a stand-in.
// Any provider can be plugged in by constructing a Dictionary-compatible
// object with a has(word) method — e.g. an adapter over the OED API for
// deployments holding an OED licence.

export class Dictionary {
  /** @param {Iterable<string>} words */
  constructor(words = []) {
    this.words = new Set();
    for (const w of words) {
      const s = w.trim().toLowerCase();
      if (s) this.words.add(s);
    }
  }

  static fromText(text) {
    return new Dictionary(text.split('\n'));
  }

  has(word) {
    return this.words.has(String(word).toLowerCase());
  }

  get size() {
    return this.words.size;
  }
}

/** Node-only convenience loader for the bundled list. */
export async function loadBundledDictionary(url = new URL('../../data/words.txt', import.meta.url)) {
  const { readFile } = await import('node:fs/promises');
  return Dictionary.fromText(await readFile(url, 'utf8'));
}
