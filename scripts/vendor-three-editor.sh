#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
destination="$repo_root/vendor/three-editor-r185"
checkout="$(mktemp -d)"
trap 'rtk rm -rf "$checkout"' EXIT

rtk git clone --depth 1 --branch r185 https://github.com/mrdoob/three.js.git "$checkout/three"
if [[ -f "$destination/UPSTREAM.md" ]]; then
  rtk cp "$destination/UPSTREAM.md" "$checkout/UPSTREAM.md"
fi
rtk rm -rf "$destination"
rtk mkdir -p "$destination/examples"
rtk mkdir -p "$destination/files"
rtk cp -R "$checkout/three/editor" "$destination/editor"
rtk cp -R "$checkout/three/build" "$destination/build"
rtk cp -R "$checkout/three/examples/jsm" "$destination/examples/jsm"
rtk cp -R "$checkout/three/examples/fonts" "$destination/examples/fonts"
rtk cp "$checkout/three/files/favicon.ico" "$checkout/three/files/favicon_white.ico" "$destination/files/"
rtk cp "$checkout/three/LICENSE" "$destination/LICENSE"
if [[ -f "$checkout/UPSTREAM.md" ]]; then
  rtk cp "$checkout/UPSTREAM.md" "$destination/UPSTREAM.md"
fi
