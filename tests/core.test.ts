import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type SecondCerveauServer } from "../server/app.ts";
import type { AppConfig } from "../server/config.ts";
import { extractLinks, mentionText, nameKey, parseLinkInner, slugify } from "../server/links.ts";
import { foldText, makeSnippet } from "../server/search.ts";
import type { AppState, VaultStats } from "../server/state.ts";
import { numberToFrench } from "../web/src/lib/french.ts";
import { byLabel } from "../web/src/lib/api.ts";
import { shortestPath } from "../web/src/lib/paths.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg: AppConfig = { vaultPath: path.join(here, "fixtures", "vault"), wikiDir: "Wiki", host: "127.0.0.1", port: 0 };
const tmp = mkdtempSync(path.join(os.tmpdir(), "second-cerveau-test-"));

describe("liens Obsidian", () => {
  it("découpe cible, section et alias, y compris le pipe échappé des tableaux", () => {
    expect(parseLinkInner("Livre#Première partie|le livre")).toEqual({ target: "Livre", heading: "Première partie", alias: "le livre" });
    expect(parseLinkInner("Livre\\|le livre")).toEqual({ target: "Livre", heading: undefined, alias: "le livre" });
    expect(parseLinkInner("Wiki/Concepts/Conscience")).toMatchObject({ target: "Wiki/Concepts/Conscience" });
  });

  it("ignore les liens dans le code et les commentaires, et repère les intégrations", () => {
    const links = extractLinks("A [[Un]] `[[Deux]]`\n```\n[[Trois]]\n```\n%% [[Quatre]] %%\n![[img.png|300]]");
    expect(links.map((l) => l.target)).toEqual(["Un", "img.png"]);
    expect(links[1]).toMatchObject({ embed: true, alias: "300" });
  });

  it("compare les noms sans tenir compte de la casse ni de la forme Unicode", () => {
    expect(nameKey("Épictète")).toBe(nameKey("Épictète".toLowerCase()));
    expect(slugify("Première partie : l'idée")).toBe("premiere-partie-l-idee");
  });
});

describe("nombres en toutes lettres", () => {
  it("suit l'orthographe traditionnelle", () => {
    const cases: Array<[number, string]> = [
      [1330, "mille trois cent trente"],
      [21, "vingt et un"],
      [71, "soixante et onze"],
      [77, "soixante-dix-sept"],
      [80, "quatre-vingts"],
      [81, "quatre-vingt-un"],
      [99, "quatre-vingt-dix-neuf"],
      [200, "deux cents"],
      [201, "deux cent un"],
      [5682, "cinq mille six cent quatre-vingt-deux"],
      [80000, "quatre-vingt mille"],
      [200000, "deux cent mille"],
    ];
    for (const [n, text] of cases) expect(numberToFrench(n), String(n)).toBe(text);
  });
});

describe("chemin entre deux notes", () => {
  const node = (id: string, unresolved = false) => ({ id, label: id, color: "", size: 1, x: 0, y: 0, folder: "", group: -1, unresolved });
  // A — B — C — D, et E isolée ; A et D sont aussi reliées par une note pas encore créée (?X).
  const graph = { nodes: [node("A"), node("B"), node("C"), node("D"), node("E"), node("?X", true)], edges: [[0, 1], [1, 2], [2, 3], [0, 5], [5, 3]] as Array<[number, number]> };

  it("suit les liens dans les deux sens, sans passer par une note à créer", () => {
    expect(shortestPath(graph, "A", "D")).toEqual(["A", "B", "C", "D"]);
    expect(shortestPath(graph, "D", "A")).toEqual(["D", "C", "B", "A"]);
  });

  it("répond qu'il n'y a pas de chemin vers une note isolée", () => {
    expect(shortestPath(graph, "A", "E")).toBeNull();
    expect(shortestPath(graph, "A", "A")).toEqual(["A"]);
  });
});

describe("mentions et tri", () => {
  it("ne cherche les mentions ni dans les liens, ni dans le code, ni dans les commentaires", () => {
    const text = mentionText("[[Stoïcisme]] et [[Kant|la Stoa]] `stoïcisme` %% stoïcisme %% [site](https://stoa.fr) reste");
    expect(text).toContain("reste");
    expect(text.toLowerCase()).not.toMatch(/sto/);
  });

  it("trie à la française et range « Autres » en dernier", () => {
    const labels = ["Vidéos", "Autres", "Événements", "Concepts", "livres"];
    expect([...labels].sort(byLabel((l) => l))).toEqual(["Concepts", "Événements", "livres", "Vidéos", "Autres"]);
  });
});

