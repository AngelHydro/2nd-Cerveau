import os from "node:os";
import qrcode from "qrcode-terminal";
import { createServer } from "./app.ts";
import { loadConfig } from "./config.ts";
import { maximizeAppWindow } from "./window.ts";

let cfg;
let server;
try {
  cfg = loadConfig();
  server = await createServer(cfg, { watch: true, log: console.log, maximizeWindow: () => maximizeAppWindow("Second Cerveau") });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
try {
  await server.app.listen({ host: cfg.host, port: cfg.port });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
  // Déjà lancé (double-clic en trop) : le navigateur s'ouvre quand même sur l'instance existante.
  console.log(`Le Second Cerveau tourne déjà : http://localhost:${cfg.port}`);
  await server.close();
  process.exit(0);
}

const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
console.log(`\nSecond Cerveau : http://localhost:${cfg.port}`);
if (lan && cfg.host === "0.0.0.0") {
  const url = `http://${lan}:${cfg.port}`;
  console.log(`Sur ton téléphone (même Wi-Fi) : ${url}\n`);
  // En arrière-plan (lancé au démarrage de Windows), la sortie va dans un journal : pas de QR code.
  if (process.stdout.isTTY) qrcode.generate(url, { small: true });
}
