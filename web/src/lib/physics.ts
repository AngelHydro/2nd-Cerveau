// Physique du graphe : une simulation de forces (d3-force), comme dans Obsidian.
// Au repos le graphe est immobile ; on peut attraper une note, ses voisines suivent comme au bout
// d'élastiques, puis tout se stabilise et s'arrête.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type Graph from "graphology";
import type Sigma from "sigma";
import { cubicOut } from "svelte/easing";
import { FORCES } from "../../../shared/forces";

interface Body extends SimulationNodeDatum {
  id: string;
}

export interface PhysicsOptions {
  /** Forces : par défaut celles de shared/forces.ts, identiques à la disposition calculée par le serveur. */
  charge?: number;
  gravity?: number;
  linkDistance?: number;
  linkStrength?: number;
  collideRadius?: number;
}

const DRAG_ALPHA = 0.22;

/**
 * Changement de forme (couronne ↔ forme naturelle) : chaque point est tiré vers sa nouvelle place par
 * un ressort, avec sa propre raideur — un mouvement élastique, comme lorsqu'on déplace une note, sans
 * que les notes bougent en bloc. Il démarre en douceur, file, puis se pose (~90 % du trajet en 1,5 s).
 */
const PULL_STRENGTH = 0.018;
/** Arrivée : chaque note à moins de quelques unités de sa place (garde-fou : ~8 s au plus). */
const PULL_ARRIVED = 3;
const PULL_MAX_TICKS = 480;
const PULL_ALPHA = 0.3;
/** Le ressort se tend progressivement : le mouvement démarre en douceur, sans à-coup. */
const PULL_RAMP_TICKS = 24;
/** Formation de la couronne : la place réservée grandit de 5 % à sa taille réelle en ~2 s. */
const GROW_TICKS = 120;
const GROW_FROM = 0.05;

/** Empreinte stable d'un identifiant (FNV-1a), dans [0, 1). */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/** Raideur propre à chaque note (±25 %, stable d'une fois sur l'autre) : elles ne bougent pas en bloc. */
function stiffness(id: string): number {
  return 0.75 + hash01(id) / 2;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Pas maximal d'une animation par image. Si la page se fige (ouverture d'une note…), l'animation
 * reprend là où elle en était au lieu de sauter d'un coup à la fin.
 */
const MAX_STEP_MS = 1000 / 30;
const steadyStep = (now: number, last: number) => Math.min(Math.max(now - last, 0), MAX_STEP_MS);

