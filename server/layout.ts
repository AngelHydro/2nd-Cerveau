import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { FORCES } from "../shared/forces.ts";

export type Positions = Map<string, { x: number; y: number }>;

/** Version du format de cache : la changer force un nouveau calcul complet. */
const CACHE_VERSION = 2;

interface Body extends SimulationNodeDatum {
  id: string;
}

async function readCache(file: string): Promise<Record<string, [number, number]>> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return raw?.version === CACHE_VERSION ? raw.positions : {};
  } catch {
    return {};
  }
}

/**
 * Disposition du graphe avec la même physique que l'interface (voir shared/forces.ts).
 * Les positions sont mémorisées dans le cache du projet pour que le graphe garde sa forme d'un
 * démarrage à l'autre ; une nouvelle note apparaît près de ses voisines, puis l'ensemble se stabilise.
 */
export async function computeLayout(nodeIds: string[], edges: Array<[string, string]>, cacheFile: string): Promise<Positions> {
  const cache = await readCache(cacheFile);
  const neighbors = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (a === b) continue;
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  }

  const known = nodeIds.filter((id) => cache[id]).length;
  const fresh = known < nodeIds.length * 0.5;
  const radius = Math.max(50, ...Object.values(cache).map(([x, y]) => Math.hypot(x, y)));
  const bodies: Body[] = nodeIds.map((id) => {
    if (!fresh && cache[id]) return { id, x: cache[id][0], y: cache[id][1] };
    const anchors = fresh ? [] : (neighbors.get(id) ?? []).filter((n) => cache[n]);
    if (anchors.length) {
      const x = anchors.reduce((s, n) => s + cache[n][0], 0) / anchors.length;
      const y = anchors.reduce((s, n) => s + cache[n][1], 0) / anchors.length;
      return { id, x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 10 };
    }
    const angle = Math.random() * Math.PI * 2;
    const r = fresh ? Math.sqrt(Math.random()) * 300 : radius * (1 + Math.random() * 0.05);
    return { id, x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });

  const ticks = fresh ? 450 : known === nodeIds.length ? 0 : 90;
  if (ticks) {
    const index = new Map(bodies.map((b, i) => [b.id, i]));
    const links = edges.filter(([a, b]) => a !== b && index.has(a) && index.has(b)).map(([a, b]) => ({ source: index.get(a)!, target: index.get(b)! }));
    const sim = forceSimulation(bodies)
      .alpha(fresh ? 1 : 0.15)
      .alphaDecay(FORCES.alphaDecay)
      .velocityDecay(FORCES.velocityDecay)
      .force("link", forceLink(links).distance(FORCES.linkDistance).strength(FORCES.linkStrength))
      .force("charge", forceManyBody().strength(FORCES.charge).distanceMax(FORCES.chargeDistanceMax).theta(FORCES.theta))
      .force("collide", forceCollide(FORCES.collideRadius).strength(FORCES.collideStrength))
      .force("x", forceX(0).strength(FORCES.gravity))
      .force("y", forceY(0).strength(FORCES.gravity))
      .stop();
    for (let i = 0; i < ticks; i++) sim.tick();
  }

  const positions: Positions = new Map();
  const out: Record<string, [number, number]> = {};
  for (const b of bodies) {
    positions.set(b.id, { x: b.x!, y: b.y! });
    out[b.id] = [Math.round(b.x! * 100) / 100, Math.round(b.y! * 100) / 100];
  }
  if (ticks || Object.keys(cache).length !== nodeIds.length) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ version: CACHE_VERSION, positions: out }));
  }
  return positions;
}
