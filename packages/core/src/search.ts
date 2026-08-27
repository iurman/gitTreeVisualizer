import type { TreeStructure } from './types.js';

export type SearchHit = { oid: string; score: number };

type Entry = { oid: string; hay: string; sha: string; author: string; time: number };

/**
 * A small client-side index over subject, author and SHA prefix. Deliberately
 * not a trie: a few thousand lowercased strings scan faster than the index
 * would take to build, and this keeps search results exact.
 */
export class SearchIndex {
  private entries: Entry[] = [];

  constructor(tree: TreeStructure) {
    for (const oid of tree.order) {
      const n = tree.nodes.get(oid)!;
      this.entries.push({
        oid,
        sha: oid.toLowerCase(),
        author: n.commit.author.toLowerCase(),
        hay: `${n.commit.subject} ${n.commit.author}`.toLowerCase(),
        time: n.time,
      });
    }
  }

  query(raw: string, limit = 60): SearchHit[] {
    const q = raw.trim().toLowerCase();
    if (q.length < 2) return [];
    const hits: SearchHit[] = [];
    for (const e of this.entries) {
      let score = 0;
      if (e.sha.startsWith(q)) score = 100;
      else if (e.author === q) score = 60;
      else {
        const i = e.hay.indexOf(q);
        if (i === 0) score = 40;
        else if (i > 0) score = 24 - Math.min(20, i * 0.05);
      }
      if (score > 0) hits.push({ oid: e.oid, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** Every match, for the lens attributes. Unbounded on purpose: dimming is per-instance. */
  matchSet(raw: string): Set<string> {
    const q = raw.trim().toLowerCase();
    if (q.length < 2) return new Set();
    const out = new Set<string>();
    for (const e of this.entries) {
      if (e.sha.startsWith(q) || e.hay.includes(q)) out.add(e.oid);
    }
    return out;
  }
}