/** Anime de 0 à 1 (avec `cubicOut` : démarre vite puis freine, comme un point tiré par un ressort) sur `duration` ms, au pas régulier ; renvoie de quoi l'arrêter. */
export function steadyTween(duration: number, onUpdate: (e: number) => void, onDone?: () => void): () => void {
  let elapsed = 0;
  let last = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    elapsed += steadyStep(now, last);
    last = now;
    const t = Math.min(1, elapsed / duration);
    onUpdate(cubicOut(t));
    if (t < 1) raf = requestAnimationFrame(frame);
    else onDone?.();
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

/** Épaisseur de la bande libre autour de la place réservée, en proportion de la hauteur du titre. */
const RING_BAND = 0.35;
/**
 * Écartement de la forme naturelle autour de la place réservée : chaque note s'éloigne du centre dans
 * sa direction, sa distance ρ devenant (R^m + ρ^m)^(1/m), où R est la distance du centre au bord de la
 * bande libre. Avec m = 2 les surfaces seraient conservées et le cœur dense du graphe se tasserait
 * contre le bord ; en dessous, les notes s'éclaircissent en douceur à l'approche du bord.
 */
const RING_EXPONENT = 1.5;
/** Rappel de chaque note vers sa place dans la couronne, au repos (le pendant de la gravité naturelle). */
const RING_ANCHOR = 0.08;

/**
 * Raccord entre la forme du titre et celle de la barre, en proportion de la hauteur du titre : le creux
 * à côté du titre devient une large courbe, sans angle, et les notes viennent l'épouser.
 */
const HOLE_BLEND = 1.6;
/**
 * Bas de la place réservée légèrement bombé (en proportion de la hauteur du titre) : sous la barre, le
 * bord descend en arc doux vers le milieu, pour répondre à l'arrondi du haut au lieu d'un trait plat.
 */
const HOLE_BULGE = 0.5;

/**
 * Zone mesurée à l'écran (titre, barre de recherche), en coordonnées du graphe : un rectangle de
 * centre (cx, cy) et de demi-côtés (rx, ry).
 */
export interface Obstacle {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Pilule (rectangle aux bouts arrondis) de centre (cx, cy), de demi-côtés (hx, hy) et d'arrondi r. */
interface Pill {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  r: number;
}

/**
 * Place réservée au centre : une pilule par zone (titre, barre), fondues l'une dans l'autre par un
 * raccord `blend`, entourée d'une bande libre `band`. (cx, cy) est le centre de l'ensemble, d'où les
 * notes s'écartent. Le bas (côté de la dernière zone, la barre : `down` = ±1 selon l'axe y) est bombé
 * de `bulge` en son milieu.
 */
interface Hole {
  cx: number;
  cy: number;
  parts: Pill[];
  blend: number;
  band: number;
  bulge: number;
  down: number;
}

function holeOf(zones: Obstacle[]): Hole {
  const minX = Math.min(...zones.map((o) => o.cx - o.rx));
  const maxX = Math.max(...zones.map((o) => o.cx + o.rx));
  const minY = Math.min(...zones.map((o) => o.cy - o.ry));
  const maxY = Math.max(...zones.map((o) => o.cy + o.ry));
  const unit = Math.min(...zones.map((o) => o.ry));
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    parts: zones.map((o) => ({ cx: o.cx, cy: o.cy, hx: o.rx, hy: o.ry, r: Math.min(o.rx, o.ry) })),
    blend: unit * HOLE_BLEND,
    band: unit * RING_BAND,
    bulge: unit * HOLE_BULGE,
    down: zones.length > 1 ? Math.sign(zones[zones.length - 1].cy - zones[0].cy) : 0,
  };
}

function mixHole(a: Hole, b: Hole, e: number): Hole {
  if (a.parts.length !== b.parts.length) return b;
  const mix = (u: number, v: number) => u + (v - u) * e;
  return {
    cx: mix(a.cx, b.cx),
    cy: mix(a.cy, b.cy),
    parts: a.parts.map((p, i) => {
      const q = b.parts[i];
      return { cx: mix(p.cx, q.cx), cy: mix(p.cy, q.cy), hx: mix(p.hx, q.hx), hy: mix(p.hy, q.hy), r: mix(p.r, q.r) };
    }),
    blend: mix(a.blend, b.blend),
    band: mix(a.band, b.band),
    bulge: mix(a.bulge, b.bulge),
    down: b.down,
  };
}

/** La même place, réduite d'un facteur `s` autour de son centre. */
function shrinkHole(h: Hole, s: number): Hole {
  return {
    ...h,
    parts: h.parts.map((p) => ({ cx: h.cx + (p.cx - h.cx) * s, cy: h.cy + (p.cy - h.cy) * s, hx: p.hx * s, hy: p.hy * s, r: p.r * s })),
    blend: h.blend * s,
    band: h.band * s,
    bulge: h.bulge * s,
  };
}

function sameHole(a: Hole, b: Hole): boolean {
  const near = (u: number, v: number) => Math.abs(u - v) < 1e-6;
  return (
    near(a.cx, b.cx) &&
    near(a.cy, b.cy) &&
    near(a.blend, b.blend) &&
    near(a.band, b.band) &&
    near(a.bulge, b.bulge) &&
    a.down === b.down &&
    a.parts.length === b.parts.length &&
    a.parts.every((p, i) => (Object.keys(p) as Array<keyof Pill>).every((k) => near(p[k], b.parts[i][k])))
  );
}

/** Distance signée à une pilule (négative dedans). */
function pillDistance(x: number, y: number, p: Pill): number {
  const qx = Math.abs(x - p.cx) - (p.hx - p.r);
  const qy = Math.abs(y - p.cy) - (p.hy - p.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - p.r;
}

/** Distance signée à la place réservée (négative dedans) : les pilules fondues par un minimum adouci. */
function holeDistance(x: number, y: number, h: Hole): number {
  // Sous la barre, on mesure comme si le point était remonté : le bord descend d'autant, au plus au
  // milieu, en s'annulant en douceur aux deux bouts (et progressivement depuis le centre de la barre).
  const bar = h.parts[h.parts.length - 1];
  const below = (y - bar.cy) * h.down;
  if (h.bulge > 0 && below > 0) {
    const t = Math.min(1, Math.abs(x - bar.cx) / bar.hx);
    y -= h.down * h.bulge * (1 - t * t) ** 2 * Math.min(1, below / bar.hy);
  }
  let d = Infinity;
  for (const p of h.parts) {
    const e = pillDistance(x, y, p);
    if (d === Infinity) {
      d = e;
      continue;
    }
    const k = Math.min(1, Math.max(0, 0.5 + (0.5 * (d - e)) / h.blend));
    d = d * (1 - k) + e * k - h.blend * k * (1 - k);
  }
  return d;
}

/** Direction qui sort de la place réservée (gradient de la distance, par différences finies). */
function holeGradient(x: number, y: number, h: Hole): Point {
  const eps = h.band * 0.05 + 1e-3;
  const gx = holeDistance(x + eps, y, h) - holeDistance(x - eps, y, h);
  const gy = holeDistance(x, y + eps, h) - holeDistance(x, y - eps, h);
  const len = Math.hypot(gx, gy);
  if (len > 1e-12) return { x: gx / len, y: gy / len };
  // Pile au centre d'une pilule : on sort par le haut ou le bas.
  return { x: 0, y: 1 };
}

/**
 * Distance du centre au bord extérieur de la bande libre, dans la direction (dx, dy) (unitaire). À côté
 * du titre, le rayon peut sortir de la bande puis y rentrer (le creux du raccord) : on cherche d'abord,
 * depuis l'extérieur, le dernier passage, puis on l'affine.
 */
function holeReach(h: Hole, dx: number, dy: number): number {
  let far = h.band + h.blend + 1;
  for (const p of h.parts) far = Math.max(far, Math.hypot(Math.abs(p.cx - h.cx) + p.hx, Math.abs(p.cy - h.cy) + p.hy) + h.band + h.blend + 1);
  const inBand = (u: number) => holeDistance(h.cx + dx * u, h.cy + dy * u, h) < h.band;
  const stride = Math.max(h.band * 0.5, far / 80);
  let hi = far;
  let lo = hi - stride;
  while (lo > 0 && !inBand(lo)) {
    hi = lo;
    lo -= stride;
  }
  lo = Math.max(lo, 0);
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (holeDistance(h.cx + dx * mid, h.cy + dy * mid, h) < h.band) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Place d'une note dans la couronne, à partir de sa place `p` dans la forme naturelle. */
function ringPlace(h: Hole, p: Point, id: string): Point {
  let dx = p.x - h.cx;
  let dy = p.y - h.cy;
  const rho = Math.hypot(dx, dy);
  if (rho > 1e-6) {
    dx /= rho;
    dy /= rho;
  } else {
    // Note pile au centre : une direction propre à elle, stable.
    const a = hash01(id) * 2 * Math.PI;
    dx = Math.cos(a);
    dy = Math.sin(a);
  }
  const reach = holeReach(h, dx, dy);
  const out = (reach ** RING_EXPONENT + rho ** RING_EXPONENT) ** (1 / RING_EXPONENT);
  return { x: h.cx + dx * out, y: h.cy + dy * out };
}

export class GraphPhysics {
  private sim: Simulation<Body, SimulationLinkDatum<Body>>;
  private bodies = new Map<string, Body>();
  private raf = 0;
  private dragged: Body | null = null;
  /** Place réservée au centre (titre et barre de recherche) : aucun point n'y entre. */
  private hole: Hole | null = null;
  /** Forme naturelle dont la couronne est tirée (place de chaque note hors couronne). */
  private natural = new Map<Body, Point>();
  /** Formation de la couronne : la place réservée grandit pas à pas jusqu'à sa taille réelle. */
  private ringGrow: { from: Hole; to: Hole; ticks: number } | null = null;
  /** Place de chaque note dans la couronne au repos (null hors de l'accueil). */
  private anchors: Map<Body, Point> | null = null;
  /** Changement de forme en cours : la place visée par chaque point, puis la forme à appliquer à l'arrivée. */
  private pull: { to: Map<Body, Point & { k: number }>; ticks: number; then?: () => void } | null = null;
  /** Répulsion et anti-chevauchement : les forces coûteuses, suspendues pendant un changement de forme. */
  private charge: ReturnType<typeof forceManyBody<Body>>;
  private collide: ReturnType<typeof forceCollide<Body>>;
  private link: ReturnType<typeof forceLink<Body, SimulationLinkDatum<Body>>> | null = null;
  /** Appelé à chaque image (pour les animations de fondu qui dépendent du temps). */
  onFrame: (() => void) | null = null;

  constructor(
    private graph: Graph,
    private opts: PhysicsOptions = {},
  ) {
    this.charge = forceManyBody<Body>().strength(opts.charge ?? FORCES.charge).distanceMax(FORCES.chargeDistanceMax).theta(FORCES.theta);
    this.collide = forceCollide<Body>(opts.collideRadius ?? FORCES.collideRadius).strength(FORCES.collideStrength);
    this.sim = forceSimulation<Body>([])
      .alpha(0)
      .alphaDecay(FORCES.alphaDecay)
      .velocityDecay(FORCES.velocityDecay)
      .force("charge", this.charge)
      .force("collide", this.collide)
      .force("x", forceX<Body>(0).strength(opts.gravity ?? FORCES.gravity))
      .force("y", forceY<Body>(0).strength(opts.gravity ?? FORCES.gravity))
      .force("pull", () => this.pullForce())
      .stop();
    this.load();
    this.loop();
  }

  /**
   * Contrainte ferme : un point entré dans la place réservée (en la traversant, ou lâché dedans) est
   * reposé sur son bord.
   */
  private projectOutOfHole(): void {
    const h = this.hole;
    if (!h) return;
    for (const b of this.bodies.values()) {
      if (b === this.dragged) continue;
      let sd = holeDistance(b.x!, b.y!, h);
      if (sd >= 0) continue;
      // Le raccord adoucit la distance : quelques pas le long du gradient suffisent pour ressortir.
      // Pendant un trajet (la place grandit, les notes rejoignent leur place), une note en retard est
      // poussée peu à peu, sans saut.
      const cap = this.pull ? h.band * 0.25 : Infinity;
      for (let i = 0; i < 4 && sd < 0; i++) {
        const g = holeGradient(b.x!, b.y!, h);
        const step = Math.min(0.5 - sd, cap);
        b.x! += g.x * step;
        b.y! += g.y * step;
        if (step === cap) break;
        sd = holeDistance(b.x!, b.y!, h);
      }
      b.vx! *= 0.5;
      b.vy! *= 0.5;
    }
  }

  /**
   * Réserve la place du titre et de la barre de recherche : le graphe s'organise en couronne autour.
   * Chaque note part de sa place dans la forme naturelle (`natural`) et s'écarte du centre. `spread`
   * fait grandir la place réservée depuis le centre, comme un ballon qu'on gonfle.
   */
  setObstacle(zones: Obstacle[], natural: Map<string, Point>, opts: { spread: boolean }): void {
    const to = holeOf(zones);
    this.natural = new Map();
    for (const [id, p] of natural) {
      const b = this.bodies.get(id);
      if (b) this.natural.set(b, p);
    }
    if (this.ringGrow) {
      // Remesurée (police chargée, fenêtre redimensionnée) pendant qu'elle grandit.
      this.ringGrow.to = to;
      return;
    }
    const from = opts.spread ? shrinkHole(to, GROW_FROM) : (this.hole ?? to);
    if (this.pull && !this.hole) {
      // Pendant un changement de forme, la couronne ne se forme qu'à l'arrivée.
      this.pull.then = () => this.formRing(from, to);
      return;
    }
    this.formRing(from, to);
  }

  /** Tire chaque note vers sa place dans la couronne, pendant que la place réservée passe de `from` à `to`. */
  private formRing(from: Hole, to: Hole): void {
    this.releaseShape();
    this.hole = from;
    this.ringGrow = sameHole(from, to) ? null : { from, to, ticks: 0 };
    const targets = new Map<Body, Point & { k: number }>();
    for (const [b, p] of this.natural) targets.set(b, { ...ringPlace(from, p, b.id), k: PULL_STRENGTH * stiffness(b.id) });
    this.suspendForces();
    this.pull = { to: targets, ticks: 0, then: () => this.settleRing() };
    this.sim.alpha(Math.max(this.sim.alpha(), PULL_ALPHA));
  }

  /** Fait grandir la place réservée d'un pas (courbe douce) et déplace les places visées avec elle. */
  private stepGrowth(): void {
    const g = this.ringGrow;
    if (!g) return;
    const t = Math.min(1, ++g.ticks / GROW_TICKS);
    this.hole = mixHole(g.from, g.to, t * t * (3 - 2 * t));
    if (this.pull) {
      for (const [b, target] of this.pull.to) {
        const p = this.natural.get(b);
        if (p) Object.assign(target, ringPlace(this.hole, p, b.id));
      }
    }
    if (t === 1) this.ringGrow = null;
  }

  /** Couronne formée : chaque note est retenue à sa place, et les liens y sont au repos. */
  private settleRing(): void {
    const h = this.hole;
    if (!h) return;
    const anchors = new Map<Body, Point>();
    for (const [b, p] of this.natural) anchors.set(b, ringPlace(h, p, b.id));
    this.anchors = anchors;
    const strength = (b: Body) => (anchors.has(b) ? RING_ANCHOR : 0);
    this.sim.force("x", forceX<Body>((b) => anchors.get(b)?.x ?? 0).strength(strength));
    this.sim.force("y", forceY<Body>((b) => anchors.get(b)?.y ?? 0).strength(strength));
    this.applyLinkDistances();
  }

  /**
   * Longueur de repos des liens : celle de la forme naturelle, ou dans la couronne la distance entre les
   * deux notes (étirés d'un bord à l'autre du titre, ils ramèneraient sinon les notes contre le bord).
   */
  private applyLinkDistances(): void {
    const base = this.opts.linkDistance ?? FORCES.linkDistance;
    const anchors = this.anchors;
    this.link?.distance(
      anchors
        ? (l) => {
            const a = anchors.get(l.source as Body);
            const c = anchors.get(l.target as Body);
            return a && c ? Math.max(base, Math.hypot(a.x - c.x, a.y - c.y)) : base;
          }
        : base,
    );
  }

  /** La couronne est-elle encore en train de se former ? */
  get forming(): boolean {
    return this.ringGrow !== null;
  }

  /** Forme naturelle : plus de place réservée, le graphe est attiré vers son centre. */
  useNaturalShape(): void {
    this.releaseShape();
    const gravity = this.opts.gravity ?? FORCES.gravity;
    this.sim.force("x", forceX<Body>(0).strength(gravity));
    this.sim.force("y", forceY<Body>(0).strength(gravity));
  }

  /** Retire les forces qui donnent sa forme au graphe (couronne ou attraction vers le centre). */
  private releaseShape(): void {
    this.ringGrow = null;
    this.hole = null;
    this.anchors = null;
    this.sim.force("x", null);
    this.sim.force("y", null);
    this.applyLinkDistances();
  }

  /**
   * Pendant un trajet, chaque note a sa place d'arrivée : les autres forces sont suspendues. Les liens,
   * surtout, sont très étirés dans la couronne : laissés actifs, ils se rétractent d'un coup comme des
   * élastiques et projettent les notes. Sans répulsion globale, chaque image se calcule aussi plus vite.
   */
  private suspendForces(): void {
    this.sim.force("charge", null);
    this.sim.force("collide", null);
    this.sim.force("link", null);
  }

  /**
   * Change la forme du graphe : chaque point de `targets` est tiré vers sa place par un ressort (les
   * autres suivent par leurs liens), puis `then` applique les forces de la nouvelle forme.
   */
  pullTo(targets: Map<string, Point>, then?: () => void): void {
    const to = new Map<Body, Point & { k: number }>();
    for (const [id, p] of targets) {
      const b = this.bodies.get(id);
      if (b) to.set(b, { x: p.x, y: p.y, k: PULL_STRENGTH * stiffness(id) });
    }
    this.releaseShape();
    this.suspendForces();
    this.pull = { to, ticks: 0, then };
    this.sim.alpha(Math.max(this.sim.alpha(), PULL_ALPHA));
  }

  private pullForce(): void {
    const pull = this.pull;
    if (!pull) return;
    const ramp = Math.min(1, (pull.ticks + 1) / PULL_RAMP_TICKS) ** 2;
    for (const [b, p] of pull.to) {
      if (b === this.dragged) continue;
      b.vx! += (p.x - b.x!) * p.k * ramp;
      b.vy! += (p.y - b.y!) * p.k * ramp;
    }
  }

  /** Après chaque pas : le changement de forme se termine et cède la place aux forces de la forme. */
  private advancePull(): void {
    const p = this.pull;
    if (!p) return;
    p.ticks++;
    // Le trajet ne se termine qu'une fois la couronne formée et chaque note arrivée.
    if (p.ticks < PULL_MAX_TICKS) {
      if (this.ringGrow) return;
      for (const [b, t] of p.to) {
        if (b !== this.dragged && Math.abs(t.x - b.x!) + Math.abs(t.y - b.y!) > PULL_ARRIVED) return;
      }
    }
    this.pull = null;
    this.ringGrow = null;
    this.sim.force("charge", this.charge);
    this.sim.force("collide", this.collide);
    this.sim.force("link", this.link);
    // Les notes sont arrivées : il ne reste qu'à les laisser se poser.
    this.sim.alpha(Math.min(this.sim.alpha(), 0.02));
    p.then?.();
  }

  /** Place d'un point, ou celle vers laquelle il est tiré (pour y diriger la caméra sans attendre). */
  positionOf(id: string): Point | null {
    const b = this.bodies.get(id);
    if (!b) return null;
    const p = this.pull?.to.get(b) ?? b;
    return { x: p.x!, y: p.y! };
  }

  /** Photographie la forme du graphe (les places d'arrivée si un glissement est en cours). */
  snapshot(): Map<string, Point> {
    const shot = new Map<string, Point>();
    for (const id of this.bodies.keys()) shot.set(id, this.positionOf(id)!);
    return shot;
  }

  /** (Re)lit le graphe : les points déjà connus gardent leur position et leur élan. */
  load(): void {
    const next = new Map<string, Body>();
    this.graph.forEachNode((id, a) => {
      next.set(id, this.bodies.get(id) ?? { id, x: a.x, y: a.y, vx: 0, vy: 0 });
    });
    const added = [...next.keys()].some((id) => !this.bodies.has(id)) && this.bodies.size > 0;
    this.bodies = next;
    const links: Array<SimulationLinkDatum<Body>> = [];
    this.graph.forEachEdge((_e, _a, s, t) => {
      const source = next.get(s);
      const target = next.get(t);
      if (source && target) links.push({ source, target });
    });
    this.sim.nodes([...next.values()]);
    this.link = forceLink<Body, SimulationLinkDatum<Body>>(links).strength(this.opts.linkStrength ?? FORCES.linkStrength);
    this.applyLinkDistances();
    // Pendant un changement de forme, les liens restent suspendus jusqu'à l'arrivée.
    this.sim.force("link", this.pull ? null : this.link);
    // Une note ajoutée (le soir, par Claude) trouve sa place en douceur ; sinon rien ne bouge.
    if (added) this.sim.alpha(Math.max(this.sim.alpha(), 0.1));
  }

  /** Un pas de calcul. */
  private step(): void {
    this.stepGrowth();
    this.sim.tick();
    this.advancePull();
    this.projectOutOfHole();
  }

  /** Quelque chose bouge-t-il encore ? */
  private get active(): boolean {
    return this.ringGrow !== null || this.pull !== null || this.dragged !== null || this.sim.alpha() >= this.sim.alphaMin();
  }

  /** Boucle d'animation : la simulation ne calcule que tant que quelque chose bouge. */
  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    if (this.active) {
      this.step();
      this.writePositions();
    }
    this.onFrame?.();
  };

  private writePositions(): void {
    this.graph.updateEachNodeAttributes(
      (id, attrs) => {
        const b = this.bodies.get(id);
        if (b) {
          attrs.x = b.x;
          attrs.y = b.y;
        }
        return attrs;
      },
      { attributes: ["x", "y"] },
    );
  }

  /** Calcule quelques pas d'avance, hors écran, pour afficher directement une forme posée. */
  warmup(ticks: number): void {
    this.sim.alpha(1);
    for (let i = 0; i < ticks; i++) {
      this.sim.tick();
      this.projectOutOfHole();
    }
    this.sim.alpha(0);
    this.writePositions();
  }

  grab(id: string, x: number, y: number): void {
    const b = this.bodies.get(id);
    if (!b) return;
    this.dragged = b;
    this.sim.alphaTarget(DRAG_ALPHA);
    this.sim.alpha(Math.max(this.sim.alpha(), DRAG_ALPHA));
    this.move(x, y);
  }

  /** La note tenue se place immédiatement sous le pointeur, sans attendre le prochain pas de calcul. */
  move(x: number, y: number): void {
    const b = this.dragged;
    if (!b) return;
    b.fx = b.x = x;
    b.fy = b.y = y;
    this.graph.mergeNodeAttributes(b.id, { x, y });
  }

  release(): void {
    if (!this.dragged) return;
    this.dragged.fx = null;
    this.dragged.fy = null;
    this.dragged = null;
    this.sim.alphaTarget(0);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.sim.stop();
  }
}

/**
 * Cadre fixe à la forme de l'écran (`aspect` = hauteur / largeur), `scale` fois la hauteur du graphe :
 * le graphe, une fois écarté autour de la zone réservée, remplit tout l'écran. Calculé sur la forme
 * naturelle (`points`), pour ne pas dépendre de la forme du moment quand on redimensionne la fenêtre.
 */
export function frameToScreen(renderer: Sigma, points: Iterable<Point>, aspect: number, scale: number): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return;
  let h = (maxY - minY || 1) * scale;
  let w = h / aspect;
  if ((maxX - minX) * scale > w) {
    w = (maxX - minX) * scale;
    h = w * aspect;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  renderer.setCustomBBox({ x: [cx - w / 2, cx + w / 2], y: [cy - h / 2, cy + h / 2] });
}

/** Cadre fixe pour Sigma : sans lui, le graphe se recadrerait à chaque mouvement d'un point. */
export function freezeFrame(renderer: Sigma, graph: Graph, margin = 0.06): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  graph.forEachNode((_id, a) => {
    minX = Math.min(minX, a.x);
    maxX = Math.max(maxX, a.x);
    minY = Math.min(minY, a.y);
    maxY = Math.max(maxY, a.y);
  });
  if (!Number.isFinite(minX)) return;
  const padX = (maxX - minX || 1) * margin;
  const padY = (maxY - minY || 1) * margin;
  renderer.setCustomBBox({ x: [minX - padX, maxX + padX], y: [minY - padY, maxY + padY] });
}

/**
 * Glisser-déposer des points, à la souris comme au doigt. Le mouvement est suivi sur toute la
 * fenêtre : la note reste accrochée même quand le pointeur passe au-dessus de la barre de
 * recherche ou d'un bouton. Un vrai glissement n'ouvre pas la note (`wasDrag()`).
 */
export function enableDrag(
  renderer: Sigma,
  physics: Pick<GraphPhysics, "grab" | "move" | "release">,
  hooks: { onStart?: (id: string) => void; onEnd?: () => void } = {},
): { wasDrag(): boolean; dispose(): void } {
  const container = renderer.getContainer();
  const camera = renderer.getCamera() as unknown as { enable?: () => void; disable?: () => void };
  let drag: { x: number; y: number; moved: boolean } | null = null;
  let lastWasDrag = false;

  const toGraph = (clientX: number, clientY: number) => {
    const rect = container.getBoundingClientRect();
    return renderer.viewportToGraph({ x: clientX - rect.left, y: clientY - rect.top });
  };

  const onMove = (ev: PointerEvent) => {
    if (!drag) return;
    const rect = container.getBoundingClientRect();
    if (Math.hypot(ev.clientX - rect.left - drag.x, ev.clientY - rect.top - drag.y) > 4) drag.moved = true;
    const p = toGraph(ev.clientX, ev.clientY);
    physics.move(p.x, p.y);
    ev.preventDefault();
  };

  const release = () => {
    if (!drag) return;
    lastWasDrag = drag.moved;
    drag = null;
    physics.release();
    camera.enable?.();
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", onMove);
    hooks.onEnd?.();
  };

  renderer.on("downNode", (e) => {
    drag = { x: e.event.x, y: e.event.y, moved: false };
    const p = renderer.viewportToGraph(e.event);
    physics.grab(e.node, p.x, p.y);
    camera.disable?.();
    // Main fermée sur toute la page : on « tient » la note, même quand le pointeur la devance.
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    window.addEventListener("pointermove", onMove, { passive: false });
    hooks.onStart?.(e.node);
    e.preventSigmaDefault();
  });
  // Pendant un glissement, Sigma ne doit pas déplacer la caméra.
  renderer.on("moveBody", (e) => {
    if (drag) e.preventSigmaDefault();
  });
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", release);

  return {
    wasDrag() {
      const was = lastWasDrag;
      lastWasDrag = false;
      return was;
    },
    dispose() {
      release();
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    },
  };
}

/** Mélange deux couleurs hexadécimales (t = 0 → a, t = 1 → b). */
export function mixColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}
