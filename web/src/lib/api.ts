// Types et appels de l'API de lecture (voir server/state.ts).

export interface ColorGroup {
  prefix: string;
  label: string;
  color: string;
}

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
  meta: { source?: string; date?: string; aliases: string[] };
  html: string;
  backlinks: NoteRef[];
  neighbors: { nodes: Array<NoteRef & { x: number; y: number; size: number }>; edges: Array<[number, number]> };
  /** Ouvre la note dans Obsidian, pour la corriger. */
  obsidianUrl: string;
  /** Notes qui citent son nom en texte brut, sans aucun lien vers elle. */
  unlinkedMentions: NoteRef[];
}

/** Libellé des notes sans groupe de couleur, toujours rangé en dernier. */
export const OTHERS_LABEL = "Autres";
/** Couleur des notes sans groupe (la même que `DEFAULT_NODE_COLOR` de server/colors.ts). */
export const DEFAULT_NODE_COLOR = "#8c96a3";

/** Tri alphabétique à la française sur le libellé affiché ; « Autres » reste en dernier. */
export function byLabel<T>(label: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const x = label(a);
    const y = label(b);
    if (x === OTHERS_LABEL || y === OTHERS_LABEL) return Number(x === OTHERS_LABEL) - Number(y === OTHERS_LABEL);
    return x.localeCompare(y, "fr", { sensitivity: "base" });
  };
}

/** Ligne de la légende du graphe : un groupe de couleur et son nombre de notes. */
export interface LegendEntry {
  /** Indice du groupe de couleur (-1 = notes sans groupe). */
  index: number;
  label: string;
  color: string;
  count: number;
}

/** Chemin demandé entre deux notes : ses étapes, ou `found: false` si rien ne les relie. */
export interface Chain {
  steps: Array<{ id: string; title: string; color: string }>;
  found: boolean;
  /** Titres du départ et de l'arrivée. */
  from: string;
  to: string;
}

/** Vue d'ensemble du coffre (voir server/state.ts). */
export interface VaultStats {
  notes: number;
  links: number;
  byGroup: Array<{ label: string; color: string; count: number }>;
  byClass: Array<{ folder: string; total: number; classes: Array<{ name: string; count: number }> }>;
  missing: { total: number; top: Array<{ name: string; mentions: number; sources: NoteRef[] }> };
  todo: Array<NoteRef & { empty: boolean }>;
  isolated: NoteRef[];
}

export interface SearchHit extends NoteRef {
  classPath: string[];
  snippet: Array<{ text: string; hit: boolean }>;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(res.status === 404 ? "introuvable" : `erreur ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchGraph = () => getJson<GraphPayload>("/api/graph");
export const fetchNote = (id: string, signal?: AbortSignal) => getJson<NotePayload>(`/api/note?id=${encodeURIComponent(id)}`, signal);
export interface SearchResponse {
  /** Les meilleurs résultats, avec extraits, pour la liste. */
  hits: SearchHit[];
  /** Toutes les notes qui correspondent, pour ne garder qu'elles dans le graphe. */
  matches: string[];
}

export const fetchStats = (signal?: AbortSignal) => getJson<VaultStats>("/api/stats", signal);

export const searchNotes = (q: string, signal?: AbortSignal) => getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, signal);

/**
 * Prévient à chaque réindexation du coffre (nouvelles notes de Claude, par exemple), et aussi
 * quand la connexion revient après un redémarrage du serveur.
 */
export function onVaultUpdate(callback: () => void): () => void {
  const source = new EventSource("/api/events");
  let connectedOnce = false;
  source.addEventListener("hello", () => {
    if (connectedOnce) callback();
    connectedOnce = true;
  });
  source.addEventListener("update", () => callback());
  return () => source.close();
}

/** Navigation par l'adresse (#/note/<id>/<ancre>) : le bouton Retour du navigateur et du téléphone fonctionne. */
export function parseHash(hash: string): { id: string; heading?: string } | null {
  const m = /^#\/note\/([^/]+)(?:\/([^/]+))?$/.exec(hash);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]), heading: m[2] ? decodeURIComponent(m[2]) : undefined };
}

export const noteHash = (id: string) => `#/note/${encodeURIComponent(id)}`;

/** Adresse du tableau de bord. */
export const DASHBOARD_HASH = "#/tableau";

/** Libellés français des dossiers d'entités du Wiki. */
const FOLDER_LABELS: Record<string, string> = {
  Books: "Livres",
  Places: "Lieux",
  Personnality: "Personnalités",
  Evenements: "Événements",
  Study: "Cours",
};
export const folderLabel = (folder: string) => FOLDER_LABELS[folder] ?? folder;

/** Fil d'Ariane d'une note : « Dossier › Classe › Sous-classe ». */
export const trailOf = (n: { folder: string; classPath: string[] }) => [folderLabel(n.folder), ...n.classPath].filter(Boolean);

/** La touche vient d'une saisie (champ de texte) : les raccourcis d'une lettre ne s'appliquent pas. */
export const isTyping = (e: KeyboardEvent) => Boolean((e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]"));

export const formatCount = (n: number) => n.toLocaleString("fr-FR");
