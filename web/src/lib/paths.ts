import type { GraphPayload } from "./api";

/**
 * Plus court chemin entre deux notes, en suivant les liens dans les deux sens (parcours en largeur).
 * Les notes pas encore créées ne servent pas d'étape. Renvoie les identifiants du départ à l'arrivée,
 * ou `null` si les deux notes ne sont reliées par aucune chaîne.
 */
export function shortestPath(graph: Pick<GraphPayload, "nodes" | "edges">, from: string, to: string): string[] | null {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const start = index.get(from);
  const goal = index.get(to);
  if (start === undefined || goal === undefined) return null;
  if (start === goal) return [from];
  const usable = (i: number) => !graph.nodes[i].unresolved;
  const next: number[][] = graph.nodes.map(() => []);
  for (const [a, b] of graph.edges) {
    if (!usable(a) || !usable(b)) continue;
    next[a].push(b);
    next[b].push(a);
  }
  const previous = new Map<number, number>([[start, -1]]);
  let frontier = [start];
  while (frontier.length && !previous.has(goal)) {
    const following: number[] = [];
    for (const i of frontier) {
      for (const j of next[i]) {
        if (previous.has(j)) continue;
        previous.set(j, i);
        following.push(j);
      }
    }
    frontier = following;
  }
  if (!previous.has(goal)) return null;
  const chain: string[] = [];
  for (let i = goal; i !== -1; i = previous.get(i)!) chain.push(graph.nodes[i].id);
  return chain.reverse();
}
