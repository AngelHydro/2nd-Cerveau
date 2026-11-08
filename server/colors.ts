import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ColorGroup {
  /** Préfixe de chemin relatif à Wiki/ (ex. "Personnality & organisations/Personnality"). */
  prefix: string;
  label: string;
  color: string;
}

export const DEFAULT_NODE_COLOR = "#8c96a3";
export const UNRESOLVED_COLOR = "#4a5058";

/**
 * Lit les groupes de couleurs du graphe Obsidian (.obsidian/graph.json), en lecture seule.
 * Seules les règles `path:"Wiki/…"` sont comprises ; les autres sont ignorées.
 */
export async function loadColorGroups(vaultPath: string, wikiDir: string): Promise<ColorGroup[]> {
  let json: { colorGroups?: Array<{ query: string; color: { rgb: number } }> };
  try {
    json = JSON.parse(await readFile(path.join(vaultPath, ".obsidian", "graph.json"), "utf8"));
  } catch {
    return [];
  }
  const wikiPrefix = `${wikiDir}/`;
  const groups: ColorGroup[] = [];
  for (const g of json.colorGroups ?? []) {
    const m = /^path:"([^"]+)"$/.exec(g.query.trim());
    if (!m || !m[1].startsWith(wikiPrefix)) continue;
    const prefix = m[1].slice(wikiPrefix.length).replace(/\/+$/, "");
    groups.push({
      prefix,
      label: prefix.split("/").pop()!,
      color: `#${g.color.rgb.toString(16).padStart(6, "0")}`,
    });
  }
  return groups;
}

/** Premier groupe dont le préfixe couvre le chemin, comme dans Obsidian. */
export function groupFor(relPath: string, groups: ColorGroup[]): ColorGroup | undefined {
  return groups.find((g) => relPath === g.prefix || relPath.startsWith(`${g.prefix}/`));
}
