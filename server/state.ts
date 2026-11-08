import path from "node:path";
import { PROJECT_ROOT, type AppConfig } from "./config.ts";
import { DEFAULT_NODE_COLOR, UNRESOLVED_COLOR, groupFor, loadColorGroups, type ColorGroup } from "./colors.ts";
import { computeLayout } from "./layout.ts";
import { renderNote, type RenderContext } from "./markdown.ts";
import { mentionText } from "./links.ts";
import { buildSearchIndex, foldText, type Segment } from "./search.ts";
import { buildVault, resolveTarget, type Note, type Vault } from "./vault.ts";

export interface GraphNode {
  id: string;
  label: string;
  color: string;
  size: number;
  x: number;
  y: number;
  folder: string;
  /** Indice du groupe de couleur (`GraphPayload.groups`), -1 si aucun. */
  group: number;
  unresolved?: boolean;
}

export interface GraphPayload {
  version: number;
  nodes: GraphNode[];
  /** Indices dans `nodes`. */
  edges: Array<[number, number]>;
  groups: ColorGroup[];
}

export interface NoteRef {
  id: string;
  title: string;
  color: string;
  folder: string;
}

export interface NotePayload extends NoteRef {
  relPath: string;
  classPath: string[];
  meta: Note["meta"];
  html: string;
  backlinks: NoteRef[];
  neighbors: { nodes: Array<NoteRef & { x: number; y: number; size: number }>; edges: Array<[number, number]> };
  /** Ouvre la note dans Obsidian (pour la corriger : l'interface reste en lecture seule). */
  obsidianUrl: string;
  /** Notes qui citent son nom (ou un alias) en texte brut, sans aucun lien vers elle. */
  unlinkedMentions: NoteRef[];
}

/** Vue d'ensemble du coffre, pour le tableau de bord. */
export interface VaultStats {
  notes: number;
  links: number;
  /** Nombre de notes par groupe de couleur du graphe (et « Autres » pour les notes sans groupe). */
  byGroup: Array<{ label: string; color: string; count: number }>;
  /** Dossiers classés (§5.1) : nombre de notes par classe. */
  byClass: Array<{ folder: string; total: number; classes: Array<{ name: string; count: number }> }>;
  /** Liens [[…]] sans note, tous, les plus cités d'abord. */
  missing: { total: number; top: Array<{ name: string; mentions: number; sources: NoteRef[] }> };
  /** Notes dont l'Etat est « A faire ». */
  todo: Array<NoteRef & { empty: boolean }>;
  /** Notes reliées à aucune autre. */
  isolated: NoteRef[];
}

export interface SearchHit extends NoteRef {
  classPath: string[];
  snippet: Segment[];
}

export interface AppState {
  version: number;
  vault: Vault;
  graph: GraphPayload;
  search(query: string): SearchHit[];
  /** Identifiants de toutes les notes qui correspondent, pour ne garder qu'elles dans le graphe. */
  match(query: string): string[];
  note(id: string): NotePayload | null;
  stats(): VaultStats;
  /** Rend une note : exposé pour le contrôle du coffre complet. */
  render(note: Note): string;
}

const UNRESOLVED_PREFIX = "?";

