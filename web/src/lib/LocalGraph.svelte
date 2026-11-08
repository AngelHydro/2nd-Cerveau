<script lang="ts">
  import Graph from "graphology";
  import Sigma from "sigma";
  import { onMount } from "svelte";
  import type { NotePayload } from "./api";
  import { GraphPhysics, enableDrag, freezeFrame } from "./physics";
  import { LABEL_FONT, drawHover, drawLabel } from "./sigmaStyle";

  interface Props {
    centerId: string;
    neighbors: NotePayload["neighbors"];
    onselect: (id: string) => void;
  }
  let { centerId, neighbors, onselect }: Props = $props();

  /** Délai avant de libérer le moteur WebGL (le changement de forme du grand graphe dure ~2 s). */
  const RELEASE_DELAY_MS = 3000;

  let container: HTMLDivElement;
  let renderer: Sigma | null = null;
  let physics: GraphPhysics | null = null;
  const graph = new Graph({ type: "undirected" });

  /** Remplit le voisinage : la note au centre, ses voisines disposées en couronne autour. */
  function fill() {
    graph.clear();
    const others = neighbors.nodes.filter((n) => n.id !== centerId);
    const ring = 40;
    for (const n of neighbors.nodes) {
      const center = n.id === centerId;
      const i = others.indexOf(n);
      const angle = (i / Math.max(others.length, 1)) * Math.PI * 2;
      const r = center ? 0 : ring * (0.8 + Math.random() * 0.4);
      graph.addNode(n.id, { label: n.title, color: n.color, x: Math.cos(angle) * r, y: Math.sin(angle) * r, size: center ? 9 : Math.max(4, n.size * 0.7) });
    }
    for (const [a, b] of neighbors.edges) {
      const s = neighbors.nodes[a].id;
      const t = neighbors.nodes[b].id;
      if (!graph.hasEdge(s, t)) graph.addEdge(s, t, { color: s === centerId || t === centerId ? "#4a525c" : "#30363e" });
    }
  }

  function start() {
    if (!renderer) return;
    physics?.destroy();
    fill();
    physics = new GraphPhysics(graph, { charge: -140, gravity: 0.04, linkDistance: 48, linkStrength: 0.25, collideRadius: 6 });
    physics.warmup(160);
    freezeFrame(renderer, graph, 0.2);
    renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  }

  onMount(() => {
    renderer = new Sigma(graph, container, {
      labelFont: LABEL_FONT,
      labelSize: 11,
      defaultDrawNodeHover: drawHover as never,
      defaultDrawNodeLabel: drawLabel as never,
      labelColor: { color: "#b7bec7" },
      labelRenderedSizeThreshold: 0,
      labelDensity: 1,
      defaultEdgeColor: "#30363e",
      stagePadding: 30,
      allowInvalidContainer: true,
      nodeReducer: (node, attrs) => (node === centerId ? { ...attrs, highlighted: true, forceLabel: true } : attrs),
    });
    // La physique est recréée à chaque note : le glisser-déposer passe par la simulation du moment.
    const drag = enableDrag(renderer, {
      grab: (id, x, y) => physics?.grab(id, x, y),
      move: (x, y) => physics?.move(x, y),
      release: () => physics?.release(),
    });
    renderer.on("clickNode", ({ node }) => {
      if (!drag.wasDrag() && node !== centerId) onselect(node);
    });
    renderer.on("enterNode", () => (container.style.cursor = "grab"));
    renderer.on("leaveNode", () => (container.style.cursor = ""));

    // Créé hors écran (bas de la note), le graphe se recadre quand il reçoit sa vraie taille.
    const observer = new ResizeObserver(() => {
      if (!renderer || !container.clientWidth || !container.clientHeight) return;
      renderer.resize();
      renderer.refresh();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      drag.dispose();
      physics?.destroy();
      // Libérer le moteur WebGL fige la page un instant : on attend la fin des animations de fermeture
      // (panneau, caméra, changement de forme du grand graphe) pour ne pas les faire sauter.
      const dying = renderer;
      renderer = null;
      setTimeout(() => dying?.kill(), RELEASE_DELAY_MS);
    };
  });

  $effect(() => {
    void neighbors;
    void centerId;
    start();
  });
</script>

<div class="local" bind:this={container}></div>

<style>
  .local {
    position: relative;
    overflow: hidden;
    height: 280px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.12);
    touch-action: none;
  }
</style>
