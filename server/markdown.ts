import createMarkdownIt, { type MarkdownIt, type StateCore, type StateInline } from "markdown-it";
import footnote from "markdown-it-footnote";
import mark from "markdown-it-mark";
import katexPluginModule from "@vscode/markdown-it-katex";
import { parseLinkInner, slugify, stripComments } from "./links.ts";

export interface RenderContext {
  /** Résout une cible [[…]] ; `title` sert d'étiquette par défaut pour les notes. */
  resolve(target: string): { kind: "note"; id: string; title: string } | { kind: "file"; relPath: string } | null;
}

interface Env {
  ctx: RenderContext;
  slugs: Map<string, number>;
  [key: string | symbol]: unknown;
}

/** L'environnement markdown-it est typé de façon générique ; on retrouve ici le nôtre. */
const envOf = (env: unknown) => env as Env;

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
const CALLOUT_RE = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/;
const CALLOUT_TITLES: Record<string, string> = { ai: "IA", todo: "À faire", tip: "Astuce", warning: "Attention", example: "Exemple", quote: "Citation", important: "Important", info: "Info", note: "Note" };

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fileUrl = (relPath: string) => `/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
const noteHref = (id: string, heading?: string) =>
  `#/note/${encodeURIComponent(id)}${heading ? `/${encodeURIComponent(slugify(heading))}` : ""}`;

/** Liens Obsidian `[[…]]` et intégrations `![[…]]`. */
function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    embed = true;
    pos++;
  }
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || inner.includes("\n") || inner.includes("[")) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.meta = { embed, ...parseLinkInner(inner) };
  }
  state.pos = end + 2;
  return true;
}

/** Étiquettes `#tag` en ligne (hors titres, qui sont des blocs). */
function tagRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x23 /* # */) return false;
  const prev = state.pos === 0 ? " " : state.src[state.pos - 1];
  if (!/\s|\(/.test(prev)) return false;
  const m = /^#([\p{L}_][\p{L}\p{N}_/-]*)/u.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) {
    const token = state.push("obsidian_tag", "", 0);
    token.content = m[1];
  }
  state.pos += m[0].length;
  return true;
}

/** Transforme `> [!type]± Titre` en encadré, avant l'analyse du texte en ligne. */
function calloutRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "blockquote_open") continue;
    const inline = tokens[i + 2];
    if (tokens[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const nl = inline.content.indexOf("\n");
    const first = nl >= 0 ? inline.content.slice(0, nl) : inline.content;
    const m = CALLOUT_RE.exec(first.trim());
    if (!m) continue;
    const callout = { type: m[1].toLowerCase(), fold: m[2], title: m[3].trim() };
    tokens[i].meta = { callout };
    const rest = nl >= 0 ? inline.content.slice(nl + 1) : "";
    if (rest.trim()) inline.content = rest;
    else tokens.splice(i + 1, 3);
    let depth = 0;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === "blockquote_open") depth++;
      else if (tokens[j].type === "blockquote_close") {
        if (depth === 0) {
          tokens[j].meta = { calloutClose: callout.fold ? "details" : "div" };
          break;
        }
        depth--;
      }
    }
  }
}

/** Ancres des titres, uniques dans la note, pour les liens `[[Note#Titre]]`. */
function headingIdRule(state: StateCore): void {
  const env = envOf(state.env);
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "heading_open") continue;
    const base = slugify(tokens[i + 1]?.content ?? "") || "section";
    const n = env.slugs.get(base) ?? 0;
    env.slugs.set(base, n + 1);
    tokens[i].attrSet("id", n ? `${base}-${n}` : base);
  }
}

