<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { DASHBOARD_HASH, DEFAULT_NODE_COLOR, OTHERS_LABEL, byLabel, fetchGraph, folderLabel, isTyping, noteHash, onVaultUpdate, parseHash, type Chain, type GraphPayload, type LegendEntry } from "./lib/api";
  import Dashboard from "./lib/Dashboard.svelte";
  import GraphBackground from "./lib/GraphBackground.svelte";
  import Legend from "./lib/Legend.svelte";
  import NoteReader from "./lib/NoteReader.svelte";
  import { shortestPath } from "./lib/paths";
  import SearchBar from "./lib/SearchBar.svelte";
  import Shortcuts from "./lib/Shortcuts.svelte";

  let graph = $state<GraphPayload | null>(null);
  let loadError = $state<string | null>(null);
  let route = $state(parseHash(location.hash));
  let dashboard = $state(location.hash === DASHBOARD_HASH);
  /** Incrémenté à chaque changement du coffre : la note ouverte se recharge. */
  let refresh = $state(0);
  /** Notes qui correspondent à la recherche en cours : le graphe ne garde qu'elles. */
  let matches = $state<string[] | null>(null);
  let showUnresolved = $state(true);
  let viewport = $state(window.innerWidth);
  let background: GraphBackground;

  /** Invitation de Brave à installer le Second Cerveau comme application (icône propre dans la barre des tâches). */
  interface InstallPrompt extends Event {
    prompt(): Promise<void>;
  }
  let installPrompt = $state<InstallPrompt | null>(null);
  async function install() {
    const invitation = installPrompt;
    installPrompt = null;
    await invitation?.prompt();
  }

  const mobile = $derived(viewport < 768);
  const readerWidth = $derived(Math.min(780, viewport * 0.5));
  /** Un panneau (note ou tableau de bord) occupe la droite de l'écran. */
  const panelOpen = $derived(!!route || dashboard);
  const occluded = $derived(panelOpen && !mobile ? readerWidth : 0);
  // Comme le tableau de bord : les notes existantes et les liens entre elles (sans les notes à créer).
  const stats = $derived.by(() => {
    if (!graph) return null;
    const { nodes, edges } = graph;
    return {
      notes: nodes.filter((n) => !n.unresolved).length,
      links: edges.filter(([a, b]) => !nodes[a].unresolved && !nodes[b].unresolved).length,
    };
  });

  async function loadGraph() {
    try {
      graph = await fetchGraph();
      loadError = null;
    } catch {
      // Le serveur démarre peut-être encore : on réessaie tranquillement.
      loadError = "Le serveur du Second Cerveau ne répond pas. Relance-le depuis l'icône du bureau si ça dure.";
      setTimeout(() => void loadGraph(), 2500);
    }
  }

  const open = (id: string) => (location.hash = noteHash(id));
  const close = () => (location.hash = "#/");

  // Légende : les groupes masqués sont retenus par leur dossier (les indices changent si les couleurs
  // d'Obsidian changent), dans ce navigateur seulement.
  const LEGEND_KEY = "second-cerveau:legende-masquee";
  function loadHiddenGroups(): string[] {
    try {
      const saved = JSON.parse(localStorage.getItem(LEGEND_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.map(String) : [];
    } catch {
      return [];
    }
  }
  let hiddenPrefixes = $state<string[]>(loadHiddenGroups());
  let legendOpen = $state(false);
  /** Aide des raccourcis clavier (touche « ? »). */
  let helpOpen = $state(false);
  /** Dossier d'un groupe ; « » pour les notes sans groupe. */
  const prefixOf = (index: number) => (index < 0 ? "" : (graph?.groups[index]?.prefix ?? ""));
  const hiddenGroups = $derived(new Set(graph ? [-1, ...graph.groups.keys()].filter((i) => hiddenPrefixes.includes(prefixOf(i))) : []));
  const legend = $derived.by((): LegendEntry[] => {
    if (!graph) return [];
    const counts = new Map<number, number>();
    for (const n of graph.nodes) if (!n.unresolved) counts.set(n.group, (counts.get(n.group) ?? 0) + 1);
    const entries = graph.groups.map((g, index) => ({ index, label: g.label, color: g.color, count: counts.get(index) ?? 0 })).filter((e) => e.count > 0);
    if (counts.get(-1)) entries.push({ index: -1, label: OTHERS_LABEL, color: DEFAULT_NODE_COLOR, count: counts.get(-1)! });
    return entries.sort(byLabel((e) => folderLabel(e.label)));
  });
  function setHiddenGroups(prefixes: string[]) {
    hiddenPrefixes = prefixes;
    try {
      localStorage.setItem(LEGEND_KEY, JSON.stringify(prefixes));
    } catch {
      /* navigation privée : le choix ne dure que le temps de la page */
    }
  }
  function toggleGroup(index: number) {
    const prefix = prefixOf(index);
    setHiddenGroups(hiddenPrefixes.includes(prefix) ? hiddenPrefixes.filter((p) => p !== prefix) : [...hiddenPrefixes, prefix]);
  }

  /** Une note au hasard (parmi celles que la légende affiche), autre que celle déjà ouverte. */
  function randomNote() {
    if (!graph) return;
    const pool = graph.nodes.filter((n) => !n.unresolved && n.id !== route?.id && !hiddenGroups.has(n.group));
    if (pool.length) open(pool[Math.floor(Math.random() * pool.length)].id);
  }

  // Chemin entre deux notes : on le garde tant qu'on lit l'une de ses étapes.
  let pathRequest = $state<{ from: string; to: string; ids: string[] | null } | null>(null);
  const nodeById = $derived(new Map((graph?.nodes ?? []).map((n) => [n.id, n])));
  const chain = $derived.by((): Chain | null => {
    if (!pathRequest) return null;
    const title = (id: string) => nodeById.get(id)?.label ?? id;
    return {
      found: pathRequest.ids !== null,
      from: title(pathRequest.from),
      to: title(pathRequest.to),
      steps: (pathRequest.ids ?? []).map((id) => ({ id, title: title(id), color: nodeById.get(id)?.color ?? DEFAULT_NODE_COLOR })),
    };
  });
  /** Calcule le chemin et ouvre la note de départ. */
  function requestPath(from: string, to: string) {
    if (!graph) return;
    pathRequest = { from, to, ids: shortestPath(graph, from, to) };
    if (route?.id !== from) open(from);
  }
  $effect(() => {
    const r = route;
    untrack(() => {
      const req = pathRequest;
      if (req && (!r || !(req.ids ?? [req.from]).includes(r.id))) pathRequest = null;
    });
  });

  onMount(() => {
    void loadGraph();
    const onHash = () => {
      route = parseHash(location.hash);
      dashboard = location.hash === DASHBOARD_HASH;
    };
    const onResize = () => (viewport = window.innerWidth);
    const onKey = (e: KeyboardEvent) => {
      // « ? » ouvre l'aide, sauf pendant une saisie (même garde que le « / » de la recherche).
      if (e.key === "?" && !isTyping(e)) {
        e.preventDefault();
        helpOpen = !helpOpen;
        legendOpen = false;
        return;
      }
      if (e.key !== "Escape" || (e.target as HTMLElement).closest(".search")) return;
      if (helpOpen) helpOpen = false;
      else if (legendOpen) legendOpen = false;
      else if (route || dashboard) location.hash = "#/";
    };
    // La légende et l'aide se ferment d'un clic ailleurs.
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      if (legendOpen && !target.closest(".legend, .legend-toggle")) legendOpen = false;
      if (helpOpen && !target.closest(".shortcuts, .help-toggle")) helpOpen = false;
    };
    window.addEventListener("pointerdown", onPointer);
    // Brave ne propose l'installation que si l'application ne l'est pas encore : on garde son invitation
    // pour l'offrir par un bouton discret, qui disparaît une fois l'application installée.
    const onInstallable = (e: Event) => {
      e.preventDefault();
      installPrompt = e as InstallPrompt;
    };
    const onInstalled = () => (installPrompt = null);
    window.addEventListener("beforeinstallprompt", onInstallable);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    const stop = onVaultUpdate(() => {
      refresh++;
      void loadGraph();
    });
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallable);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      stop();
    };
  });
