#!/bin/sh
# Install the published workspace dependencies and create missing configuration.
set -eu
REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$REPO_DIR"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22 or newer is required."); process.exit(1); }'
npm ci
for component in facilitator server frontend; do
  if [ ! -e "$component/.env" ]; then
    cp "$component/.env.example" "$component/.env"
    printf 'Created %s/.env\n' "$component"
  else
    printf 'Kept existing %s/.env\n' "$component"
  fi
done
printf '\nSet the preprod provider IDs and your receiving address in the .env files, then run npm run dev.\n'
