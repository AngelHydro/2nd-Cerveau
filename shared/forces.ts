// Réglages de la physique du graphe, partagés par le serveur (disposition de départ, mise en cache)
// et le navigateur (animation en direct) : le graphe s'ouvre ainsi directement à l'équilibre.
// Réglés sur le vrai coffre pour un rendu aéré, sans chevauchement, proche du graphe d'Obsidian.
export const FORCES = {
  charge: -45,
  chargeDistanceMax: 400,
  gravity: 0.05,
  linkDistance: 28,
  linkStrength: 0.1,
  collideRadius: 7,
  collideStrength: 0.7,
  velocityDecay: 0.42,
  /** Précision de la répulsion (approximation de Barnes-Hut) et vitesse de refroidissement. */
  theta: 0.9,
  alphaDecay: 0.02,
} as const;
