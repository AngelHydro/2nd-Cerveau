import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { extractLinks, nameKey, type WikiLink } from "./links.ts";

/** Dossiers rangés par classification thématique : nombre de niveaux (classe, sous-classe). */
const CLASSIFIED: Record<string, number> = { Books: 2, "Vidéos": 2, Articles: 2, "Sites Web": 2, Arts: 1 };
/** Dossiers d'entités regroupés sous un parent commun : le libellé est le 2e niveau. */
const NESTED_FOLDERS = new Set(["Personnality & organisations"]);

export interface NoteMeta {
  source?: string;
  date?: string;
  aliases: string[];
  /** `Etat` contient « A faire » : note à compléter par Claude. */
  todo: boolean;
  /** Aucun contenu en dehors des métadonnées. */
  empty: boolean;
}

export interface Note {
  /** Chemin relatif à Wiki/, sans « .md », séparateurs « / ». */
  id: string;
  title: string;
  /** Chemin relatif à Wiki/, avec extension. */
  relPath: string;
  /** Dossier d'entité : "Concepts", "Personnality", "Books"… */
  folder: string;
  /** [classe, sous-classe] pour les dossiers classés, vide sinon. */
  classPath: string[];
  body: string;
  meta: NoteMeta;
  links: WikiLink[];
  frontmatterError?: string;
}

export interface Vault {
  notes: Map<string, Note>;
  /** nameKey(nom de fichier avec extension) → chemin relatif (images, PDF, docx…). */
  attachments: Map<string, string>;
  /** nameKey(nom sans .md) → ids des notes portant ce nom. */
  byName: Map<string, string[]>;
  /** Liens résolus entre notes, sans doublon ni boucle. */
  edges: Array<[string, string]>;
  backlinks: Map<string, Set<string>>;
  /** Cibles [[…]] qui ne correspondent à aucun fichier, par clé normalisée. */
  unresolved: Map<string, { name: string; sources: Set<string> }>;
}

export type Resolved = { kind: "note"; id: string } | { kind: "file"; relPath: string } | null;

/**
 * Fichiers du dossier : `rel` sert d'identifiant, `disk` à ouvrir le fichier. macOS peut rendre les accents
 * décomposés (« e » + « ́ ») : `rel` les recompose pour que les identifiants soient les mêmes partout.
 */
async function walk(dir: string, rel = ""): Promise<Array<{ rel: string; disk: string }>> {
  const out: Array<{ rel: string; disk: string }> = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const disk = path.join(dir, entry.name);
    const childRel = rel ? `${rel}/${entry.name.normalize("NFC")}` : entry.name.normalize("NFC");
    if (entry.isDirectory()) out.push(...(await walk(disk, childRel)));
    else if (entry.isFile()) out.push({ rel: childRel, disk });
  }
  return out;
}

function folderOf(segments: string[]): string {
  if (segments.length < 2) return "";
  return NESTED_FOLDERS.has(segments[0]) && segments.length > 2 ? segments[1] : segments[0];
}

function classPathOf(segments: string[]): string[] {
  const depth = CLASSIFIED[segments[0]];
  if (!depth) return [];
  // segments = [dossier, classe, (sous-classe), …, fichier] : on ne garde que les niveaux de classification.
  return segments.slice(1, 1 + depth).filter((_, i) => 1 + i < segments.length - 1);
}

function asDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/** « A faire », « À faire », « a faire »… */
const isTodo = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase() === "a faire";

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => v != null).map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

async function readNote(diskPath: string, relPath: string): Promise<Note> {
  const raw = await fs.readFile(diskPath, "utf8");
  let body = raw;
  let data: Record<string, unknown> = {};
  let frontmatterError: string | undefined;
  try {
    // Pas de cache gray-matter : chaque lecture repart du contenu actuel du fichier.
    const parsed = matter(raw, {} as never);
    body = parsed.content;
    data = parsed.data ?? {};
  } catch (err) {
    frontmatterError = (err as Error).message;
    body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  }
  const segments = relPath.split("/");
  const id = relPath.replace(/\.md$/i, "");
  return {
    id,
    title: segments[segments.length - 1].replace(/\.md$/i, ""),
    relPath,
    folder: folderOf(segments),
    classPath: classPathOf(segments),
    body,
    meta: {
      source: typeof data.Source === "string" ? data.Source : undefined,
      date: asDate(data["Date de génération"]),
      aliases: asList(data.aliases),
      todo: asList(data.Etat).some(isTodo),
      empty: body.trim() === "",
    },
    links: extractLinks(body),
    frontmatterError,
  };
}

/** Résout une cible [[…]] comme Obsidian : par nom de fichier, casse ignorée, chemin partiel accepté. */
export function resolveTarget(vault: Pick<Vault, "attachments" | "byName">, target: string): Resolved {
  const clean = target.replace(/\\/g, "/").replace(/^\.?\//, "");
  const leaf = clean.split("/").pop() ?? clean;
  const file = vault.attachments.get(nameKey(leaf));
  if (file) return { kind: "file", relPath: file };
  const base = leaf.replace(/\.md$/i, "");
  const ids = vault.byName.get(nameKey(base));
  if (!ids?.length) return null;
  if (ids.length > 1 && clean.includes("/")) {
    const want = nameKey(clean.replace(/\.md$/i, ""));
    const hit = ids.find((id) => nameKey(id).endsWith(want) || want.endsWith(nameKey(id)));
    if (hit) return { kind: "note", id: hit };
  }
  // Plusieurs notes du même nom : Obsidian retient la plus proche de la racine.
  const best = [...ids].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
  return { kind: "note", id: best };
}

/** Parcourt Wiki/ en lecture seule et construit l'index des notes et des liens. */
export async function buildVault(wikiRoot: string): Promise<Vault> {
  const files = await walk(wikiRoot);
  const notes = new Map<string, Note>();
  const attachments = new Map<string, string>();
  const mdFiles: typeof files = [];
  for (const file of files) {
    if (/\.md$/i.test(file.rel)) mdFiles.push(file);
    else attachments.set(nameKey(file.rel.split("/").pop()!), file.rel);
  }
  const parsed = await Promise.all(mdFiles.map((f) => readNote(f.disk, f.rel)));
  const byName = new Map<string, string[]>();
  for (const note of parsed) {
    notes.set(note.id, note);
    const key = nameKey(note.title);
    byName.set(key, [...(byName.get(key) ?? []), note.id]);
  }

  const vault: Vault = { notes, attachments, byName, edges: [], backlinks: new Map(), unresolved: new Map() };
  const seen = new Set<string>();
  for (const note of notes.values()) {
    for (const link of note.links) {
      const r = resolveTarget(vault, link.target);
      if (r?.kind === "note") {
        if (r.id === note.id) continue;
        const key = `${note.id}\u0000${r.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          vault.edges.push([note.id, r.id]);
        }
        if (!vault.backlinks.has(r.id)) vault.backlinks.set(r.id, new Set());
        vault.backlinks.get(r.id)!.add(note.id);
      } else if (!r && !link.embed) {
        const key = nameKey(link.target);
        const entry = vault.unresolved.get(key) ?? { name: link.target, sources: new Set<string>() };
        entry.sources.add(note.id);
        vault.unresolved.set(key, entry);
      }
    }
  }
  return vault;
}