</script>

<main style:--reader-width="{readerWidth}px">
  <GraphBackground
    bind:this={background}
    data={graph}
    selectedId={route?.id ?? null}
    panel={dashboard}
    {showUnresolved}
    {hiddenGroups}
    path={pathRequest?.ids ?? null}
    occludedRight={occluded}
    {matches}
    onselect={open}
    onpathpick={requestPath}
  />
  <div class="vignette" class:reading={panelOpen} aria-hidden="true"></div>

  <SearchBar compact={panelOpen} {stats} onselect={open} onmatches={(ids) => (matches = ids)} />

  {#if route}
    <NoteReader
      id={route.id}
      heading={route.heading}
      version={refresh}
      {chain}
      onclose={close}
      onselect={open}
      onpathto={(to) => route && requestPath(route.id, to)}
      onclearpath={() => (pathRequest = null)}
    />
  {:else if dashboard}
    <Dashboard version={refresh} onclose={close} />
  {/if}

  {#if legendOpen && graph && !(panelOpen && mobile)}
    <Legend entries={legend} hidden={hiddenGroups} ontoggle={toggleGroup} onreset={() => setHiddenGroups([])} />
  {/if}

  {#if helpOpen && !(panelOpen && mobile)}
    <Shortcuts />
  {/if}

  {#if !(panelOpen && mobile)}
    <div class="controls">
      <button onclick={() => background.resetView()} title="Recentrer le graphe" aria-label="Recentrer le graphe">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
      </button>
      <button onclick={() => (showUnresolved = !showUnresolved)} class:off={!showUnresolved} title="Afficher ou masquer les notes pas encore créées" aria-pressed={showUnresolved}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke-dasharray="3 3" /></svg>
        <span>Notes à créer</span>
      </button>
      <button class="legend-toggle" class:on={legendOpen} class:filtered={hiddenGroups.size > 0} onclick={() => ((legendOpen = !legendOpen), (helpOpen = false))} title="Légende : afficher ou masquer des types de notes" aria-expanded={legendOpen}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2" /><circle cx="6" cy="17" r="2" /><path d="M11 7h9M11 17h9" /></svg>
        <span>Légende</span>
      </button>
      <button onclick={randomNote} title="Ouvrir une note au hasard">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="0.6" /><circle cx="15" cy="15" r="0.6" /><circle cx="15" cy="9" r="0.6" /><circle cx="9" cy="15" r="0.6" /></svg>
        <span>Au hasard</span>
      </button>
      <button class:on={dashboard} onclick={() => (location.hash = dashboard ? "#/" : DASHBOARD_HASH)} title="Tableau de bord du Second Cerveau" aria-pressed={dashboard}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M12 20V5M19 20v-6" /></svg>
        <span>Tableau de bord</span>
      </button>
      <button class="help-toggle" class:on={helpOpen} onclick={() => ((helpOpen = !helpOpen), (legendOpen = false))} title="Raccourcis clavier (?)" aria-label="Raccourcis clavier" aria-expanded={helpOpen}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4M12 17h.01" /></svg>
      </button>
      {#if installPrompt}
        <button onclick={install} title="Installer le Second Cerveau comme application (fenêtre et icône propres, épinglable à la barre des tâches)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 8v6M9 11l3 3 3-3M8 21h8" /></svg>
          <span>Installer l'application</span>
        </button>
      {/if}
    </div>
  {/if}

  {#if loadError}
    <div class="toast" role="alert">{loadError}</div>
  {:else if !graph}
    <div class="toast quiet">Chargement du Second Cerveau…</div>
  {/if}
</main>

<style>
  main {
    position: absolute;
    inset: 0;
    overflow: clip;
  }

  /* Assombrit légèrement le centre pour que la recherche reste lisible sur le graphe. */
  .vignette {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(ellipse 34% 24% at 50% 50%, rgba(28, 33, 39, 0.92), rgba(28, 33, 39, 0.55) 55%, rgba(28, 33, 39, 0) 100%);
    transition: opacity 0.45s;
  }
  .vignette.reading {
    opacity: 0;
  }

  .controls {
    position: absolute;
    left: 20px;
    bottom: 20px;
    z-index: 10;
    display: flex;
    gap: 8px;
  }
  .controls button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 11px;
    font-size: 13px;
    color: var(--text-muted);
    background: var(--glass);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    transition:
      color 0.15s,
      border-color 0.15s;
  }
  .controls button:hover {
    color: var(--text);
    border-color: rgba(255, 255, 255, 0.16);
  }
  .controls button.off {
    color: var(--text-faint);
  }
  .controls button.on {
    color: var(--text);
    border-color: hsla(215, 75%, 70%, 0.35);
  }
  /* Des types de notes sont masqués : la légende le rappelle d'un point bleu. */
  .controls button.filtered {
    position: relative;
  }
  .controls button.filtered::after {
    content: "";
    position: absolute;
    top: 6px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .controls button.off span {
    text-decoration: line-through;
  }
  .controls svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  .toast {
    position: absolute;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    z-index: 30;
    padding: 10px 16px;
    border-radius: 10px;
    background: rgba(232, 62, 62, 0.14);
    border: 1px solid rgba(232, 62, 62, 0.4);
    color: #f3b0b0;
    font-size: 14px;
  }
  .toast.quiet {
    background: var(--glass);
    border-color: var(--border-soft);
    color: var(--text-muted);
  }

  @media (max-width: 767px) {
    .controls span {
      display: none;
    }
  }
</style>
