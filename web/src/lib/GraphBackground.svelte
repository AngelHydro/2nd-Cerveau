<script lang="ts">
  import Graph from "graphology";
  import Sigma from "sigma";
  import { onMount } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { DEFAULT_NODE_COLOR, type GraphPayload } from "./api";
  import { GraphPhysics, enableDrag, frameToScreen, mixColor, steadyTween, type Obstacle, type Point } from "./physics";
  import { LABEL_FONT, drawHover, drawLabel } from "./sigmaStyle";

  interface Props {
    data: GraphPayload | null;
    selectedId: string | null;
    showUnresolved: boolean;
    /** Largeur (px) cachée à droite par le panneau de lecture : la caméra centre dans l'espace restant. */
    occludedRight: number;
    /** Notes à garder pendant une recherche (null = tout le graphe) ; les autres disparaissent en fondu. */
    matches: string[] | null;
    /** Un panneau autre qu'une note (le tableau de bord) est ouvert : le graphe quitte l'accueil. */
    panel: boolean;
    /** Groupes de couleur masqués par la légende (indices de `GraphPayload.groups`, -1 = sans groupe). */
    hiddenGroups: Set<number>;
    /** Chemin entre deux notes à mettre en valeur (du départ à l'arrivée). */
    path: string[] | null;
    onselect: (id: string) => void;
    /** Maj+clic sur deux notes : demande le chemin qui les relie. */
    onpathpick: (from: string, to: string) => void;
  }
  let { data, selectedId, showUnresolved, occludedRight, matches, panel, hiddenGroups, path, onselect, onpathpick }: Props = $props();

  /** Hors de l'accueil (note ouverte ou tableau de bord) : la barre est dans le coin, la caméra est libre. */
  const away = $derived(selectedId !== null || panel);

  const BG = "#1c2127";
  const EDGE = "#373d46";
  /** Couleur d'accent du thème Things, comme les liens allumés au survol dans Obsidian. */
  const EDGE_HOT = "#79a9ec";

  let container: HTMLDivElement;
  let renderer: Sigma | null = null;
  let physics: GraphPhysics | null = null;
  let framed = false;
  const graph = new Graph({ type: "undirected", allowSelfLoops: false });

  // Survol animé : `focus` reste la note survolée pendant tout le fondu de sortie.
  let focus: string | null = null;
  let focusNeighbors = new Set<string>();
  let hovering = false;
  let fade = 0;
  /** Éteint le survol en fondu (sauf pendant qu'on tient une note). */
  let dropHover: (() => void) | null = null;

  // Note ouverte mise en avant : elle et ses voisines restent vives, le reste s'assombrit. `spot` reste
  // la note ouverte pendant tout le fondu de sortie.
  let spot: string | null = null;
  let spotNeighbors = new Set<string>();
  let spotFade = 0;

  // Filtre de recherche animé : `kept` reste en place pendant le fondu de retour.
  let kept: Set<string> | null = null;
  let filtering = false;
  let filterFade = 0;
  /** Au-delà, on n'affiche plus tous les noms des notes gardées (trop chargé). */
  const MAX_FILTER_LABELS = 40;

  // Chemin entre deux notes : `shownPath` reste en place pendant le fondu de sortie.
  let shownPath: Set<string> | null = null;
  /** Liens du chemin, dans les deux sens. */
  let pathEdges = new Set<string>();
  let pathFade = 0;
  /** Départ choisi par un premier Maj+clic, en attente de l'arrivée. */
  let pathStart: string | null = null;
  const edgeKey = (a: string, b: string) => `${a}\u0000${b}`;

  /** Met le graphe à jour sans le recréer : les points existants gardent leur position et leur élan. */
  function sync(payload: GraphPayload) {
    const keep = new Set(payload.nodes.map((n) => n.id));
    serverPos.clear();
    for (const n of payload.nodes) serverPos.set(n.id, { x: n.x, y: n.y });
    graph.forEachNode((id) => {
      if (!keep.has(id)) graph.dropNode(id);
    });
    for (const n of payload.nodes) {
      const attrs = { label: n.label, color: n.color, size: n.size, group: n.group, unresolved: Boolean(n.unresolved) };
      if (graph.hasNode(n.id)) graph.mergeNodeAttributes(n.id, attrs);
      else graph.addNode(n.id, { ...attrs, x: n.x, y: n.y });
    }
    graph.clearEdges();
    for (const [a, b] of payload.edges) {
      const s = payload.nodes[a].id;
      const t = payload.nodes[b].id;
      if (s !== t && !graph.hasEdge(s, t)) graph.addEdge(s, t);
    }
    physics?.load();
    if (renderer && !framed && container.clientWidth) {
      framed = true;
      frameGraph();
      formRing();
    }
  }

  // Réglages mesurés sur le vrai coffre : le graphe écarté autour du centre remplit ~90 % de l'écran.
  const FRAME_SCALE = 1.3;
  /** L'écartement initial (« ballon qu'on gonfle ») ne se fait qu'une fois. */
  let spread = false;

  // Deux formes du graphe : la couronne autour du titre et de la barre (accueil) et la forme naturelle
  // (lecture, barre dans le coin). Chacune est photographiée en la quittant, pour y revenir à l'identique.
  /** Glissement de caméra : à peu près le temps que met le graphe à changer de forme. */
  const GLIDE_MS = 1400;
  let atHome = true;
  let ringPos: Map<string, Point> | null = null;
  /** Forme naturelle ; par défaut la disposition calculée par le serveur (`serverPos`). */
  let naturalPos: Map<string, Point> | null = null;
  const serverPos = new Map<string, Point>();
  /** Numéro de l'attente en cours de la fin du glissement de la barre (l'incrémenter l'annule). */
  let settleToken = 0;

  const screenAspect = () => Math.min(1.6, Math.max(0.35, container.clientHeight / container.clientWidth));

  /** Taille de l'écran pour laquelle le cadre a été posé : on recadre quand elle change. */
  let framedSize = "";
  const screenSize = () => `${container.clientWidth}x${container.clientHeight}`;

  /** Cadre à la forme de l'écran : le graphe s'y étire en couronne autour de la recherche. */
  function frameGraph() {
    if (!renderer) return;
    frameToScreen(renderer, serverPos.values(), screenAspect(), FRAME_SCALE);
    framedSize = screenSize();
  }

  /**
   * Fenêtre redimensionnée : nouveau cadre à la forme de l'écran. À l'accueil, la couronne se replie sur
   * la forme naturelle puis se reforme autour de la nouvelle zone du titre et de la barre (la déformer
   * sur place pousserait des notes en traînées).
   */
  function reframe() {
    if (!renderer || !physics || !framed || screenSize() === framedSize) return;
    frameGraph();
    renderer.refresh();
    if (atHome) {
      ringPos = null;
      spread = false;
      // La barre se recentre en glissant : on mesure sa zone une fois arrivée (en plein trajet, la
      // couronne se décalerait d'un côté).
      physics.pullTo(naturalTargets(), () => whenSearchSettled(reserveCenter));
      if (filtering && kept) fitTo(kept);
    } else {
      // La couronne mémorisée ne correspond plus à cet écran : elle se reformera au retour à l'accueil.
      ringPos = null;
      spread = false;
      if (selectedId) focusNode(selectedId);
    }
  }

  /**
   * Réserve le centre de l'écran (titre + barre de recherche) : les points s'organisent autour et
   * n'y passent jamais, comme les mots de learn-anything. La zone est mesurée à l'écran puis
   * convertie en coordonnées du graphe pour la vue d'ensemble (caméra au repos) ; la couronne est
   * tirée de la forme naturelle, écartée autour d'elle.
   */
  function reserveCenter() {
    if (!renderer || !physics || !graph.order || !container.clientWidth || !atHome) return;
    renderer.refresh(); // prend en compte le cadre fixé juste avant
    const home = screenZone();
    if (!home) return;
    physics.setObstacle(home, naturalTargets(), { spread: !spread });
    spread = true;
  }

  /**
   * Couronne de l'accueil, mesurée une fois la barre posée : si l'écran prend sa taille après le
   * chargement (onglet masqué, fenêtre agrandie), la barre glisse jusqu'au centre et la mesurer en
   * route décalerait toute la couronne. Remesurée aussi quand la police du titre arrive.
   */
  function formRing() {
    whenSearchSettled(reserveCenter);
  }

  /** Lecture : la barre part dans le coin, le graphe se déroule vers sa forme naturelle. */
  function leaveHome() {
    if (!physics) return;
    settleToken++;
    if (physics.forming) {
      // Couronne encore en formation : on ne la garde pas à moitié, elle se reformera au retour.
      ringPos = null;
      spread = false;
    } else if (spread) ringPos = physics.snapshot();
    const p = physics;
    p.pullTo(naturalTargets(), () => p.useNaturalShape());
  }

  /** Place de chaque note dans la forme naturelle (la dernière connue, sinon celle calculée par le serveur). */
  function naturalTargets(): Map<string, Point> {
    const targets = new Map<string, Point>();
    graph.forEachNode((id) => {
      const p = naturalPos?.get(id) ?? serverPos.get(id);
      if (p) targets.set(id, p);
    });
    return targets;
  }

  /** Retour à l'accueil : le graphe se réenroule en couronne autour du titre et de la barre. */
  function returnHome() {
    if (!physics) return;
    naturalPos = physics.snapshot();
    // Chaque note regagne sa place dans la couronne (celles apparues pendant la lecture suivent leurs
    // liens). Une fois la barre revenue au centre, on remesure sa zone ; elle s'applique à l'arrivée.
    // Si l'application s'est ouverte directement sur une note, la couronne se forme pour la première fois.
    if (ringPos) physics.pullTo(ringPos);
    whenSearchSettled(reserveCenter);
  }

  /**
   * Attend la fin des animations de la barre de recherche et du titre (mesurer pendant leur trajet
   * donnerait une zone fausse). Une nouvelle attente, ou un départ en lecture, annule la précédente.
   */
  function whenSearchSettled(fn: () => void) {
    const token = ++settleToken;
    const anims = document.querySelector(".search")?.getAnimations({ subtree: true }) ?? [];
    void Promise.allSettled(anims.map((a) => a.finished)).then(() => {
      if (token === settleToken) fn();
    });
  }

  /**
   * Empreintes du titre et de la barre dans le graphe, chacune ajustée à sa forme (le titre est plus
   * étroit que la barre : les notes peuvent occuper les coins à côté de lui), pour la vue d'accueil
   * (caméra au repos). `null` pendant la lecture (la barre est réduite dans un coin).
   */
  function screenZone(): Obstacle[] | null {
    if (!renderer) return null;
    const search = document.querySelector<HTMLElement>(".search:not(.compact)");
    const box = search?.querySelector(".box")?.getBoundingClientRect();
    const brand = search?.querySelector(".brand");
    if (!box || !brand) return null;
    // Les lignes du titre s'étendent sur toute la largeur de la barre : on mesure le texte lui-même,
    // ligne par ligne (mesurer le bloc entier renverrait la largeur de ses paragraphes).
    const lines = [...brand.children].map((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      return range.getBoundingClientRect();
    });
    const title = new DOMRect(
      Math.min(...lines.map((r) => r.left)),
      Math.min(...lines.map((r) => r.top)),
      Math.max(...lines.map((r) => r.right)) - Math.min(...lines.map((r) => r.left)),
      Math.max(...lines.map((r) => r.bottom)) - Math.min(...lines.map((r) => r.top)),
    );
    const c = container.getBoundingClientRect();
    const pad = 36;
    const camera = { cameraState: { x: 0.5, y: 0.5, ratio: 1, angle: 0 } };
    const zoneOf = (r: DOMRect): Obstacle => {
      const a = renderer!.viewportToGraph({ x: r.left - pad - c.left, y: r.top - pad - c.top }, camera);
      const b = renderer!.viewportToGraph({ x: r.right + pad - c.left, y: r.bottom + pad - c.top }, camera);
      return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, rx: Math.abs(b.x - a.x) / 2, ry: Math.abs(b.y - a.y) / 2 };
    };
    return [zoneOf(title), zoneOf(box)];
  }

  /** Notes à créer (si masquées) et groupes masqués par la légende ; jamais la note ouverte ni le chemin. */
  const hiddenNode = (id: string) => {
    if (id === selectedId || shownPath?.has(id)) return false;
    const attrs = graph.getNodeAttributes(id);
    return attrs.unresolved ? !showUnresolved : hiddenGroups.has(attrs.group);
  };

  onMount(() => {
    renderer = new Sigma(graph, container, {
      labelFont: LABEL_FONT,
      labelSize: 12,
      labelWeight: "500",
      labelColor: { color: "#b7bec7" },
      // Comme Obsidian : aucun nom au repos, ils apparaissent en zoomant.
      labelRenderedSizeThreshold: 13,
      labelDensity: 0.4,
      labelGridCellSize: 120,
      defaultEdgeColor: EDGE,
      defaultNodeColor: DEFAULT_NODE_COLOR,
      minCameraRatio: 0.02,
      maxCameraRatio: 4,
      stagePadding: 60,
      zIndex: true,
      allowInvalidContainer: true,
      enableCameraRotation: false,
      defaultDrawNodeHover: drawHover as never,
      defaultDrawNodeLabel: drawLabel as never,
      nodeReducer: (node, attrs) => {
        // Sur petit écran, des points plus fins laissent respirer le graphe.
        const res: Record<string, unknown> = { ...attrs, size: attrs.size * (container.clientWidth < 768 ? 0.65 : 1) };
        if (hiddenNode(node)) return { ...res, hidden: true };
        // Recherche : les notes hors sujet s'effacent en fondu, puis disparaissent vraiment.
        const ff = cubicOut(filterFade);
        if (kept && ff > 0) {
          if (!kept.has(node)) {
            if (ff > 0.97) return { ...res, hidden: true };
            Object.assign(res, { color: mixColor(attrs.color, BG, ff), label: "", zIndex: 0 });
          } else Object.assign(res, { forceLabel: kept.size <= MAX_FILTER_LABELS && ff > 0.4, zIndex: 2 });
        }
        // Survol et note ouverte : la note et ses voisines restent vives, le reste s'assombrit (le plus
        // fort des deux fondus l'emporte, pour passer de l'un à l'autre sans à-coup).
        const f = cubicOut(fade);
        const s = cubicOut(spotFade);
        // Un chemin affiché prend le pas sur la mise en avant de la note ouverte.
        const pf = cubicOut(pathFade);
        const onPath = shownPath?.has(node) ?? false;
        const hoverDim = focus && f > 0 && node !== focus && !focusNeighbors.has(node) ? 0.72 * f : 0;
        // Le survol remplace la mise en avant de la note ouverte (sinon deux voisinages s'allument).
        const spotDim = spot && s > 0 && node !== spot && !spotNeighbors.has(node) ? 0.72 * s * (1 - pf) * (1 - f) : 0;
        const pathDim = shownPath && pf > 0 && !onPath ? 0.8 * pf : 0;
        const dim = Math.max(hoverDim, spotDim, pathDim);
        if (dim > 0) Object.assign(res, { color: mixColor(attrs.color, BG, dim), label: "", zIndex: 0 });
        else if ((focus && f > 0 && focusNeighbors.has(node)) || (spot && s > 0 && spotNeighbors.has(node))) Object.assign(res, { zIndex: 2 });
        // Seul le nom de la note survolée s'affiche (et celui de la note ouverte).
        if (focus && f > 0 && node !== focus) res.label = "";
        if (focus && f > 0 && node === focus) Object.assign(res, { highlighted: hovering, size: (res.size as number) * (1 + 0.3 * f), zIndex: 3 });
        if (onPath && pf > 0) Object.assign(res, { forceLabel: pf > 0.4, zIndex: 3 });
        if (node === selectedId || node === pathStart) Object.assign(res, { highlighted: true, forceLabel: true, zIndex: 3 });
        return res;
      },
      edgeReducer: (edge, attrs) => {
        const res: Record<string, unknown> = { ...attrs };
        const [s, t] = graph.extremities(edge);
        if (hiddenNode(s) || hiddenNode(t)) return { ...res, hidden: true };
        const ff = cubicOut(filterFade);
        if (kept && ff > 0 && !(kept.has(s) && kept.has(t))) {
          if (ff > 0.97) return { ...res, hidden: true };
          res.color = mixColor(EDGE, BG, ff);
        }
        // Les liens de la note survolée ou ouverte s'allument ; les autres s'estompent.
        const f = cubicOut(fade);
        const pf = cubicOut(pathFade);
        const sp = cubicOut(spotFade) * (1 - pf) * (1 - f);
        const onPath = pathEdges.has(edgeKey(s, t));
        const hot = Math.max(focus && (s === focus || t === focus) ? f : 0, spot && (s === spot || t === spot) ? sp : 0, onPath ? pf : 0);
        const dim = Math.max(
          focus && s !== focus && t !== focus ? 0.65 * f : 0,
          spot && s !== spot && t !== spot ? 0.65 * sp : 0,
          shownPath && !onPath ? 0.7 * pf : 0,
        );
        if (hot > 0) Object.assign(res, { color: mixColor(EDGE, EDGE_HOT, hot), size: 1 + 0.8 * hot, zIndex: 1 });
        else if (dim > 0) res.color = mixColor((res.color as string | undefined) ?? EDGE, BG, dim);
        return res;
      },
    });

    physics = new GraphPhysics(graph);
    if (graph.order && container.clientWidth) {
      framed = true;
      frameGraph();
      formRing();
    }
    physics.onFrame = () => {
      // Avance les fondus (survol, recherche) et ne redessine que s'ils bougent.
      let changed = false;
      const hoverTarget = hovering ? 1 : 0;
      if (fade !== hoverTarget) {
        fade += (hoverTarget - fade) * 0.16;
        if (Math.abs(hoverTarget - fade) < 0.01) fade = hoverTarget;
        if (fade === 0 && !hovering) focus = null;
        changed = true;
      }
      const spotTarget = selectedId ? 1 : 0;
      if (spotFade !== spotTarget) {
        spotFade += (spotTarget - spotFade) * 0.1;
        if (Math.abs(spotTarget - spotFade) < 0.01) spotFade = spotTarget;
        if (spotFade === 0 && !selectedId) spot = null;
        changed = true;
      }
      const pathTarget = path && path.length > 1 ? 1 : 0;
      if (pathFade !== pathTarget) {
        pathFade += (pathTarget - pathFade) * 0.1;
        if (Math.abs(pathTarget - pathFade) < 0.01) pathFade = pathTarget;
        if (pathFade === 0 && !pathTarget) {
          shownPath = null;
          pathEdges = new Set();
        }
        changed = true;
      }
      const filterTarget = filtering ? 1 : 0;
      if (filterFade !== filterTarget) {
        filterFade += (filterTarget - filterFade) * 0.1;
        if (Math.abs(filterTarget - filterFade) < 0.01) filterFade = filterTarget;
        if (filterFade === 0 && !filtering) kept = null;
        changed = true;
      }
      if (changed) renderer?.scheduleRefresh();
    };
    // Pendant un glissement, la note tenue reste « survolée » quoi que fasse le pointeur ;
    // au relâchement, on reprend l'état de survol réel suivi par Sigma.
    let held: string | null = null;
    let underPointer: string | null = null;
    const hoverNode = (node: string | null) => {
      if (node) {
        focus = node;
        focusNeighbors = new Set(graph.neighbors(node));
      }
      hovering = node !== null;
      container.style.cursor = node ? "grab" : "";
    };
    const drag = enableDrag(renderer, physics, {
      onStart: (id) => {
        held = id;
        hoverNode(id);
        container.style.cursor = "grabbing";
      },
      onEnd: () => {
        held = null;
        hoverNode(underPointer);
      },
    });
    dropHover = () => {
      if (!held) hoverNode(null);
    };

    // Le conteneur peut naître sans taille (onglet masqué, panneau réduit) : on recadre dès qu'il en a une.
    let sized = container.clientWidth > 0 && container.clientHeight > 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (!renderer || !container.clientWidth || !container.clientHeight) return;
      renderer.resize();
      if (!sized) {
        sized = true;
        renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
      }
      if (!framed && graph.order) {
        framed = true;
        frameGraph();
        formRing();
      }
      renderer.refresh();
      // On recadre une fois le geste de redimensionnement terminé (pas à chaque pixel).
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(reframe, 150);
    });
    observer.observe(container);
    // La police manuscrite arrive un instant après l'affichage et change un peu la hauteur du titre.
    void document.fonts?.ready.then(formRing);

    // À l'accueil, le graphe est un décor fixe autour de la recherche (comme learn-anything) : les
    // gestes de caméra (glisser le fond, molette, double-clic) sont ignorés, mais on survole, attrape
    // et ouvre toujours les notes. Pendant la lecture, la caméra redevient libre pour explorer.
    // (On filtre les gestes plutôt que de verrouiller la caméra : ses animations — recentrage,
    // cadrage d'une recherche — doivent continuer à fonctionner.)
    const lockAtHome = (e: { preventSigmaDefault(): void }) => {
      if (!away) e.preventSigmaDefault();
    };
    renderer.on("moveBody", lockAtHome);
    renderer.on("doubleClickStage", lockAtHome);
    renderer.on("doubleClickNode", lockAtHome);
    // La molette ne passe pas par là : Sigma 3 ignore `preventSigmaDefault` sur ses événements « wheel »
    // (il relit une copie de l'événement). On l'arrête donc avant qu'elle ne l'atteigne.
    // Pendant la lecture, un geste de l'utilisateur interrompt un glissement de caméra en cours.
    const blockWheel = (e: WheelEvent) => {
      if (away) {
        stopCamera?.();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onPointerDown = () => {
      if (away) stopCamera?.();
    };
    container.addEventListener("wheel", blockWheel, { capture: true, passive: false });
    container.addEventListener("pointerdown", onPointerDown, { capture: true });

    renderer.on("enterNode", ({ node }) => {
      underPointer = node;
      if (!held) hoverNode(node);
    });
    renderer.on("leaveNode", () => {
      underPointer = null;
      if (!held) hoverNode(null);
    });
    renderer.on("clickNode", ({ node, event }) => {
      if (drag.wasDrag() || graph.getNodeAttribute(node, "unresolved")) return;
      if ((event.original as MouseEvent).shiftKey) pickPath(node);
      else onselect(node);
    });
    // Maj+clic dans le vide ou Échap : on renonce au chemin commencé (Échap ne ferme alors pas la note).
    renderer.on("clickStage", ({ event }) => {
      if ((event.original as MouseEvent).shiftKey) cancelPathPick();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && cancelPathPick()) e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });

    return () => {
      settleToken++;
      stopCamera?.();
      clearTimeout(resizeTimer);
      container.removeEventListener("wheel", blockWheel, { capture: true });
      container.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
      observer.disconnect();
      drag.dispose();
      physics?.destroy();
      renderer?.kill();
      renderer = null;
      physics = null;
    };
  });

  /**
   * Glissement de caméra au pas régulier (un gel de la page le met en pause au lieu de le faire
   * sauter). Il démarre et freine en douceur, au rythme des notes tirées par leur ressort ; le zoom varie en
   * proportion, comme un travelling.
   */
  let stopCamera: (() => void) | null = null;
  function glideCamera(target: { x: number; y: number; ratio: number }) {
    if (!renderer) return;
    stopCamera?.();
    const camera = renderer.getCamera();
    const from = camera.getState();
    stopCamera = steadyTween(
      GLIDE_MS,
      (e) =>
        camera.setState({
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          ratio: from.ratio * (target.ratio / from.ratio) ** e,
          angle: 0,
        }),
      () => (stopCamera = null),
    );
  }

  /** Où la caméra doit viser : la place d'arrivée d'un point en train de glisser d'une forme à l'autre. */
  const placeOf = (id: string): Point => physics?.positionOf(id) ?? (graph.getNodeAttributes(id) as Point);

  /** Glisse jusqu'à la note, centrée dans la partie du graphe restée visible. */
  function focusNode(id: string) {
    if (!renderer || !graph.hasNode(id)) return;
    // Place du point (ou celle où il glisse), convertie dans le repère de la caméra.
    const display = renderer.viewportToFramedGraph(renderer.graphToViewport(placeOf(id)));
    const camera = renderer.getCamera();
    const target = Math.min(camera.ratio, 0.3);
    const { width, height } = renderer.getDimensions();
    const center = renderer.viewportToFramedGraph({ x: width / 2, y: height / 2 });
    const wanted = renderer.viewportToFramedGraph({ x: (width - occludedRight) / 2, y: height / 2 });
    const dx = (center.x - wanted.x) * (target / camera.ratio);
    glideCamera({ x: display.x + dx, y: display.y, ratio: target });
  }

  /**
   * Chemin par Maj+clic : le premier clic retient le départ (entouré), le second demande le chemin.
   * Recliquer le départ l'abandonne.
   */
  function pickPath(node: string) {
    if (!pathStart || pathStart === node) {
      pathStart = pathStart === node ? null : node;
      renderer?.scheduleRefresh();
      return;
    }
    const from = pathStart;
    pathStart = null;
    renderer?.scheduleRefresh();
    onpathpick(from, node);
  }

  /** Abandonne un chemin commencé ; vrai s'il y en avait un. */
  function cancelPathPick(): boolean {
    if (!pathStart) return false;
    pathStart = null;
    renderer?.scheduleRefresh();
    return true;
  }

  /**
   * Recadre en douceur sur un groupe de notes : sous la barre de recherche à l'accueil (`belowSearch`),
   * sinon au centre de la partie que le panneau laisse visible.
   */
  function fitTo(ids: Set<string>, belowSearch = true) {
    if (!renderer || !ids.size) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      if (!graph.hasNode(id)) continue;
      const p = renderer.viewportToFramedGraph(renderer.graphToViewport(placeOf(id)));
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return;
    // À l'accueil, les notes gardées se placent dans la moitié basse, sous la barre, pas derrière.
    const camera = renderer.getCamera();
    const extent = Math.max(maxX - minX, maxY - minY);
    const ratio = Math.min(1.2, Math.max(0.08, extent * 1.7));
    const { width, height } = renderer.getDimensions();
    const center = renderer.viewportToFramedGraph({ x: width / 2, y: height / 2 });
    const wanted = renderer.viewportToFramedGraph(belowSearch ? { x: width / 2, y: height * 0.76 } : { x: (width - occludedRight) / 2, y: height / 2 });
    const dx = (center.x - wanted.x) * (ratio / camera.ratio);
    const dy = (center.y - wanted.y) * (ratio / camera.ratio);
    glideCamera({ x: (minX + maxX) / 2 + dx, y: (minY + maxY) / 2 + dy, ratio });
  }

  /** Vue d'ensemble ; pendant la lecture, centrée dans la partie que le panneau laisse visible. */
  export function resetView() {
    if (!renderer) return;
    const camera = renderer.getCamera();
    if (!away || !occludedRight) {
      glideCamera({ x: 0.5, y: 0.5, ratio: 1 });
      return;
    }
    const { width, height } = renderer.getDimensions();
    const center = renderer.viewportToFramedGraph({ x: width / 2, y: height / 2 });
    const wanted = renderer.viewportToFramedGraph({ x: (width - occludedRight) / 2, y: height / 2 });
    const dx = (center.x - wanted.x) / camera.ratio;
    glideCamera({ x: 0.5 + dx, y: 0.5, ratio: 1 });
  }

  $effect(() => {
    if (!data) return;
    sync(data);
    renderer?.refresh();
  });

  $effect(() => {
    void showUnresolved;
    void selectedId;
    void hiddenGroups;
    renderer?.scheduleRefresh();
  });

  // Ouvrir une note éteint le survol : ses liens allumés balaieraient l'écran pendant le zoom.
  $effect(() => {
    if (selectedId) dropHover?.();
  });

  // Note ouverte mise en avant : elle et ses voisines restent vives, le reste s'assombrit en fondu.
  $effect(() => {
    const id = selectedId;
    void data;
    if (!id || !graph.hasNode(id)) return;
    spot = id;
    spotNeighbors = new Set(graph.neighbors(id));
    renderer?.scheduleRefresh();
  });

  // La couronne n'a de sens qu'autour de la barre centrée : en lecture, le graphe reprend sa forme
  // naturelle, et se réenroule en revenant à l'accueil. (Avant le cadrage de la caméra sur la note,
  // qui vise la place d'arrivée.)
  $effect(() => {
    const reading = away;
    void data;
    if (!physics || !graph.order || reading === !atHome) return;
    atHome = !reading;
    if (reading) leaveHome();
    else returnHome();
  });

  $effect(() => {
    void occludedRight;
    if (selectedId && data) focusNode(selectedId);
    // Tableau de bord : vue d'ensemble, centrée dans la partie que le panneau laisse visible.
    else if (panel && data) resetView();
  });

  // En refermant une note, la caméra revient à la vue d'accueil : le graphe se recale autour du
  // titre et de la barre (la zone qu'il leur laisse est calculée pour cette vue-là).
  let wasAway = false;
  $effect(() => {
    const now = away;
    if (wasAway && !now) {
      if (filtering && kept) fitTo(kept);
      else resetView();
    }
    wasAway = now;
  });

  // Recherche en cours : on ne garde que les notes pertinentes et on les recadre (sauf pendant la lecture).
  $effect(() => {
    const ids = matches;
    if (ids && ids.length) {
      kept = new Set(ids);
      filtering = true;
      if (!away) fitTo(kept);
    } else if (filtering) {
      filtering = false;
      if (!away) resetView();
    }
    renderer?.scheduleRefresh();
  });

  // Chemin entre deux notes : il s'allume et, pendant la lecture, la caméra l'embrasse (après le cadrage
  // sur la note ouverte). Jamais à l'accueil : en refermant la note, la caméra doit retrouver la vue
  // d'accueil, pour laquelle la couronne est calculée (le chemin, effacé juste après, s'y opposerait).
  $effect(() => {
    const ids = path;
    const reading = away;
    void data;
    if (ids && ids.length > 1 && ids.every((id) => graph.hasNode(id))) {
      shownPath = new Set(ids);
      pathEdges = new Set();
      for (let i = 1; i < ids.length; i++) {
        pathEdges.add(edgeKey(ids[i - 1], ids[i]));
        pathEdges.add(edgeKey(ids[i], ids[i - 1]));
      }
      if (reading) fitTo(shownPath, false);
    }
    renderer?.scheduleRefresh();
  });
</script>

<div class="graph" bind:this={container} aria-label="Graphe du Second Cerveau" role="img"></div>

<style>
  .graph {
    position: absolute;
    inset: 0;
    touch-action: none;
    animation: appear 1.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes appear {
    from {
      opacity: 0;
    }
  }
</style>
