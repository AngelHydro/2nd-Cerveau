<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import { byLabel, fetchStats, folderLabel, formatCount, noteHash, type VaultStats } from "./api";

  interface Props {
    /** Version de l'index : les chiffres se rafraîchissent quand le coffre change. */
    version: number;
    onclose: () => void;
  }
  let { version, onclose }: Props = $props();

  let stats = $state<VaultStats | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    void version;
    const ctrl = new AbortController();
    fetchStats(ctrl.signal)
      .then((s) => {
        stats = s;
        error = null;
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") error = "Impossible de charger le tableau de bord.";
      });
    return () => ctrl.abort();
  });

  // Répartition en ordre alphabétique (libellés affichés, « Autres » en dernier), comme la légende.
  const groups = $derived(stats ? [...stats.byGroup].sort(byLabel((g) => folderLabel(g.label))) : []);
  const folders = $derived(
    stats
      ? [...stats.byClass].sort(byLabel((f) => folderLabel(f.folder))).map((f) => ({ ...f, classes: [...f.classes].sort(byLabel((c) => c.name)) }))
      : [],
  );

  // Une seule section à la fois : les chiffres du haut servent d'onglets.
  type Tab = "notes" | "missing" | "todo" | "isolated";
  let tab = $state<Tab>("notes");

  // Notes à créer : une ligne par note, dépliable, par pages de quinze.
  const PAGE = 15;
  let shown = $state(PAGE);
  let unfolded = $state<string | null>(null);

  function select(next: Tab) {
    tab = next;
    shown = PAGE;
    unfolded = null;
  }

  const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n > 1 ? many : one}`;
  const widthOf = (count: number, max: number) => `${Math.max(2, (count / Math.max(1, max)) * 100)}%`;

  const narrow = matchMedia("(max-width: 767px)").matches;
  const panelMotion = narrow ? { y: 36, duration: 320, easing: cubicOut } : { x: 56, duration: 380, easing: cubicOut };
</script>

<aside class="panel" aria-label="Tableau de bord" transition:fly|global={panelMotion}>
  <div class="bar">
    <button class="close" onclick={onclose} aria-label="Fermer le tableau de bord" title="Fermer (Échap)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
    </button>
    <h1>Tableau de bord</h1>
  </div>

  <div class="scroll">
    {#if error}
      <p class="state">{error}</p>
    {:else if !stats}
      <p class="state">Chargement…</p>
    {:else}
      <div class="content">
        <div class="figures" role="tablist" aria-label="Sections du tableau de bord">
          {#each [["notes", stats.notes, "notes"], ["missing", stats.missing.total, "à créer"], ["todo", stats.todo.length, "« À faire »"], ["isolated", stats.isolated.length, "isolées"]] as [key, count, label] (key)}
            <button role="tab" aria-selected={tab === key} class:active={tab === key} onclick={() => select(key as Tab)}>
              <strong>{formatCount(count as number)}</strong><span>{label}</span>
            </button>
          {/each}
        </div>

        {#if tab === "notes"}
          <section>
            <h2>Répartition <span>{plural(stats.links, "lien", "liens")} entre elles</span></h2>
            <ul class="bars">
              {#each groups as g (g.label)}
                {@const max = Math.max(...groups.map((x) => x.count))}
                <li>
                  <span class="bar-label">{folderLabel(g.label)}</span>
                  <span class="bar-track"><span class="bar-fill" style:width={widthOf(g.count, max)} style:background={g.color}></span></span>
                  <span class="bar-count">{formatCount(g.count)}</span>
                </li>
              {/each}
            </ul>
            {#each folders as folder (folder.folder)}
              {@const max = Math.max(...folder.classes.map((c) => c.count))}
              <details>
                <summary>{folderLabel(folder.folder)} par classe <span>{plural(folder.total, "note", "notes")}</span></summary>
                <ul class="bars">
                  {#each folder.classes as c (c.name)}
                    <li>
                      <span class="bar-label">{c.name}</span>
                      <span class="bar-track"><span class="bar-fill" style:width={widthOf(c.count, max)}></span></span>
                      <span class="bar-count">{formatCount(c.count)}</span>
                    </li>
                  {/each}
                </ul>
              </details>
            {/each}
          </section>
        {:else if tab === "missing"}
          <section>
            <p class="hint">Liens [[…]] qui ne mènent encore à aucune note, les plus cités d'abord. Clique sur une ligne pour voir les notes qui la citent.</p>
            {#if stats.missing.top.length}
              <ul class="missing">
                {#each stats.missing.top.slice(0, shown) as m (m.name)}
                  <li class:open={unfolded === m.name}>
                    <button class="missing-row" onclick={() => (unfolded = unfolded === m.name ? null : m.name)} aria-expanded={unfolded === m.name}>
                      <span class="chevron" aria-hidden="true">›</span>
                      <span class="missing-name">{m.name}</span>
                      <span class="missing-count">{plural(m.mentions, "mention", "mentions")}</span>
                    </button>
                    {#if unfolded === m.name}
                      <span class="sources">
                        {#each m.sources as src (src.id)}
                          <a class="pill small" href={noteHash(src.id)}><span class="dot" style:background={src.color}></span>{src.title}</a>
                        {/each}
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
              {#if shown < stats.missing.top.length}
                <button class="more" onclick={() => (shown += PAGE)}>Voir plus <span>({formatCount(stats.missing.top.length - shown)} restantes)</span></button>
              {/if}
            {:else}
              <p class="empty">Aucune : chaque lien mène à une note.</p>
            {/if}
          </section>
        {:else if tab === "todo"}
          <section>
            {#if stats.todo.length}
              <ul class="pills">
                {#each stats.todo as n (n.id)}
                  <li><a class="pill" href={noteHash(n.id)}><span class="dot" style:background={n.color}></span>{n.title}{#if n.empty}<em>vide</em>{/if}</a></li>
                {/each}
              </ul>
            {:else}
              <p class="empty">Aucune : toutes les notes sont traitées.</p>
            {/if}
          </section>
        {:else}
          <section>
            <p class="hint">Reliées à aucune autre note, ni dans un sens ni dans l'autre.</p>
            {#if stats.isolated.length}
              <ul class="pills">
                {#each stats.isolated as n (n.id)}
                  <li><a class="pill" href={noteHash(n.id)}><span class="dot" style:background={n.color}></span>{n.title}</a></li>
                {/each}
              </ul>
            {:else}
              <p class="empty">Aucune : chaque note est reliée au reste.</p>
            {/if}
          </section>
        {/if}
      </div>
    {/if}
  </div>
</aside>

<style>
  .panel {
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
  .bar h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
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
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .content {
    max-width: 720px;
    margin: 0 auto;
    padding: 28px 44px 80px;
    display: grid;
    gap: 40px;
  }
  .state {
    padding: 48px 32px;
    color: var(--text-muted);
    text-align: center;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  h2 span {
    margin-left: 6px;
    font-weight: 400;
  }
  .hint,
  .empty {
    margin: -4px 0 12px;
    font-size: 13px;
    color: var(--text-faint);
  }
  .empty {
    margin: 0;
  }

  .figures {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .figures button {
    display: grid;
    gap: 2px;
    padding: 14px 16px;
    border-radius: 12px;
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    text-align: left;
    transition:
      border-color 0.15s,
      background 0.15s;
  }
  .figures button:hover {
    border-color: rgba(255, 255, 255, 0.16);
  }
  .figures button.active {
    border-color: hsla(215, 75%, 70%, 0.5);
    background: hsla(215, 75%, 70%, 0.07);
  }
  .figures strong {
    font-size: 1.5rem;
    font-weight: 600;
    color: #eef0f3;
    font-variant-numeric: tabular-nums;
  }
  .figures span {
    font-size: 13px;
    color: var(--text-faint);
  }
  .figures button.active span {
    color: var(--accent);
  }

  .bars {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: grid;
    gap: 7px;
  }
  .bars li {
    display: grid;
    grid-template-columns: minmax(110px, 38%) 1fr 48px;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .bar-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .bar-track {
    height: 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.04);
  }
  .bar-fill {
    display: block;
    height: 100%;
    border-radius: 4px;
    background: var(--accent);
    opacity: 0.85;
  }
  .bar-count {
    text-align: right;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  details {
    margin-top: 6px;
    border-top: 1px solid var(--border-soft);
    padding-top: 8px;
  }
  summary {
    cursor: pointer;
    padding: 4px 0 8px;
    font-size: 14px;
    color: var(--text);
  }
  summary span {
    margin-left: 6px;
    font-size: 12px;
    color: var(--text-faint);
  }

  .missing {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .missing li {
    border-bottom: 1px solid var(--border-soft);
  }
  .missing-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 9px 4px;
    text-align: left;
  }
  .missing-row:hover .missing-name {
    color: #eef0f3;
  }
  .chevron {
    flex: none;
    width: 10px;
    color: var(--text-faint);
    transition: transform 0.15s;
  }
  li.open .chevron {
    transform: rotate(90deg);
  }
  .missing-name {
    flex: 1;
    min-width: 0;
    color: var(--text);
    font-size: 14px;
  }
  .missing-count {
    font-size: 12px;
    color: var(--text-faint);
    white-space: nowrap;
  }
  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 4px 12px 24px;
  }
  .more {
    margin-top: 14px;
    padding: 7px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 13px;
  }
  .more:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }
  .more span {
    color: var(--text-faint);
  }

  .pills {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .pill {
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
  .pill.small {
    padding: 3px 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .pill:hover {
    border-color: rgba(255, 255, 255, 0.18);
  }
  .pill em {
    font-style: normal;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 6px;
    background: rgba(229, 181, 103, 0.15);
    color: #e5b567;
  }
  .dot {
    flex: none;
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  @media (max-width: 767px) {
    .figures {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .panel {
      width: 100%;
      border-left: 0;
    }
    .content {
      padding: 20px 20px 64px;
    }
  }
</style>