describe("recherche", () => {
  it("ignore les accents et marque les termes trouvés dans l'extrait", () => {
    expect(foldText("Stoïcisme")).toBe("stoicisme");
    const seg = makeSnippet("Le stoïcisme de Marc Aurèle est une école.", ["stoicisme"]);
    expect(seg.filter((s) => s.hit).map((s) => s.text)).toEqual(["stoïcisme"]);
  });
});

describe("coffre d'exemple", () => {
  let server: SecondCerveauServer;
  let state: AppState;
  beforeAll(async () => {
    server = await createServer(cfg, { cacheFile: path.join(tmp, "layout.json") });
    state = server.state();
  });
  afterAll(async () => {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexe les notes, leurs dossiers et leur classification", () => {
    expect(state.vault.notes.size).toBe(8);
    const livre = state.vault.notes.get("Books/Philosophie/Éthique & morale/Livre")!;
    expect(livre.classPath).toEqual(["Philosophie", "Éthique & morale"]);
    expect(state.vault.notes.get("Arts/Musique/Chanson")!.classPath).toEqual(["Musique"]);
    expect(state.vault.notes.get("Personnality & organisations/Personnality/Epictète")!.folder).toBe("Personnality");
    const stoic = state.vault.notes.get("Concepts/Stoïcisme")!;
    expect(stoic.meta).toMatchObject({ source: "Recherche autonome (Claude)", date: "2026-06-30", aliases: ["Stoa"] });
  });

  it("résout les liens sans casse et liste les liens entrants et les notes absentes", () => {
    const backlinks = [...state.vault.backlinks.get("Concepts/Stoïcisme")!].sort();
    expect(backlinks).toEqual([
      "Books/Philosophie/Éthique & morale/Livre",
      "Personnality & organisations/Personnality/Epictète",
      "Personnality & organisations/Personnality/Marc Aurèle",
    ]);
    expect([...state.vault.unresolved.keys()]).toEqual(["note absente"]);
  });

  it("prend les couleurs dans la configuration du graphe Obsidian", () => {
    const byId = new Map(state.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("Concepts/Stoïcisme")!.color).toBe("#2e80f2");
    expect(byId.get("Personnality & organisations/Personnality/Epictète")!.color).toBe("#ff82b2");
    expect(byId.get("?note absente")!.unresolved).toBe(true);
  });

  it("rend fidèlement la syntaxe Obsidian", () => {
    const html = state.note("Concepts/Stoïcisme")!.html;
    expect(html).toContain('<div class="callout" data-callout="ai">');
    expect(html).toMatch(/<details class="callout" data-callout="warning">(?!.*open)/);
    expect(html).toContain("<mark>surligné</mark>");
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="footnote-ref"');
    expect(html).toContain('<pre class="mermaid">graph TD; A--&gt;B');
    expect(html).toContain(`href="#/note/${encodeURIComponent("Books/Philosophie/Éthique & morale/Livre")}/premiere-partie"`);
    expect(html).toContain(">le livre</a>");
    expect(html).toContain(">l'empereur</a>");
    expect(html).toContain('class="internal-link is-unresolved"');
    expect(html).not.toContain("commentaire caché");
    expect(html).toContain("[[Dans du code]]");
    expect(html).toContain('src="/files/Arts/Arts%20visuels%20%26%20architecture/image.png"');
    expect(state.note("Books/Philosophie/Éthique & morale/Livre")!.html).toContain('<h2 id="premiere-partie">');
  });

  it("trouve les notes sans accent et par alias", () => {
    expect(state.search("stoicisme")[0].id).toBe("Concepts/Stoïcisme");
    expect(state.search("stoa")[0].id).toBe("Concepts/Stoïcisme");
    expect(state.search("empereur")[0].id).toBe("Personnality & organisations/Personnality/Marc Aurèle");
  });

  it("renvoie toutes les notes correspondantes pour filtrer le graphe", async () => {
    const res = await server.app.inject({ url: `/api/search?q=${encodeURIComponent("stoïcisme")}` });
    const body = res.json() as { hits: Array<{ id: string }>; matches: string[] };
    expect(body.hits[0].id).toBe("Concepts/Stoïcisme");
    expect(body.matches).toContain("Concepts/Stoïcisme");
    expect(body.matches).toContain("Personnality & organisations/Personnality/Epictète");
    expect(body.matches).not.toContain("Arts/Musique/Chanson");
  });

  it("sert les pièces jointes du Wiki mais rien en dehors", async () => {
    const ok = await server.app.inject({ url: "/files/Arts/Arts%20visuels%20%26%20architecture/image.png" });
    expect(ok.statusCode).toBe(200);
    for (const url of ["/files/../secret.txt", "/files/..%2Fsecret.txt", "/files/%2e%2e/secret.txt", "/files/../.obsidian/graph.json"]) {
      const res = await server.app.inject({ url });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body).not.toContain("CONTENU-PRIVE");
    }
  });

  it("n'accepte aucune écriture", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await server.app.inject({ method, url: "/api/note?id=Concepts/Stoïcisme" });
      expect(res.statusCode, method).toBe(404);
    }
  });

  it("donne de quoi ouvrir la note dans Obsidian", () => {
    const url = state.note("Personnality & organisations/Personnality/Marc Aurèle")!.obsidianUrl;
    expect(url).toBe(`obsidian://open?vault=vault&file=${encodeURIComponent("Wiki/Personnality & organisations/Personnality/Marc Aurèle")}`);
  });

  it("indique le groupe de couleur de chaque note du graphe", () => {
    const byId = new Map(state.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("Concepts/Stoïcisme")!.group).toBe(0);
    expect(byId.get("Personnality & organisations/Personnality/Epictète")!.group).toBe(1);
    expect(byId.get("Arts/Musique/Chanson")!.group).toBe(-1);
  });

  it("résume le coffre pour le tableau de bord", async () => {
    const res = await server.app.inject({ url: "/api/stats" });
    const stats = res.json() as VaultStats;
    expect(stats.notes).toBe(8);
    expect(stats.byGroup).toEqual([
      { label: "Concepts", color: "#2e80f2", count: 2 },
      { label: "Personnality", color: "#ff82b2", count: 2 },
      { label: "Autres", color: "#8c96a3", count: 4 },
    ]);
    expect(stats.byClass.map((c) => [c.folder, c.classes.map((k) => k.name)])).toEqual([
      ["Arts", ["Musique"]],
      ["Books", ["Philosophie"]],
    ]);
    expect(stats.missing.total).toBe(1);
    expect(stats.missing.top[0]).toMatchObject({ name: "Note absente", mentions: 1 });
    expect(stats.todo).toEqual([expect.objectContaining({ id: "Concepts/Ataraxie", empty: true })]);
    expect(stats.isolated.map((n) => n.id)).toEqual(["Concepts/Ataraxie", "Places/Athènes", "Arts/Musique/Chanson", "Study/Philo/Cours"]);
  });

  it("ne signale que les mentions vraiment sans lien", () => {
    // Athènes et le cours de Study/ citent le stoïcisme sans lien ; Livre, Épictète et Marc Aurèle ont déjà un lien.
    expect(state.note("Concepts/Stoïcisme")!.unlinkedMentions.map((n) => n.id)).toEqual(["Places/Athènes", "Study/Philo/Cours"]);
  });

  it("répond au lanceur de l'icône du bureau", async () => {
    const res = await server.app.inject({ url: "/api/ping" });
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("fenêtre de l'application", () => {
  it("n'est agrandie qu'à la demande de l'ordinateur lui-même, jamais du réseau", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "second-cerveau-fenetre-"));
    let calls = 0;
    const srv = await createServer(cfg, { cacheFile: path.join(dir, "layout.json"), maximizeWindow: async () => void calls++ });
    try {
      const local = await srv.app.inject({ method: "POST", url: "/api/fenetre/agrandir", remoteAddress: "127.0.0.1" });
      expect(local.statusCode).toBe(200);
      const phone = await srv.app.inject({ method: "POST", url: "/api/fenetre/agrandir", remoteAddress: "192.168.1.20" });
      expect(phone.statusCode).toBe(403);
      expect(calls).toBe(1);
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
