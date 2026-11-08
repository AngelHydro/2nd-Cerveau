import { mount } from "svelte";
import "katex/dist/katex.min.css";
// Italique manuscrite de l'accueil, embarquée dans l'application (aucun appel à un service extérieur).
import "@fontsource/cormorant-garamond/latin-400-italic.css";
import "@fontsource/cormorant-garamond/latin-500-italic.css";
import "./theme.css";
import "./reader.css";
import App from "./App.svelte";

/**
 * Ouverte comme application installée : on demande à Windows (via le serveur) d'agrandir la fenêtre,
 * le navigateur ne le faisant pas toujours. Si elle s'ouvre petite, on attend l'agrandissement avant de dessiner
 * le graphe, pour qu'il se forme directement à la bonne taille.
 */
async function maximizeWindow(): Promise<void> {
  // Les applications web de Firefox ne déclarent pas `standalone` : le serveur ne vise que leur fenêtre.
  if (!matchMedia("(display-mode: standalone)").matches && !/Firefox\//.test(navigator.userAgent)) return;
  const small = window.outerWidth < screen.availWidth - 16 || window.outerHeight < screen.availHeight - 16;
  const resized = new Promise<void>((resolve) => window.addEventListener("resize", () => resolve(), { once: true }));
  const request = fetch("/api/fenetre/agrandir", { method: "POST", signal: AbortSignal.timeout(4000) }).catch(() => undefined);
  if (!small) return;
  await request;
  await Promise.race([resized, new Promise((resolve) => setTimeout(resolve, 400))]);
}

void maximizeWindow().then(() => mount(App, { target: document.getElementById("app")! }));
