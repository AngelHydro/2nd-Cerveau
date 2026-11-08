#!/bin/bash
# Lance le Second Cerveau dans un terminal (macOS) : compile l'interface, démarre le serveur puis ouvre
# le navigateur. Ferme cette fenêtre pour arrêter le serveur. Sans terminal : « Second Cerveau.app ».
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ ! -d node_modules ]; then
  echo "Première installation des dépendances…"
  npm install --no-audit --no-fund || { read -rp "Échec (voir ci-dessus). Entrée pour fermer."; exit 1; }
fi
npx vite build --logLevel error || { read -rp "Échec (voir ci-dessus). Entrée pour fermer."; exit 1; }

port="$(node -e 'try{console.log(require("./config.json").port??4321)}catch{console.log(4321)}')"
(sleep 3 && open "http://localhost:$port") &
node --import tsx server/main.ts || read -rp "Le Second Cerveau n'a pas pu démarrer (voir ci-dessus). Entrée pour fermer."
