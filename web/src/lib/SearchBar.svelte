<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import { formatCount, isTyping, searchNotes, trailOf, type SearchHit } from "./api";
  import { numberToFrench } from "./french";

  interface Props {
    compact: boolean;
    stats: { notes: number; links: number } | null;
    onselect: (id: string) => void;
    /** Notes qui correspondent à la recherche (null = pas de filtre) : le graphe ne garde qu'elles. */
    onmatches: (ids: string[] | null) => void;
  }
  let { compact, stats, onselect, onmatches }: Props = $props();

  let query = $state("");
  let hits = $state<SearchHit[]>([]);
  let active = $state(0);
  let open = $state(false);
  let searched = $state(false);
  let input: HTMLInputElement;

  $effect(() => {
    const q = query.trim();
    if (!q) {
      hits = [];
      searched = false;
      onmatches(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await searchNotes(q, ctrl.signal);
        hits = res.hits;
        // Une seule lettre correspond à presque tout : on ne filtre le graphe qu'à partir de deux.
        onmatches(q.length >= 2 ? res.matches : null);
        active = 0;
        searched = true;
        open = true;
      } catch {
        /* requête annulée par la frappe suivante */
      }
    }, 90);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  });

  function choose(hit: SearchHit | undefined) {
    if (!hit) return;
    onselect(hit.id);
    open = false;
    input.blur();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, hits.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === "Enter") {
      choose(hits[active]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (query) query = "";
      else input.blur();
    }
  }

  function globalKey(e: KeyboardEvent) {
    if ((e.key === "/" && !isTyping(e)) || (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  }

  $effect(() => {
    // Garde l'élément actif visible pendant la navigation au clavier, sans faire défiler la page.
    const item = document.getElementById(`hit-${active}`);
    const list = item?.parentElement;
    if (!item || !list) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  });
</script>

<svelte:window onkeydown={globalKey} />

<div class="search" class:compact>
  <!-- Le titre reste dans la page et s'efface sur place : la barre ne saute pas quand il disparaît. -->
  <header class="brand" aria-hidden={compact}>
    <h1>Second Cerveau</h1>
    {#if stats}<p title="{formatCount(stats.notes)} notes · {formatCount(stats.links)} liens">{numberToFrench(stats.notes)} notes, reliées entre elles</p>{/if}
  </header>

  <div class="box" class:has-results={open && searched}>
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
    <input
      bind:this={input}
      bind:value={query}
      type="search"
      placeholder={compact ? "Rechercher…" : "Que veux-tu explorer ?"}
      aria-label="Rechercher dans le Second Cerveau"
      aria-controls="search-results"
      aria-activedescendant={open && hits.length ? `hit-${active}` : undefined}
      role="combobox"
      aria-expanded={open && searched}
      autocomplete="off"
      spellcheck="false"
      onfocus={() => (open = true)}
      onblur={() => (open = false)}
      {onkeydown}
    />
    {#if query}
      <button class="clear" aria-label="Effacer la recherche" onmousedown={(e) => e.preventDefault()} onclick={() => (query = "")}>×</button>
    {:else if !compact}
      <kbd aria-hidden="true">/</kbd>
    {/if}
  </div>

  {#if open && searched}
    <ul class="results" id="search-results" role="listbox" transition:fly={{ y: -8, duration: 200, easing: cubicOut }}>
      {#each hits as hit, i (hit.id)}
        <li
          id="hit-{i}"
          role="option"
          aria-selected={i === active}
          class:active={i === active}
          onmousemove={() => (active = i)}
          onmousedown={(e) => {
            e.preventDefault();
            choose(hit);
          }}
        >
          <span class="dot" style:background={hit.color}></span>
          <div class="text">
            <div class="line">
              <span class="title">{hit.title}</span>
              <span class="path">{trailOf(hit).join(" › ")}</span>
            </div>
            {#if hit.snippet.length}
              <p class="snippet">{#each hit.snippet as s}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</p>
            {/if}
          </div>
        </li>
      {:else}
        <li class="empty">Rien ne correspond à « {query.trim()} ».</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .search {
    /* La barre est ancrée par son bord haut (la liste s'ouvre vers le bas sans la faire bouger) et
       se déplace uniquement par `transform` : un seul mouvement fluide, identique dans les deux sens. */
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
    --move: 0.6s;
    position: absolute;
    left: 0;
    top: 0;
    width: min(640px, calc(100vw - 32px));
    /* Titre + barre centrés dans l'écran, comme « I want to learn » : le graphe tourne autour. */
    transform: translate(calc(50vw - 50%), calc(50vh + 10px));
    z-index: 10;
    /* Seules la barre et la liste captent la souris : le graphe reste manipulable tout autour. */
    pointer-events: none;
    will-change: transform;
    transition:
      transform var(--move) var(--ease),
      width var(--move) var(--ease);
  }
  .search.compact {
    width: min(380px, calc(100vw - var(--reader-width) - 60px));
    transform: translate(20px, 20px);
  }

  /* Titre posé au-dessus de la barre, hors du flux : il s'efface sans décaler quoi que ce soit. */
  .brand {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 26px);
    text-align: center;
    pointer-events: none;
    transition:
      opacity 0.35s var(--ease),
      transform var(--move) var(--ease),
      visibility 0s linear 0s;
  }
  .compact .brand {
    opacity: 0;
    transform: translateY(-10px) scale(0.97);
    visibility: hidden;
    transition:
      opacity 0.2s ease-out,
      transform var(--move) var(--ease),
      visibility 0s linear 0.2s;
  }
  /* Direction « manuscrit élégant » : grande italique classique, sobre, sur la palette du thème. */
  .brand h1 {
    margin: 0;
    font-family: var(--font-manuscript);
    font-style: italic;
    font-weight: 500;
    font-size: clamp(42px, 7vw, 66px);
    line-height: 1.05;
    letter-spacing: 0.005em;
    color: #eef0f3;
    text-shadow: 0 2px 30px rgba(0, 0, 0, 0.6);
  }
  .brand p {
    margin: 6px 0 0;
    font-family: var(--font-manuscript);
    font-style: italic;
    font-size: 17px;
    color: #8c96a3;
  }

  .box,
  .results {
    pointer-events: auto;
  }
  .box {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 58px;
    padding: 0 18px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    backdrop-filter: blur(20px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.09);
    /* Seul accent : un filet bleu du thème sous la barre, comme un trait de plume. */
    border-bottom-color: hsla(215, 75%, 70%, 0.45);
    border-radius: 16px;
    box-shadow: var(--shadow-l), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition:
      border-color 0.2s,
      box-shadow 0.2s,
      height var(--move) var(--ease),
      border-radius var(--move) var(--ease),
      padding var(--move) var(--ease);
  }
  .compact .box {
    height: 44px;
    border-radius: 12px;
    padding: 0 14px;
  }
  .box:focus-within {
    border-color: hsla(215, 75%, 70%, 0.45);
    box-shadow: var(--shadow-l), 0 0 0 4px hsla(215, 75%, 70%, 0.08);
  }
  .box.has-results {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }

  .icon {
    flex: none;
    width: 20px;
    height: 20px;
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-linecap: round;
    opacity: 0.85;
  }

  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    background: none;
    border: 0;
    outline: 0;
    color: #eef0f3;
    font: inherit;
    font-size: 18px;
    transition: font-size var(--move) var(--ease);
    font-weight: 400;
    letter-spacing: 0.005em;
  }
  .compact input {
    font-size: 15px;
  }
  /* L'invitation est manuscrite ; le texte tapé reste dans la police du thème, pour la lisibilité. */
  input::placeholder {
    font-family: var(--font-manuscript);
    font-style: italic;
    font-size: 21px;
    color: rgba(238, 240, 243, 0.5);
  }
  .compact input::placeholder {
    font-size: 18px;
  }
  input::-webkit-search-cancel-button {
    display: none;
  }

  .clear {
    font-size: 20px;
    line-height: 1;
    color: var(--text-faint);
    padding: 4px 6px;
    border-radius: 6px;
  }
  .clear:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.06);
  }

  .results {
    position: relative;
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: min(56vh, 520px);
    overflow-y: auto;
    background: var(--glass);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    backdrop-filter: blur(20px) saturate(140%);
    border: 1px solid var(--border-soft);
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 0 0 16px 16px;
    box-shadow: var(--shadow-l);
  }
  .compact .results {
    border-radius: 0 0 12px 12px;
  }

  li {
    display: flex;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 10px;
    cursor: pointer;
  }
  li.active {
    background: rgba(255, 255, 255, 0.055);
  }
  .dot {
    flex: none;
    width: 9px;
    height: 9px;
    margin-top: 7px;
    border-radius: 50%;
    box-shadow: 0 0 10px currentColor;
  }
  .text {
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .title {
    font-weight: 600;
    color: #eef0f3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .path {
    font-size: 12px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .snippet {
    margin: 3px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .snippet mark {
    background: rgba(229, 181, 103, 0.18);
    color: var(--yellow);
    border-radius: 3px;
    padding: 0 1px;
  }
  .empty {
    cursor: default;
    color: var(--text-faint);
    font-size: 14px;
    justify-content: center;
    padding: 18px;
  }

  @media (max-width: 767px) {
    .search.compact {
      display: none;
    }
    input {
      font-size: 16px;
    }
    kbd,
    .path {
      display: none;
    }
  }
</style>