export async function buildState(cfg: AppConfig, version: number, cacheFile = path.join(PROJECT_ROOT, "cache", "layout.json")): Promise<AppState> {
  const wikiRoot = path.join(cfg.vaultPath, cfg.wikiDir);
  const [vault, groups] = await Promise.all([buildVault(wikiRoot), loadColorGroups(cfg.vaultPath, cfg.wikiDir)]);
  const colorOf = (note: Note) => groupFor(note.relPath, groups)?.color ?? DEFAULT_NODE_COLOR;
  const ref = (note: Note): NoteRef => ({ id: note.id, title: note.title, color: colorOf(note), folder: note.folder });

  // Graphe : notes + cibles non créées (en gris), comme la vue graphe d'Obsidian.
  const edges: Array<[string, string]> = [...vault.edges];
  for (const [key, u] of vault.unresolved) for (const source of u.sources) edges.push([source, UNRESOLVED_PREFIX + key]);
  const ids = [...vault.notes.keys(), ...[...vault.unresolved.keys()].map((k) => UNRESOLVED_PREFIX + k)];
  const positions = await computeLayout(ids, edges, cacheFile);

  const degree = new Map<string, number>();
  for (const [a, b] of edges) {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  const sizeOf = (id: string) => 1.6 + Math.min(8, Math.sqrt(degree.get(id) ?? 0) * 0.95);
  const nodes: GraphNode[] = ids.map((id) => {
    const p = positions.get(id)!;
    const note = vault.notes.get(id);
    if (note) {
      const group = groupFor(note.relPath, groups);
      return { id, label: note.title, color: colorOf(note), size: sizeOf(id), x: p.x, y: p.y, folder: note.folder, group: group ? groups.indexOf(group) : -1 };
    }
    const u = vault.unresolved.get(id.slice(UNRESOLVED_PREFIX.length))!;
    return { id, label: u.name, color: UNRESOLVED_COLOR, size: sizeOf(id) * 0.8, x: p.x, y: p.y, folder: "", group: -1, unresolved: true };
  });
  const indexOf = new Map(ids.map((id, i) => [id, i]));
  const graph: GraphPayload = {
    version,
    nodes,
    edges: edges.map(([a, b]) => [indexOf.get(a)!, indexOf.get(b)!]),
    groups,
  };

  const ctx: RenderContext = {
    resolve(target) {
      const r = resolveTarget(vault, target);
      if (r?.kind === "note") return { ...r, title: vault.notes.get(r.id)!.title };
      return r;
    },
  };
  const render = (note: Note) => renderNote(note.body, ctx);
  const vaultName = path.basename(cfg.vaultPath);
  const obsidianUrl = (note: Note) => `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(`${cfg.wikiDir}/${note.id}`)}`;
  const byTitle = (a: Note, b: Note) => a.title.localeCompare(b.title, "fr");
  /** Notes désignées par leurs identifiants, par ordre alphabétique de titre. */
  const refsOf = (ids: Iterable<string>): NoteRef[] =>
    [...ids]
      .map((i) => vault.notes.get(i))
      .filter((n): n is Note => Boolean(n))
      .sort(byTitle)
      .map(ref);

  // Mentions non liées : le texte de chaque note, sans accents ni majuscules, préparé une fois.
  const mentionable = new Map<string, string>();
  for (const note of vault.notes.values()) mentionable.set(note.id, foldText(mentionText(note.body)));
  /** En dessous, un nom est trop court ou trop ambigu pour être cherché (« C », « Go », « IA »…). */
  const MIN_MENTION = 4;
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unlinkedMentionsOf = (note: Note): NoteRef[] => {
    const terms = [...new Set([note.title, ...note.meta.aliases].map((t) => foldText(t.trim())))].filter((t) => t.length >= MIN_MENTION);
    if (!terms.length) return [];
    const word = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "u");
    const linked = vault.backlinks.get(note.id);
    const found: string[] = [];
    for (const [id, text] of mentionable) if (id !== note.id && !linked?.has(id) && word.test(text)) found.push(id);
    return refsOf(found);
  };
  const index = buildSearchIndex(vault);

  const neighborsOf = (id: string) => {
    const set = new Set<string>([id]);
    for (const [a, b] of vault.edges) {
      if (a === id) set.add(b);
      else if (b === id) set.add(a);
    }
    const list = [...set];
    const pos = new Map(list.map((n, i) => [n, i]));
    const localEdges: Array<[number, number]> = [];
    for (const [a, b] of vault.edges) if (pos.has(a) && pos.has(b)) localEdges.push([pos.get(a)!, pos.get(b)!]);
    return {
      nodes: list.map((n) => {
        const note = vault.notes.get(n)!;
        const p = positions.get(n)!;
        return { ...ref(note), x: p.x, y: p.y, size: sizeOf(n) };
      }),
      edges: localEdges,
    };
  };

  return {
    version,
    vault,
    graph,
    render,
    match(query) {
      return index.match(query).filter((id) => vault.notes.has(id));
    },
    search(query) {
      return index.search(query).flatMap((hit) => {
        const note = vault.notes.get(hit.id);
        return note ? [{ ...ref(note), classPath: note.classPath, snippet: hit.snippet }] : [];
      });
    },
    note(id) {
      const note = vault.notes.get(id);
      if (!note) return null;
      return {
        ...ref(note),
        relPath: note.relPath,
        classPath: note.classPath,
        meta: note.meta,
        html: render(note),
        backlinks: refsOf(vault.backlinks.get(id) ?? []),
        neighbors: neighborsOf(id),
        obsidianUrl: obsidianUrl(note),
        unlinkedMentions: unlinkedMentionsOf(note),
      };
    },
    stats() {
      const all = [...vault.notes.values()];
      const counts = new Map<number, number>();
      for (const n of nodes) if (!n.unresolved) counts.set(n.group, (counts.get(n.group) ?? 0) + 1);
      const byGroup = groups.map((g, i) => ({ label: g.label, color: g.color, count: counts.get(i) ?? 0 }));
      if (counts.get(-1)) byGroup.push({ label: "Autres", color: DEFAULT_NODE_COLOR, count: counts.get(-1)! });

      const classes = new Map<string, Map<string, number>>();
      for (const note of all) {
        if (!note.classPath.length) continue;
        const perFolder = classes.get(note.folder) ?? new Map<string, number>();
        perFolder.set(note.classPath[0], (perFolder.get(note.classPath[0]) ?? 0) + 1);
        classes.set(note.folder, perFolder);
      }
      const byClass = [...classes].map(([folder, perClass]) => ({
        folder,
        total: [...perClass.values()].reduce((a, b) => a + b, 0),
        classes: [...perClass].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fr")),
      }));
      byClass.sort((a, b) => b.total - a.total);

      const missing = [...vault.unresolved.values()]
        .map((u) => ({ name: u.name, mentions: u.sources.size, sources: refsOf(u.sources) }))
        .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, "fr"));

      const linked = new Set<string>();
      for (const [a, b] of vault.edges) {
        linked.add(a);
        linked.add(b);
      }
      return {
        notes: vault.notes.size,
        links: vault.edges.length,
        byGroup,
        byClass,
        missing: { total: missing.length, top: missing },
        todo: all
          .filter((n) => n.meta.todo)
          .sort(byTitle)
          .map((n) => ({ ...ref(n), empty: n.meta.empty })),
        isolated: all.filter((n) => !linked.has(n.id)).sort(byTitle).map(ref),
      };
    },
  };
}