function createMarkdown(): MarkdownIt {
  const md = createMarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
  // Selon le chargeur (ESM ou CommonJS), le plugin KaTeX arrive seul ou sous `.default`.
  const katexPlugin = ((katexPluginModule as unknown as { default?: unknown }).default ?? katexPluginModule) as never;
  md.use(footnote).use(mark).use(katexPlugin, { throwOnError: false, output: "html" });
  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.push("obsidian_tag", tagRule);
  md.core.ruler.after("block", "callouts", calloutRule);
  md.core.ruler.push("heading_ids", headingIdRule);

  md.renderer.rules.wikilink = (tokens, idx, _opts, env) => {
    const { target, heading, alias, embed } = tokens[idx].meta as { target: string; heading?: string; alias?: string; embed: boolean };
    const r = envOf(env).ctx.resolve(target);
    const fallback = heading ? `${target} › ${heading}` : target;
    if (r?.kind === "file") {
      const url = fileUrl(r.relPath);
      if (embed && IMAGE_EXT.test(r.relPath)) {
        const size = alias && /^\d+(x\d+)?$/.test(alias) ? alias.split("x") : null;
        const dims = size ? ` width="${size[0]}"${size[1] ? ` height="${size[1]}"` : ""}` : "";
        return `<img class="embed-image" src="${url}" alt="${escapeHtml(size ? target : alias ?? target)}" loading="lazy"${dims}>`;
      }
      if (embed && /\.pdf$/i.test(r.relPath)) {
        return `<iframe class="embed-pdf" src="${url}" title="${escapeHtml(alias ?? target)}" loading="lazy"></iframe>`;
      }
      return `<a class="file-link" href="${url}" target="_blank" rel="noopener">${escapeHtml(alias ?? target)}</a>`;
    }
    if (r?.kind === "note") {
      const label = alias ?? fallback;
      const cls = embed ? "internal-link embed-note" : "internal-link";
      return `<a class="${cls}" data-note="${escapeHtml(r.id)}" href="${noteHref(r.id, heading)}">${escapeHtml(label)}</a>`;
    }
    return `<span class="internal-link is-unresolved" title="Note pas encore créée">${escapeHtml(alias ?? fallback)}</span>`;
  };

  md.renderer.rules.obsidian_tag = (tokens, idx) => `<span class="tag">#${escapeHtml(tokens[idx].content)}</span>`;

  md.renderer.rules.blockquote_open = (tokens, idx, opts, env, self) => {
    const callout = tokens[idx].meta?.callout as { type: string; fold: string; title: string } | undefined;
    if (!callout) return self.renderToken(tokens, idx, opts);
    const title = callout.title ? md.renderInline(callout.title, env) : escapeHtml(CALLOUT_TITLES[callout.type] ?? callout.type.charAt(0).toUpperCase() + callout.type.slice(1));
    const head = `<span class="callout-icon" aria-hidden="true"></span><span class="callout-title-inner">${title}</span>`;
    const type = escapeHtml(callout.type);
    if (callout.fold) {
      return `<details class="callout" data-callout="${type}"${callout.fold === "+" ? " open" : ""}><summary class="callout-title">${head}</summary><div class="callout-content">\n`;
    }
    return `<div class="callout" data-callout="${type}"><div class="callout-title">${head}</div><div class="callout-content">\n`;
  };
  md.renderer.rules.blockquote_close = (tokens, idx, opts, _env, self) => {
    const close = tokens[idx].meta?.calloutClose as string | undefined;
    if (close === "details") return "</div></details>\n";
    if (close === "div") return "</div></div>\n";
    return self.renderToken(tokens, idx, opts);
  };

  const defaultFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const lang = tokens[idx].info.trim().split(/\s+/)[0]?.toLowerCase();
    if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(tokens[idx].content)}</pre>\n`;
    return defaultFence(tokens, idx, opts, env, self);
  };

  md.renderer.rules.table_open = () => `<div class="table-wrap"><table>\n`;
  md.renderer.rules.table_close = () => `</table></div>\n`;

  const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const href = String(tokens[idx].attrGet("href") ?? "");
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet("target", "_blank");
      tokens[idx].attrSet("rel", "noopener noreferrer");
      tokens[idx].attrJoin("class", "external-link");
    }
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };
  return md;
}

const md = createMarkdown();

/** Rend le corps d'une note (sans frontmatter) en HTML. Le nettoyage de sécurité se fait côté navigateur. */
export function renderNote(body: string, ctx: RenderContext): string {
  const env: Env = { ctx, slugs: new Map() };
  return md.render(stripComments(body), env);
}
