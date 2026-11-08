import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AppConfig {
  /** Racine du coffre (celle qui contient Wiki/ et .obsidian/). */
  vaultPath: string;
  /** Sous-dossier indexé, relatif au coffre. */
  wikiDir: string;
  host: string;
  port: number;
}

/**
 * Lit config.json (personnel, hors du dépôt : copie de config.example.json) ; les variables
 * SC_VAULT / SC_HOST / SC_PORT ont priorité (autre coffre ou autre port, sans modifier le fichier).
 */
export function loadConfig(): AppConfig {
  const file = path.join(PROJECT_ROOT, "config.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const vaultPath = process.env.SC_VAULT ?? raw.vaultPath;
  if (!vaultPath) throw new Error("Aucun coffre configuré : copie config.example.json en config.json et renseigne « vaultPath » (ou définis SC_VAULT).");
  return {
    vaultPath,
    wikiDir: raw.wikiDir ?? "Wiki",
    host: process.env.SC_HOST ?? raw.host ?? "127.0.0.1",
    port: Number(process.env.SC_PORT ?? raw.port ?? 4321),
  };
}
