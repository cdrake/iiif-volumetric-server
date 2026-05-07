#!/bin/bash
# Double-click this file in Finder to start the IIIF volumetric dev server.
# It opens a Terminal window, hot-reloads on file changes (npm run dev),
# and leaves the window open so you can see logs.
cd "$(dirname "$0")" || exit 1
echo "Starting IIIF volumetric server (dev mode, hot reload on file change)…"
echo "Working directory: $(pwd)"
echo "Open http://127.0.0.1:8080/ in your browser."
echo ""
exec npm run dev
