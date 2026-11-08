# 2nd Cerveau

Interface de lecture, **en lecture seule**, d'un coffre [Obsidian](https://obsidian.md) : un graphe plein écran de toutes les notes, une recherche centrée et un lecteur de notes (liens `[[…]]`, encadrés, formules KaTeX, diagrammes Mermaid, notes de bas de page).

Le dépôt ne contient que le code : les notes restent dans ton coffre, que l'application lit sans jamais le modifier.

## Installation

Prérequis : [Node.js](https://nodejs.org) 22 ou plus.

```bash
npm install
cp config.example.json config.json
```

Dans `config.json`, renseigne :

| Champ | Rôle |
|---|---|
| `vaultPath` | Racine du coffre (le dossier qui contient `.obsidian/`) |
| `wikiDir` | Sous-dossier indexé, relatif au coffre (`Wiki` par défaut) |
| `host` | `127.0.0.1` : cet ordinateur seulement ; `0.0.0.0` : aussi les appareils du réseau local (téléphone), **sans mot de passe** |
| `port` | Port du serveur (`4321` par défaut) |
| `browser` | *Mac, facultatif* : `"firefox"` ou `"safari"` pour choisir le navigateur qu'ouvre `Second Cerveau.app` |

Les variables d'environnement `SC_VAULT`, `SC_HOST` et `SC_PORT` remplacent ces valeurs sans modifier le fichier.

## Lancement

```bash
npm start
```

Puis ouvre <http://localhost:4321>. Le serveur surveille le coffre : l'interface se met à jour seule quand une note change.

| Commande | Rôle |
|---|---|
| `npm run dev` | Développement (rechargement à chaud) |
| `npm test` | Tests, sur un petit coffre d'exemple (`tests/fixtures/vault`) |
| `npm run check:vault` | Contrôle du vrai coffre : indexation, liens et rendu de toutes les notes |

### Windows

- `Second Cerveau.vbs` lance le serveur sans fenêtre de terminal et ouvre l'application. Avec `/serveur`, il prépare seulement le serveur ; place-le dans le dossier *Démarrage* pour qu'il soit prêt à l'ouverture de session. Les journaux vont dans `logs/`.
- `Second Cerveau.bat` fait la même chose dans un terminal, pratique pour déboguer.
- Installée comme application web (Firefox ou Brave), l'interface a sa propre icône dans la barre des tâches.

### Mac

- **`Second Cerveau.app`** (double-clic) : démarre le serveur sans terminal, puis ouvre l'interface. Pour l'avoir dans le **Dock**, glisse-la dans le Dock **depuis le dossier du projet**. Elle doit rester dans ce dossier : ne la déplace pas dans *Applications*.
  - Au premier lancement, macOS peut la bloquer, car elle n'est pas signée. Fais alors *clic droit › Ouvrir*, une seule fois.
  - Le navigateur ouvert est, dans l'ordre :
    1. l'application Safari, si tu l'as créée (*Fichier › Ajouter au Dock* sur la page, macOS 14 et plus) ;
    2. sinon, le navigateur choisi par `browser` ;
    3. sinon, Firefox s'il est installé ;
    4. sinon, le navigateur par défaut.
  - Le serveur reste ensuite prêt en arrière-plan. Les journaux vont dans `logs/`.
- **`Second Cerveau.command`** (double-clic) : la même chose dans une fenêtre Terminal, pratique pour déboguer. Ferme la fenêtre pour arrêter le serveur.
- Node.js est cherché dans les emplacements habituels : Homebrew, l'installateur officiel et nvm.

## Organisation du coffre

Toutes les notes `.md` de `wikiDir` sont indexées. Les couleurs du graphe viennent des groupes de couleurs d'Obsidian (`.obsidian/graph.json`, requêtes `path:"…"`).

Quelques dossiers ont un traitement particulier, propre à mon coffre, dans `server/vault.ts` :
- `Books`, `Vidéos`, `Articles` et `Sites Web` sont rangés en *classe / sous-classe*, et `Arts` en *sous-classe* ;
- `Personnality & organisations` regroupe deux dossiers d'entités.

Un autre coffre fonctionne aussi : ces dossiers sont simplement absents.

## Licence

[MIT](LICENSE)
