<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import { folderLabel, formatCount, type LegendEntry } from "./api";

  interface Props {
    entries: LegendEntry[];
    hidden: Set<number>;
    ontoggle: (index: number) => void;
    onreset: () => void;
  }
  let { entries, hidden, ontoggle, onreset }: Props = $props();
</script>

<div class="legend" role="group" aria-label="Légende du graphe" transition:fly={{ y: 8, duration: 180, easing: cubicOut }}>
  <p class="head">
    <span>Afficher dans le graphe</span>
    {#if hidden.size}<button class="reset" onclick={onreset}>tout afficher</button>{/if}
  </p>
  <ul>
    {#each entries as e (e.index)}
      <li>
        <button class:off={hidden.has(e.index)} onclick={() => ontoggle(e.index)} aria-pressed={!hidden.has(e.index)}>
          <span class="dot" style:background={e.color}></span>
          <span class="label">{folderLabel(e.label)}</span>
          <span class="count">{formatCount(e.count)}</span>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .legend {
    position: absolute;
    left: 20px;
    bottom: 66px;
    z-index: 11;
    width: 260px;
    max-height: min(60vh, 520px);
    overflow-y: auto;
    padding: 8px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border-soft);
    border-radius: 12px;
    box-shadow: var(--shadow-l);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 2px 6px 6px;
    font-size: 12px;
    color: var(--text-faint);
  }
  .reset {
    font-size: 12px;
    color: var(--accent);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li button {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 6px 8px;
    border-radius: 8px;
    font-size: 13px;
    color: var(--text);
    text-align: left;
  }
  li button:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .dot {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    transition: opacity 0.15s;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    font-size: 12px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  button.off {
    color: var(--text-faint);
  }
  button.off .label {
    text-decoration: line-through;
  }
  button.off .dot {
    opacity: 0.3;
  }
</style>
