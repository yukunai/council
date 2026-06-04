#!/usr/bin/env bash
# Build council (Tauri release) and install it into /Applications.
#   npm run release      # full build (tsc + vite + Rust release) then install
#   npm run reinstall    # install the last build, skipping the ~1min Rust compile
#
# Does NOT kill a running council — replacing the bundle is safe; just relaunch
# the app afterwards to pick up the new build (avoids interrupting an open session).
set -euo pipefail

cd "$(dirname "$0")/.."

skip_build=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

app="src-tauri/target/release/bundle/macos/council.app"
dest="/Applications/council.app"

if [ "$skip_build" -eq 0 ]; then
  npm run tauri build
fi

if [ ! -d "$app" ]; then
  echo "no build found at $app — run without --skip-build first" >&2
  exit 1
fi

rm -rf "$dest"
cp -R "$app" "$dest"
ver=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$dest/Contents/Info.plist" 2>/dev/null || echo "?")
echo "installed council $ver → $dest"
echo "(relaunch council to pick up the new build)"
