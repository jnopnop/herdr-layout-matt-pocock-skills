#!/bin/sh
# Installs the mattpocock-skills Herdr layout into ~/.config/herdr-app (or $HERDR_APP_HOME).
#
#   ./install.sh                       install (or update) the layout and its mod
#   ./install.sh --uninstall [--force] remove them
#
# Never overwrites anything it didn't put there. Developing the layout? See ./dev.sh.
set -e

LAYOUT=mattpocock-skills
MODS="mattpocock-workflow"
HERDR_OWNED="gpui-kit.d.ts jsconfig.json"   # Herdr writes these into every mod folder

here=$(cd "$(dirname "$0")" && pwd)
home_dir="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

items() {
  echo "layouts/$LAYOUT.json"
  echo "layouts/$LAYOUT.svg"
  for m in $MODS; do echo "mods/$m"; done
}

# Left in the mod folder by every install, so updates and uninstalls know the files are ours.
# Hidden, so Herdr ignores it.
MARKER=".installed-by-herdr-layout-mattpocock-skills"
installed() { [ -f "$home_dir/mods/${MODS%% *}/$MARKER" ]; }

# Ours: installed by this script, a symlink (old dev setups), or a copy of these exact files.
ours() {
  target="$home_dir/$1"
  { installed || [ -L "$target" ]; } && return 0
  if [ -d "$here/$1" ]; then
    excludes=""
    for n in $HERDR_OWNED; do excludes="$excludes -x $n"; done
    # shellcheck disable=SC2086
    diff -rq $excludes "$here/$1" "$target" >/dev/null 2>&1
  else
    cmp -s "$here/$1" "$target"
  fi
}

case "${1:-}" in
  "") ;;
  --uninstall)
    mine=0; installed && mine=1
    for p in $(items); do
      if [ -e "$home_dir/$p" ] || [ -L "$home_dir/$p" ]; then
        if [ $mine = 1 ] || ours "$p" || [ "${2:-}" = "--force" ]; then rm -rf "$home_dir/$p"; echo "removed $p"
        else echo "skipped $p: it differs from this checkout (add --force to remove it anyway)"; fi
      fi
    done
    exit 0 ;;
  *) echo "usage: $0 [--uninstall [--force]]"; exit 2 ;;
esac

[ -d "$home_dir" ] || { echo "Herdr's folder isn't at $home_dir. Start Herdr once first."; exit 1; }
mkdir -p "$home_dir/layouts" "$home_dir/mods"

# Check everything first, so a conflict leaves the existing install untouched.
for p in $(items); do
  if { [ -e "$home_dir/$p" ] || [ -L "$home_dir/$p" ]; } && ! ours "$p" && [ "${UPDATE:-}" != 1 ]; then
    echo "$home_dir/$p already exists and isn't from this layout."
    echo "Move it aside, or run UPDATE=1 ./install.sh to replace it with this version."; exit 1
  fi
done

for p in $(items); do rm -rf "${home_dir:?}/$p"; cp -R "$here/$p" "$home_dir/$p"; done
touch "$home_dir/mods/${MODS%% *}/$MARKER"

if command -v herdr-app >/dev/null 2>&1; then
  for m in $MODS; do herdr-app check "$home_dir/mods/$m"; done
  if herdr-app do layout.switch "{\"name\":\"$LAYOUT\"}" >/dev/null 2>&1; then
    echo "Installed. Herdr now shows the $LAYOUT layout; ctrl-shift-l cycles layouts."
    exit 0
  fi
fi
echo "Installed. In Herdr, press ctrl-shift-l until the $LAYOUT layout shows."
