import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// L'interface vit dans web/ ; en développement, /api et /files sont relayés vers le serveur.
export default defineConfig({
  root: "web",
  plugins: [svelte()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4321",
      "/files": "http://localhost:4321",
    },
  },
});
