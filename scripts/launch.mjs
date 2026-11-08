// Lanceur du Second Cerveau, sans terminal (via « Second Cerveau.vbs ») :
//  - icône du bureau : s'assure que le serveur tourne, puis ouvre la fenêtre de l'application ;
//  - `--serveur` (démarrage de Windows) : prépare seulement le serveur, qui reste prêt en arrière-plan.
// La fenêtre est l'application installée dans Firefox ou Brave (icône propre dans la barre des tâches,
// épinglable) ; tant qu'elle ne l'est pas, un onglet d'où l'installer.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logs = path.join(root, "logs");
mkdirSync(logs, { recursive: true });
const log = (msg) => appendFileSync(path.join(logs, "lanceur.log"), `[${new Date().toLocaleString("fr-FR")}] ${msg}\n`);
const cfgFile = path.join(root, "config.json");
const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
const url = `http://localhost:${process.env.SC_PORT ?? cfg.port ?? 4321}/`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", windowsHide: true, shell: cmd === "npm" });
  if (r.status !== 0) throw new Error(`« ${cmd} ${args.join(" ")} » a échoué :\n${r.stderr || r.stdout || r.error}`);
}

/** Date de modification la plus récente d'un fichier ou d'un dossier (récursivement). */
function newest(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...readdirSync(p).map((e) => newest(path.join(p, e))));
}

/** Dépendances et interface compilée : seulement si elles manquent ou si le code a changé. */
function prepare() {
  if (!existsSync(path.join(root, "node_modules"))) {
    log("Installation des dépendances…");
    run("npm", ["install", "--no-audit", "--no-fund"]);
  }
  const built = path.join(root, "web", "dist", "index.html");
  const sources = ["web/src", "web/public", "web/index.html", "shared", "vite.config.ts", "package.json"]
    .map((p) => path.join(root, p))
    .filter(existsSync);
  if (existsSync(built) && statSync(built).mtimeMs >= Math.max(...sources.map(newest))) return;
  log("Compilation de l'interface…");
  run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "error"]);
}

async function ping() {
  try {
    return (await fetch(`${url}api/ping`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Serveur en arrière-plan, sans fenêtre, qui reste prêt (le journal repart à zéro au-delà de 1 Mo). */
async function startServer() {
  if (await ping()) return log("Serveur déjà prêt.");
  const logFile = path.join(logs, "serveur.log");
  const tooBig = existsSync(logFile) && statSync(logFile).size > 1_000_000;
  const out = openSync(logFile, tooBig ? "w" : "a");
  spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  }).unref();
  for (let i = 0; i < 120; i++) {
    if (await ping()) return log("Serveur démarré.");
    await sleep(250);
  }
  throw new Error("Le serveur ne répond pas au bout de 30 s (voir logs/serveur.log).");
}

/**
 * Application installée dans Brave : profil et identifiant, ou `null`. Brave range l'icône de chaque
 * application installée dans un dossier `Web Applications/_crx_<identifiant>`, sous le nom de l'application.
 */
function installedApp() {
  const userData = path.join(process.env.LOCALAPPDATA ?? "", "BraveSoftware", "Brave-Browser", "User Data");
  if (!existsSync(userData)) return null;
  for (const profile of readdirSync(userData)) {
    const apps = path.join(userData, profile, "Web Applications");
    if (!existsSync(apps)) continue;
    const named = readdirSync(apps).find(
      (dir) => dir.startsWith("_crx_") && readdirSync(path.join(apps, dir)).some((f) => f.startsWith("Second Cerveau")),
    );
    if (named) return { profile, appId: named.slice("_crx_".length) };
  }
  return null;
}

/** Fenêtre de l'application installée dans Brave, sinon un onglet d'où l'installer. */
function openWindow() {
  // Application installée par Firefox (« Applications web de Firefox ») : on ouvre son raccourci.
  const firefoxApp = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Applications web de Firefox", "Second Cerveau.lnk");
  if (existsSync(firefoxApp)) {
    log("Ouverture de l'application installée dans Firefox.");
    spawn("cmd", ["/c", "start", "", firefoxApp], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const brave = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((dir) => path.join(dir, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    .find(existsSync);
  if (!brave) {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  // Pas encore installée : un onglet normal, où Brave propose l'installation (bouton « Installer
  // l'application » en bas à gauche de la page). Une simple fenêtre `--app=` resterait une fenêtre de
  // Brave pour Windows : épinglée, elle prendrait l'icône de Brave.
  const app = installedApp();
  const args = app ? [`--profile-directory=${app.profile}`, `--app-id=${app.appId}`] : [url];
  log(app ? `Ouverture de l'application installée (profil « ${app.profile} », ${app.appId}).` : "Application non installée : ouverture dans un onglet pour l'installer.");
  spawn(brave, args, { detached: true, stdio: "ignore" }).unref();
}

try {
  prepare();
  await startServer();
  if (!process.argv.includes("--serveur")) openWindow();
} catch (err) {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
