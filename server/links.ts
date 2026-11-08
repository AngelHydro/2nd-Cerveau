export interface WikiLink {
  target: string;
  heading?: string;
  alias?: string;
  embed: boolean;
}

/** Clé de comparaison des noms, comme Obsidian : casse ignorée, Unicode normalisé. */
export function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/** Découpe l'intérieur d'un lien : `Cible#Section|Alias` (le `\|` des tableaux compte comme `|`). */
export function parseLinkInner(inner: string): Pick<WikiLink, "target" | "heading" | "alias"> {
  const text = inner.replace(/\\\|/g, "|");
  const pipe = text.indexOf("|");
  const left = pipe >= 0 ? text.slice(0, pipe) : text;
  const alias = pipe >= 0 ? text.slice(pipe + 1).trim() || undefined : undefined;
  const hash = left.indexOf("#");
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim();
  const heading = hash >= 0 ? left.slice(hash + 1).trim() || undefined : undefined;
  return { target, heading, alias };
}

/** Bloc de code délimité par ``` ou ~~~. */
export const FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;

/** Retire les commentaires Obsidian `%%…%%`, sans toucher aux blocs de code. */
export function stripComments(md: string): string {
  let out = "";
  let last = 0;
  for (const m of md.matchAll(FENCE_RE)) {
    out += md.slice(last, m.index).replace(/%%[\s\S]*?%%/g, "") + m[0];
    last = m.index! + m[0].length;
  }
  return out + md.slice(last).replace(/%%[\s\S]*?%%/g, "");
}

/** Ne garde que le texte où un lien compte : ni code, ni commentaire. */
function stripNonContent(md: string): string {
  return stripComments(md).replace(FENCE_RE, "").replace(/`[^`\n]*`/g, "");
}

/** Lien `[[…]]` (1 : « ! » d'une intégration, 2 : intérieur du lien). */
export const LINK_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;

export function extractLinks(md: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of stripNonContent(md).matchAll(LINK_RE)) {
    const parsed = parseLinkInner(m[2]);
    if (!parsed.target) continue; // [[#Section]] : renvoi dans la même note
    out.push({ embed: m[1] === "!", ...parsed });
  }
  return out;
}

/**
 * Texte où chercher les mentions d'une note écrites sans lien : ni code, ni commentaire, ni lien
 * `[[…]]` (ni son alias), ni lien web.
 */
export function mentionText(md: string): string {
  return stripNonContent(md)
    .replace(LINK_RE, " ")
    .replace(/\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/** Identifiant d'ancre d'un titre, partagé par le rendu et les liens `[[Note#Titre]]`. */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
