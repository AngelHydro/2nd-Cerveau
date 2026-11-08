// Contrôle du vrai coffre, en lecture seule : indexation, liens et rendu de toutes les notes.
import { statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../server/config.ts";
import { buildState } from "../server/state.ts";

const cfg = loadConfig();
const wikiRoot = path.join(cfg.vaultPath, cfg.wikiDir);

const t0 = Date.now();
const state = await buildState(cfg, 1);
const { vault } = state;
console.log(`Indexation : ${Date.now() - t0} ms`);
console.log(`Notes : ${vault.notes.size} · pièces jointes : ${vault.attachments.size} · liens résolus : ${vault.edges.length}`);
console.log(`Cibles sans fichier (distinctes, hors intégrations) : ${vault.unresolved.size}`);

const fmErrors = [...vault.notes.values()].filter((n) => n.frontmatterError);
if (fmErrors.length) {
  console.log(`Métadonnées illisibles (${fmErrors.length}) :`);
  for (const n of fmErrors) console.log(`  - ${n.relPath} : ${n.frontmatterError}`);
}

const t1 = Date.now();
const renderErrors: string[] = [];
const mtimes = new Map<string, number>();
for (const note of vault.notes.values()) {
  mtimes.set(note.relPath, statSync(path.join(wikiRoot, note.relPath)).mtimeMs);
  try {
    state.render(note);
  } catch (err) {
    renderErrors.push(`${note.relPath} : ${(err as Error).message}`);
  }
}
console.log(`Rendu de ${vault.notes.size} notes : ${Date.now() - t1} ms, ${renderErrors.length} erreur(s).`);
for (const e of renderErrors) console.log(`  - ${e}`);

for (const q of ["mensonge", "stoicisme", "Kant"]) {
  const hits = state.search(q).slice(0, 3).map((h) => h.title);
  console.log(`Recherche « ${q} » : ${hits.join(" · ") || "(aucun résultat)"}`);
}

const changed = [...mtimes].filter(([rel, m]) => statSync(path.join(wikiRoot, rel)).mtimeMs !== m);
console.log(changed.length ? `ATTENTION : ${changed.length} fichier(s) modifié(s) pendant le contrôle.` : "Coffre inchangé pendant le contrôle.");
process.exit(renderErrors.length ? 1 : 0);
