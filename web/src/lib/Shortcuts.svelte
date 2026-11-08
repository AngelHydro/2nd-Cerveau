<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";

  /** Chaque raccourci : les touches (affichées une par une) et ce qu'elles font. */
  const SHORTCUTS: Array<{ keys: string[]; does: string }> = [
    { keys: ["/"], does: "Rechercher (ou Ctrl+K)" },
    { keys: ["↑", "↓", "Entrée"], does: "Choisir un résultat de recherche" },
    { keys: ["Échap"], does: "Effacer la recherche, fermer la note ou le tableau de bord" },
    { keys: ["Maj", "clic"], does: "Sur deux notes du graphe : le chemin qui les relie" },
    { keys: ["Maj", "clic"], does: "Dans le vide (ou Échap) : annuler le chemin commencé" },
    { keys: ["?"], does: "Afficher ou masquer cette aide" },
  ];
</script>

<div class="shortcuts" role="dialog" aria-label="Raccourcis clavier" transition:fly={{ y: 8, duration: 180, easing: cubicOut }}>
  <p class="head">Raccourcis</p>
  <ul>
    {#each SHORTCUTS as s, i (i)}
      <li>
        <span class="keys">{#each s.keys as k, j (j)}{#if j > 0 && k === "clic"}<span class="plus">+</span>{/if}<kbd>{k}</kbd>{/each}</span>
        <span class="does">{s.does}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .shortcuts {
    position: absolute;
    left: 20px;
    bottom: 66px;
    z-index: 11;
    width: min(420px, calc(100vw - 40px));
    padding: 10px 12px 12px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border-soft);
    border-radius: 12px;
    box-shadow: var(--shadow-l);
  }
  .head {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--text-faint);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  li {
    display: grid;
    grid-template-columns: 128px 1fr;
    align-items: center;
    gap: 12px;
    font-size: 13px;
  }
  .keys {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .plus {
    color: var(--text-faint);
  }
  kbd {
    min-width: 22px;
    padding: 2px 6px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.04);
    font: inherit;
    font-size: 12px;
    text-align: center;
    color: var(--text);
  }
  .does {
    color: var(--text-muted);
  }
</style>
