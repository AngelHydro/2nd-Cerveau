// Style commun aux graphes Sigma, calqué sur la vue graphe d'Obsidian :
// noms centrés sous les points, sans encadré ; au survol, seul le nom de la note survolée s'affiche, plus lumineux.

export const LABEL_FONT = '-apple-system, "Segoe UI", Roboto, Inter, sans-serif';

interface NodeData {
  x: number;
  y: number;
  size: number;
  label?: string | null;
  color: string;
}

interface LabelSettings {
  labelSize: number;
  labelFont: string;
  labelWeight: string;
  labelColor: { color?: string };
}

function centeredLabel(ctx: CanvasRenderingContext2D, d: NodeData, size: number, weight: string, font: string, color: string): void {
  const label = d.label ?? "";
  if (!label) return;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // Léger halo couleur du fond : le texte reste lisible par-dessus les liens.
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(28, 33, 39, 0.85)";
  ctx.strokeText(label, d.x, d.y + d.size + 4);
  ctx.fillStyle = color;
  ctx.fillText(label, d.x, d.y + d.size + 4);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

export function drawLabel(ctx: CanvasRenderingContext2D, d: NodeData, settings: LabelSettings): void {
  centeredLabel(ctx, d, settings.labelSize, settings.labelWeight, settings.labelFont, settings.labelColor.color ?? "#b7bec7");
}

export function drawHover(ctx: CanvasRenderingContext2D, d: NodeData, settings: LabelSettings): void {
  centeredLabel(ctx, d, settings.labelSize + 2, "600", settings.labelFont, "#f1f3f5");
}
