import MiniSearch from "minisearch";
import { FENCE_RE, LINK_RE, parseLinkInner, stripComments } from "./links.ts";
import type { Vault } from "./vault.ts";

/** Minuscules sans accents : « Stoïcisme » et « stoicisme » deviennent identiques. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const tokenize = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Texte brut lisible d'une note, pour la recherche et les extraits. */
function toPlainText(md: string): string {
  return stripComments(md)
    .replace(FENCE_RE, " ")
    .replace(/^>\s*\[![\w-]+\][+-]?[^\n]*$/gm, " ")
    .replace(LINK_RE, (_, _embed: string, inner: string) => {
      const { target, heading, alias } = parseLinkInner(inner);
      return alias ?? (heading ? `${target} ${heading}` : target);
    })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`~=]+/g, "")
    .replace(/[>#|\\[\]]+/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Extrait autour de la première occurrence, avec les termes trouvés marqués (sans HTML). */
export function makeSnippet(text: string, terms: string[], radius = 90): Segment[] {
  if (!text) return [];
  const folded: string[] = [];
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const ch of foldText(text[i])) {
      folded.push(ch);
      origin.push(i);
    }
  }
  const hay = folded.join("");
  const wanted = [...new Set(terms.map(foldText).filter((t) => t.length > 1))].sort((a, b) => b.length - a.length);
  let first = -1;
  for (const t of wanted) {
    const at = hay.indexOf(t);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  if (first < 0) {
    const cut = text.length > radius * 2 ? `${text.slice(0, radius * 2).replace(/\s\S*$/, "")} …` : text;
    return [{ text: cut, hit: false }];
  }
  let start = Math.max(0, origin[first] - radius);
  let end = Math.min(text.length, origin[first] + radius);
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  if (end < text.length) end = text.lastIndexOf(" ", end) > start ? text.lastIndexOf(" ", end) : end;

  // Repère toutes les occurrences dans la fenêtre, en positions du texte d'origine.
  const hits: Array<[number, number]> = [];
  for (const t of wanted) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(t, from);
      if (at < 0) break;
      from = at + t.length;
      const a = origin[at];
      const b = origin[at + t.length - 1] + 1;
      if (a >= start && b <= end && !hits.some(([x, y]) => a < y && b > x)) hits.push([a, b]);
    }
  }
  hits.sort((x, y) => x[0] - y[0]);
  const segments: Segment[] = [];
  let cursor = start;
  for (const [a, b] of hits) {
    if (a > cursor) segments.push({ text: text.slice(cursor, a), hit: false });
    segments.push({ text: text.slice(a, b), hit: true });
    cursor = b;
  }
  if (cursor < end) segments.push({ text: text.slice(cursor, end), hit: false });
  if (start > 0) segments.unshift({ text: "… ", hit: false });
  if (end < text.length) segments.push({ text: " …", hit: false });
  return segments;
}

export interface SearchIndex {
  search(query: string, limit?: number): Array<{ id: string; snippet: Segment[] }>;
  /** Toutes les notes qui correspondent (sans extrait), pour filtrer le graphe. */
  match(query: string, limit?: number): string[];
}

export function buildSearchIndex(vault: Vault): SearchIndex {
  const plain = new Map<string, string>();
  const index = new MiniSearch<{ id: string; title: string; aliases: string; text: string }>({
    fields: ["title", "aliases", "text"],
    storeFields: [],
    tokenize,
    processTerm: (term) => {
      const f = foldText(term);
      return f.length > 1 || /\d/.test(f) ? f : null;
    },
    searchOptions: {
      boost: { title: 5, aliases: 4 },
      prefix: true,
      fuzzy: (term) => (term.length > 4 ? 0.2 : false),
      combineWith: "AND",
    },
  });
  const docs = [...vault.notes.values()].map((n) => {
    const text = toPlainText(n.body);
    plain.set(n.id, text);
    return { id: n.id, title: n.title, aliases: n.meta.aliases.join(" "), text };
  });
  index.addAll(docs);

  const run = (query: string) => {
    const q = query.trim();
    if (!q) return [];
    const results = index.search(q);
    return results.length ? results : index.search(q, { combineWith: "OR" });
  };

  return {
    match(query, limit = 600) {
      return run(query)
        .slice(0, limit)
        .map((r) => r.id as string);
    },
    search(query, limit = 20) {
      const q = query.trim();
      const results = run(q);
      return results.slice(0, limit).map((r) => ({
        id: r.id as string,
        snippet: makeSnippet(plain.get(r.id as string) ?? "", [...r.terms, ...tokenize(q)]),
      }));
    },
  };
}
