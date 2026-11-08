import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { watch, type FSWatcher } from "chokidar";
import Fastify, { type FastifyInstance } from "fastify";
import { PROJECT_ROOT, type AppConfig } from "./config.ts";
import { buildState, type AppState } from "./state.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export interface ServerOptions {
  /** Surveiller le coffre et réindexer à chaque changement. */
  watch?: boolean;
  /** Fichier de cache de la disposition du graphe. */
  cacheFile?: string;
  log?: (msg: string) => void;
  /**
   * Agrandit la fenêtre de l'application installée (demandé par la page à son ouverture). Seule action
   * du serveur hors lecture : elle ne touche pas au coffre et n'est acceptée que depuis l'ordinateur.
   */
  maximizeWindow?: () => Promise<void>;
}

export interface SecondCerveauServer {
  app: FastifyInstance;
  state(): AppState;
  close(): Promise<void>;
}

/**
 * Serveur en lecture seule : il n'ouvre les fichiers du coffre qu'en lecture et n'expose que des routes
 * GET, plus une seule route POST qui agrandit la fenêtre de l'application (voir `maximizeWindow`).
 */
export async function createServer(cfg: AppConfig, opts: ServerOptions = {}): Promise<SecondCerveauServer> {
  const log = opts.log ?? (() => {});
  const wikiRoot = path.join(cfg.vaultPath, cfg.wikiDir);
  if (!existsSync(wikiRoot)) throw new Error(`Coffre introuvable : ${wikiRoot}\nVérifie « vaultPath » dans config.json.`);

  const t0 = Date.now();
  let state = await buildState(cfg, 1, opts.cacheFile);
  log(`Index prêt : ${state.vault.notes.size} notes, ${state.vault.edges.length} liens (${Date.now() - t0} ms).`);

  const app = Fastify({ logger: false });

  // Interface compilée (web/dist).
  const dist = path.join(PROJECT_ROOT, "web", "dist");
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: "/", index: ["index.html"] });
  } else {
    app.get("/", async (_req, reply) => reply.type("text/plain; charset=utf-8").send("Interface non compilée : lance « npm start »."));
  }

  // Pièces jointes (images, PDF…), limitées à Wiki/ et ouvertes en lecture seule.
  const root = path.resolve(wikiRoot);
  app.get<{ Params: { "*": string } }>("/files/*", async (req, reply) => {
    const rel = req.params["*"] ?? "";
    const abs = path.resolve(root, rel);
    const hidden = rel.split(/[\\/]/).some((s) => s.startsWith("."));
    const info = !hidden && abs.startsWith(root + path.sep) ? await stat(abs).catch(() => null) : null;
    if (!info?.isFile()) return reply.code(404).send({ error: "Fichier introuvable" });
    reply.type(MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
    reply.header("Content-Length", info.size);
    return reply.send(createReadStream(abs, { flags: "r" }));
  });

  app.get("/api/graph", async () => state.graph);
  app.get("/api/stats", async () => state.stats());
  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    const q = String(req.query.q ?? "").slice(0, 200);
    return { hits: state.search(q), matches: state.match(q) };
  });
  app.get<{ Querystring: { id?: string } }>("/api/note", async (req, reply) => {
    const note = state.note(String(req.query.id ?? ""));
    if (!note) return reply.code(404).send({ error: "Note introuvable" });
    return note;
  });

  // Le lanceur de l'icône du bureau vérifie ainsi que le serveur tourne déjà.
  app.get("/api/ping", async () => ({ ok: true }));

  // La fenêtre de l'application s'agrandit à l'ouverture (depuis l'ordinateur seulement, pas le téléphone).
  const maximize = opts.maximizeWindow;
  if (maximize) {
    app.post("/api/fenetre/agrandir", async (req, reply) => {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) return reply.code(403).send({ error: "Réservé à l'ordinateur" });
      await maximize();
      return { ok: true };
    });
  }

  // Canal de mise à jour : l'interface se rafraîchit sans rechargement quand l'index change.
  const clients = new Set<ServerResponse>();
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: hello\ndata: ${state.version}\n\n`);
    clients.add(res);
    req.raw.on("close", () => clients.delete(res));
  });
  const ping = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000);
  ping.unref();

  let rebuilding = false;
  let pending = false;
  async function rebuild(): Promise<void> {
    if (rebuilding) {
      pending = true;
      return;
    }
    rebuilding = true;
    try {
      const t = Date.now();
      state = await buildState(cfg, state.version + 1, opts.cacheFile);
      log(`Réindexé : ${state.vault.notes.size} notes (${Date.now() - t} ms).`);
      for (const res of clients) res.write(`event: update\ndata: ${state.version}\n\n`);
    } catch (err) {
      log(`Réindexation impossible : ${(err as Error).message}`);
    } finally {
      rebuilding = false;
      if (pending) {
        pending = false;
        await rebuild();
      }
    }
  }

  let watcher: FSWatcher | undefined;
  if (opts.watch) {
    let timer: NodeJS.Timeout | undefined;
    watcher = watch(wikiRoot, {
      ignoreInitial: true,
      ignored: (p: string) => path.basename(p).startsWith("."),
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
    }).on("all", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void rebuild(), 2000);
    });
    await new Promise<void>((resolve) => watcher!.once("ready", () => resolve()));
  }

  return {
    app,
    state: () => state,
    async close() {
      clearInterval(ping);
      for (const res of clients) res.end();
      await watcher?.close();
      await app.close();
    },
  };
}
