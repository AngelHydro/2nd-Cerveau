<script module lang="ts">
  import DOMPurify from "dompurify";
  import { LABEL_FONT } from "./sigmaStyle";

  // Le HTML vient de ton propre coffre, mais on le nettoie quand même : pas de script, et
  // les cadres intégrés ne peuvent afficher que des fichiers du Wiki (PDF).
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "iframe") {
      const src = (node as Element).getAttribute("src") ?? "";
      if (!src.startsWith("/files/")) node.parentNode?.removeChild(node);
    }
  });
  const sanitize = (html: string) =>
    DOMPurify.sanitize(html, {
      ADD_TAGS: ["iframe"],
      ADD_ATTR: ["target", "loading", "open", "data-note", "data-callout"],
      FORBID_TAGS: ["style", "form", "input", "button"],
    });

  let mermaidModule: Promise<typeof import("mermaid").default> | null = null;
  function loadMermaid() {
    mermaidModule ??= import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: LABEL_FONT,
        themeVariables: {
          darkMode: true,
          background: "#1c2127",
          primaryColor: "#262c34",
          primaryTextColor: "#dadada",
          primaryBorderColor: "#2e80f2",
          secondaryColor: "#2a2533",
          secondaryBorderColor: "#9e86c8",
          tertiaryColor: "#1f2a2c",
          tertiaryBorderColor: "#3eb4bf",
          lineColor: "#8c96a3",
          textColor: "#dadada",
          edgeLabelBackground: "#1c2127",
          clusterBkg: "#22272e",
          clusterBorder: "#35393e",
        },
      });
      return mermaid;
    });
    return mermaidModule;
  }

  const formatDate = (d?: string) => {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    return new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  };
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import { fetchNote, noteHash, searchNotes, trailOf, type Chain, type NotePayload, type SearchHit } from "./api";
  import LocalGraph from "./LocalGraph.svelte";

  interface Props {
    id: string;
    heading?: string;
    /** Version de l'index : la note est rechargée quand le coffre change. */
    version: number;
    /** Chemin demandé : ses étapes, ou `found: false` si les deux notes ne sont reliées par rien. */
    chain: Chain | null;
    onclose: () => void;
    onselect: (id: string) => void;
    /** Demande le chemin de la note ouverte vers une autre. */
    onpathto: (target: string) => void;
    onclearpath: () => void;
  }
  let { id, heading, version, chain, onclose, onselect, onpathto, onclearpath }: Props = $props();

  let note = $state<NotePayload | null>(null);
  let error = $state<string | null>(null);
  let retry = $state(0);
  let loading = $state(true);
  let scroller: HTMLElement;
  let body = $state<HTMLElement>();

  const html = $derived(note ? sanitize(note.html) : "");

  $effect(() => {
    const wanted = id;
    const anchor = heading;
    void version;
    void retry;
    const ctrl = new AbortController();
    loading = true;
    fetchNote(wanted, ctrl.signal)
      .then(async (n) => {
        const changed = note?.id !== n.id;
        note = n;
        error = null;
        loading = false;
        await tick();
        // Beaucoup de notes répètent leur nom en titre principal : on ne l'affiche qu'une fois.
        const firstH1 = body?.querySelector("h1");
        if (firstH1 && firstH1.textContent?.trim().toLowerCase() === n.title.trim().toLowerCase()) firstH1.classList.add("duplicate-title");
        readOutline();
        if (changed && !anchor) scroller?.scrollTo({ top: 0 });
        if (anchor) scrollToElement(body?.querySelector(`#${CSS.escape(anchor)}`));
        await renderDiagrams();
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        loading = false;
        note = null;
        error = err.message === "introuvable" ? "Cette note n'existe plus (elle a peut-être été renommée ou déplacée)." : "Impossible de charger la note.";
      });
    return () => ctrl.abort();
  });

  async function renderDiagrams() {
    const blocks = body?.querySelectorAll<HTMLElement>("pre.mermaid:not([data-processed])");
    if (!blocks?.length) return;
    const mermaid = await loadMermaid();
    try {
      await mermaid.run({ nodes: [...blocks], suppressErrors: true });
    } catch {
      /* un schéma invalide reste affiché en texte */
    }
  }

  // Les ancres internes (notes de bas de page) défilent dans le panneau au lieu de changer d'adresse.
  function onBodyClick(e: MouseEvent) {
    const a = (e.target as Element).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (href.startsWith("#") && !href.startsWith("#/")) {
      e.preventDefault();
      scrollToElement(body?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`));
    }
  }

  // Sommaire : les intertitres de la note (ils ont déjà leur ancre), à partir de trois.
  interface Section {
    id: string;
    text: string;
    level: number;
    el: HTMLElement;
  }
  let outline = $state<Section[]>([]);
  let outlineOpen = $state(false);
  let current = $state<string | null>(null);
  const MIN_SECTIONS = 3;

  function readOutline() {
    const found = [...(body?.querySelectorAll<HTMLElement>("h2[id], h3[id]") ?? [])];
    outline = found.map((el) => ({ id: el.id, text: el.textContent?.trim() ?? "", level: el.tagName === "H3" ? 3 : 2, el }));
    outlineOpen = false;
    trackSection();
  }

  /** Section en cours de lecture : le dernier intertitre passé sous le haut du panneau. */
  function trackSection() {
    if (!scroller || outline.length < MIN_SECTIONS) return;
    const top = scroller.getBoundingClientRect().top + 80;
    let seen: string | null = null;
    for (const s of outline) if (s.el.getBoundingClientRect().top <= top) seen = s.id;
    current = seen;
  }

  function goToSection(s: Section) {
    outlineOpen = false;
    scrollToElement(s.el);
  }

  // « Relier à… » : on choisit l'arrivée du chemin dans une petite recherche.
  let picking = $state(false);
  let pickQuery = $state("");
  let pickHits = $state<SearchHit[]>([]);
  let pickActive = $state(0);
  let pickInput = $state<HTMLInputElement>();

  $effect(() => {
    const q = pickQuery.trim();
    if (!picking || !q) {
      pickHits = [];
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      searchNotes(q, ctrl.signal)
        .then((r) => {
          pickHits = r.hits.filter((h) => h.id !== id).slice(0, 6);
          pickActive = 0;
        })
        .catch(() => {});
    }, 120);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  });

  async function startPicking() {
    outlineOpen = false;
    picking = !picking;
    pickQuery = "";
    if (picking) {
      await tick();
      pickInput?.focus();
    }
  }

  function pick(hit: SearchHit) {
    picking = false;
    pickQuery = "";
    onpathto(hit.id);
  }

  function onPickKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pickActive = Math.min(pickActive + 1, pickHits.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      pickActive = Math.max(pickActive - 1, 0);
    } else if (e.key === "Enter" && pickHits[pickActive]) {
      pick(pickHits[pickActive]);
    } else if (e.key === "Escape") {
      // Échap ferme la petite recherche, pas la note.
      e.stopPropagation();
      picking = false;
    }
  }

  // Les listes déroulantes se ferment d'un clic ailleurs, ou avec Échap.
  function closeMenus(e: PointerEvent) {
    if (!(e.target as Element).closest(".tools, .menu")) outlineOpen = false;
  }
  function onMenuKey(e: KeyboardEvent) {
    if (e.key === "Escape" && outlineOpen) {
      e.stopPropagation();
      outlineOpen = false;
    }
  }

  /** Défile dans le panneau uniquement (scrollIntoView ferait aussi glisser la page). */
  function scrollToElement(el: Element | null | undefined) {
    if (!el || !scroller) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 24;
    scroller.scrollTo({ top, behavior: "smooth" });
  }

  // Sur ordinateur le panneau glisse depuis la droite ; sur téléphone il monte depuis le bas.
  const narrow = matchMedia("(max-width: 767px)").matches;
  const panelMotion = narrow ? { y: 36, duration: 320, easing: cubicOut } : { x: 56, duration: 380, easing: cubicOut };

  const trail = $derived(note ? trailOf(note) : []);

  // Le mini-graphe démarre un second moteur WebGL, coûteux : on ne le crée qu'une fois visible, et
  // jamais pendant le glissement d'ouverture du grand graphe (sinon l'animation se fige un instant).
  const openedAt = performance.now();
  /** Durée du changement de forme du grand graphe (ressort de ~140 images). */
  const OPENING_MS = 2400;
  let graphFor = $state<string | null>(null);
  function revealGraph(node: HTMLElement, noteId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        timer = setTimeout(() => (graphFor = noteId), Math.max(0, openedAt + OPENING_MS - performance.now()));
      },
      { root: scroller, rootMargin: "200px" },
    );
    io.observe(node);
    return {
      destroy() {
        io.disconnect();
        clearTimeout(timer);
      },
    };
  }
</script>

<svelte:window onpointerdown={closeMenus} onkeydowncapture={onMenuKey} />

<aside class="reader" aria-label="Lecture de la note" transition:fly|global={panelMotion}>
  <div class="bar">
    <button class="close" onclick={onclose} aria-label="Fermer la note" title="Fermer (Échap)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" class="back" /><path d="M6 6l12 12M18 6 6 18" class="cross" /></svg>
    </button>
    {#if note}
      <nav class="trail" aria-label="Emplacement">
        <span class="dot" style:background={note.color}></span>
        {#each trail as part, i}{#if i > 0}<span class="sep">›</span>{/if}<span>{part}</span>{/each}
      </nav>
      <div class="tools">
        {#if outline.length >= MIN_SECTIONS}
          <button class="tool" class:on={outlineOpen} onclick={() => ((outlineOpen = !outlineOpen), (picking = false))} title="Sommaire de la note" aria-expanded={outlineOpen}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h13" /></svg>
            <span>Sommaire</span>
          </button>
        {/if}
        <button class="tool" class:on={picking} onclick={startPicking} title="Trouver le chemin de liens qui relie cette note à une autre" aria-expanded={picking}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6" r="2.2" /><circle cx="19" cy="18" r="2.2" /><path d="M7 7.5c5 1 5 8 10 9" /></svg>
          <span>Relier à…</span>
        </button>
        <a class="tool" href={note.obsidianUrl} title="Ouvrir cette note dans Obsidian (pour la modifier)" aria-label="Ouvrir dans Obsidian">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
        </a>
      </div>
    {/if}
  </div>

  {#if outlineOpen}
    <nav class="menu outline" aria-label="Sommaire" transition:fly={{ y: -6, duration: 160, easing: cubicOut }}>
      {#each outline as s (s.id)}
        <button class:sub={s.level === 3} class:current={s.id === current} onclick={() => goToSection(s)}>{s.text}</button>
      {/each}
    </nav>
  {/if}

  {#if picking}
    <div class="menu picker" transition:fly={{ y: -6, duration: 160, easing: cubicOut }}>
      <input bind:this={pickInput} bind:value={pickQuery} onkeydown={onPickKey} type="search" placeholder="Relier à quelle note ?" aria-label="Note d'arrivée du chemin" autocomplete="off" spellcheck="false" />
      {#if pickHits.length}
        <ul role="listbox" aria-label="Notes d'arrivée possibles">
          {#each pickHits as hit, i (hit.id)}
            <li role="option" aria-selected={i === pickActive}>
              <button class:active={i === pickActive} onmousemove={() => (pickActive = i)} onclick={() => pick(hit)}>
                <span class="dot" style:background={hit.color}></span>
                <span class="hit-title">{hit.title}</span>
                <span class="hit-path">{trailOf(hit).join(" › ")}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div class="scroll" bind:this={scroller} onscroll={trackSection}>
    {#if error}
      <div class="state">
        <p>{error}</p>
        <button class="retry" onclick={() => retry++}>Réessayer</button>
      </div>
    {:else if note}
      {#key note.id}
      <article class:dimmed={loading} in:fly={{ y: 10, duration: 280, easing: cubicOut }}>
        <h1 class="title">{note.title}</h1>
        {#if note.meta.source || note.meta.date || note.meta.aliases.length}
          <p class="meta">
            {#if note.meta.aliases.length}<span>Aussi : {note.meta.aliases.join(", ")}</span>{/if}
            {#if note.meta.source}<span>{note.meta.source}</span>{/if}
            {#if note.meta.date}<span>{formatDate(note.meta.date)}</span>{/if}
          </p>
        {/if}
        {#if chain}
          <nav class="chain" aria-label="Chemin entre deux notes">
            {#if chain.found}
              <p class="chain-head">
                Chemin en {chain.steps.length - 1} {chain.steps.length - 1 > 1 ? "étapes" : "étape"}
                <button class="chain-clear" onclick={onclearpath} title="Effacer le chemin" aria-label="Effacer le chemin">×</button>
              </p>
              <ol>
                {#each chain.steps as step, i (step.id)}
                  <li>
                    {#if i > 0}<span class="arrow" aria-hidden="true">→</span>{/if}
                    <a href={noteHash(step.id)} class:here={step.id === note.id}><span class="dot" style:background={step.color}></span>{step.title}</a>
                  </li>
                {/each}
              </ol>
            {:else}
              <p class="chain-head">
                Aucun chemin de liens entre « {chain.from} » et « {chain.to} ».
                <button class="chain-clear" onclick={onclearpath} title="Effacer" aria-label="Effacer">×</button>
              </p>
            {/if}
          </nav>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="markdown" bind:this={body} onclick={onBodyClick}>{@html html}</div>

        <footer>
          {#if note.backlinks.length}
            <section>
              <h2>Mentionnée dans <span>{note.backlinks.length}</span></h2>
              <ul class="backlinks">
                {#each note.backlinks as b (b.id)}
                  <li><a href={noteHash(b.id)}><span class="dot" style:background={b.color}></span>{b.title}</a></li>
                {/each}
              </ul>
            </section>
          {/if}
          {#if note.unlinkedMentions.length}
            <section>
              <h2>Mentions non liées <span>{note.unlinkedMentions.length}</span></h2>
              <p class="hint">Citent cette note sans lien vers elle.</p>
              <ul class="backlinks">
                {#each note.unlinkedMentions as m (m.id)}
                  <li><a href={noteHash(m.id)}><span class="dot" style:background={m.color}></span>{m.title}</a></li>
                {/each}
              </ul>
            </section>
          {/if}
          {#if note.neighbors.nodes.length > 1}
            <section>
              <h2>Voisinage</h2>
              {#if graphFor === note.id}
                <LocalGraph centerId={note.id} neighbors={note.neighbors} {onselect} />
              {:else}
                <div class="graph-slot" use:revealGraph={note.id}></div>
              {/if}
            </section>
          {/if}
        </footer>
      </article>
      {/key}
    {:else}
      <p class="state">Chargement…</p>
    {/if}
  </div>
</aside>

<style>
  .reader {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--reader-width);
    z-index: 20;
    display: flex;
    flex-direction: column;
    background: rgba(28, 33, 39, 0.97);
    border-left: 1px solid var(--border-soft);
    box-shadow: -30px 0 80px rgba(0, 0, 0, 0.35);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 56px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border-soft);
    flex: none;
  }
  .close {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 8px;
    color: var(--text-muted);
  }
  .close:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--text);
  }
  .close svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .close .back {
    display: none;
  }

  .trail {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: 13px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sep {
    opacity: 0.6;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 9px;
    border-radius: 8px;
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
  }
  .tool:hover,
  .tool.on {
    background: rgba(255, 255, 255, 0.06);
    color: var(--text);
  }
  .tool svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Listes déroulantes sous la barre : sommaire et choix de l'arrivée d'un chemin. */
  .menu {
    position: absolute;
    top: 60px;
    right: 14px;
    z-index: 2;
    width: min(360px, calc(100% - 28px));
    max-height: min(60vh, 460px);
    overflow-y: auto;
    padding: 6px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-l);
  }
  .outline button {
    display: block;
    width: 100%;
    padding: 7px 10px;
    border-radius: 8px;
    text-align: left;
    font-size: 14px;
    color: var(--text-muted);
  }
  .outline button.sub {
    padding-left: 24px;
    font-size: 13px;
  }
  .outline button:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text);
  }
  .outline button.current {
    color: var(--accent);
  }
  .picker input {
    width: 100%;
    height: 38px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.18);
    color: var(--text);
    font: inherit;
    font-size: 14px;
    outline: none;
  }
  .picker input:focus {
    border-color: hsla(215, 75%, 70%, 0.45);
  }
  .picker ul {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
  }
  .picker li button {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border-radius: 8px;
    text-align: left;
    color: var(--text);
    font-size: 14px;
  }
  .picker li button.active {
    background: rgba(255, 255, 255, 0.06);
  }
  .hit-title {
    flex: none;
  }
  .hit-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-faint);
  }

  /* Chemin entre deux notes, sous le titre. */
  .chain {
    margin: 0 0 28px;
    padding: 12px 14px;
    border: 1px solid hsla(215, 75%, 70%, 0.25);
    border-radius: 12px;
    background: hsla(215, 75%, 70%, 0.05);
  }
  .chain-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }
  .chain-clear {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    color: var(--text-faint);
    font-size: 17px;
    line-height: 1;
  }
  .chain-clear:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--text);
  }
  .chain ol {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
  }
  .chain li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .chain .arrow {
    color: var(--text-faint);
  }
  .chain a {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    color: var(--text);
    font-size: 13px;
    text-decoration: none;
  }
  .chain a.here {
    border-color: hsla(215, 75%, 70%, 0.5);
  }
  .dot {
    flex: none;
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  article {
    max-width: 720px;
    margin: 0 auto;
    padding: 36px 44px 80px;
    transition: opacity 0.2s;
  }
  article.dimmed {
    opacity: 0.5;
  }
  .title {
    margin: 0 0 8px;
    font-size: 2rem;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.015em;
    color: #eef0f3;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 0 0 28px;
    font-size: 13px;
    color: var(--text-faint);
  }
  .state {
    padding: 48px 32px;
    color: var(--text-muted);
    text-align: center;
  }
  .retry {
    margin-top: 8px;
    padding: 7px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--text);
  }
  .retry:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }

  footer {
    margin-top: 56px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    display: grid;
    gap: 32px;
  }
  footer h2 {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  footer h2 span {
    margin-left: 6px;
    font-weight: 400;
  }
  footer .hint {
    margin: -6px 0 12px;
    font-size: 13px;
    color: var(--text-faint);
  }
  /* Place réservée au mini-graphe (même hauteur) tant qu'il n'est pas créé : rien ne saute. */
  .graph-slot {
    height: 280px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.12);
  }
  .backlinks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .backlinks a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-radius: 999px;
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    color: var(--text);
    font-size: 14px;
    text-decoration: none;
  }
  .backlinks a:hover {
    border-color: rgba(255, 255, 255, 0.18);
  }

  @media (max-width: 767px) {
    .reader {
      width: 100%;
      border-left: 0;
    }
    .tool span {
      display: none;
    }
    .close .back {
      display: block;
    }
    .close .cross {
      display: none;
    }
    article {
      padding: 24px 20px 64px;
    }
    .title {
      font-size: 1.7rem;
    }
  }
</style>
