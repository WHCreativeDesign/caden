#!/usr/bin/env bash
# Re-vendor the SAM (Software Automatic Mouth) TTS engine's browser build
# into public/vendor/ after bumping the sam-js devDependency. The frontend
# has no bundler/build step, so this is a plain static-file copy, not a
# build — same pattern as scripts/gen-sfx.mjs generating committed assets.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

mkdir -p public/vendor
cp node_modules/sam-js/dist/samjs.min.js public/vendor/samjs.min.js
echo "vendored node_modules/sam-js/dist/samjs.min.js -> public/vendor/samjs.min.js"
