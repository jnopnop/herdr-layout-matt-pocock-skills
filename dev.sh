#!/bin/sh
# Live development: keeps Herdr's copy of this layout in step with this checkout.
#
#   ./dev.sh start    install a per-user LaunchAgent (macOS) that syncs in the background,
#                     now and after every login, until ./dev.sh stop
#   ./dev.sh stop     remove that LaunchAgent (Herdr keeps the last synced copy)
#   ./dev.sh run      sync in the foreground (Linux, or to watch it work); Ctrl-C stops
#   ./dev.sh status
#
# Why copy and not symlink: Herdr watches its own folder and does not follow links out
# of it, so edits behind a symlink never reload. A copy written with an atomic rename
# looks like any other save, and Herdr hot-reloads it within a second.
set -e

here=$(cd "$(dirname "$0")" && pwd)
home_dir="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
label="dev.herdr.mattpocock-skills.sync"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/$label.log"
# Herdr writes these into every mod folder; they're not ours.
HERDR_OWNED="gpui-kit.d.ts jsconfig.json"

owned() { for n in $HERDR_OWNED; do [ "$1" = "$n" ] && return 0; done; return 1; }

# One pass: copy what changed (temp file + rename), drop files removed from the checkout.
sync_once() {
  cd "$here"
  for f in $(find layouts mods -type f ! -name '.*' | sort); do
    dest="$home_dir/$f"
    if ! cmp -s "$f" "$dest" 2>/dev/null; then
      mkdir -p "$(dirname "$dest")"
      cp "$f" "$dest.sync-tmp" && mv -f "$dest.sync-tmp" "$dest"
      echo "$(date '+%H:%M:%S') synced $f"
    fi
  done
  for d in mods/*/; do
    d=${d%/}
    [ -d "$home_dir/$d" ] || continue
    for dest in "$home_dir/$d"/*; do
      [ -f "$dest" ] || continue
      name=${dest##*/}
      if [ ! -e "$d/$name" ] && ! owned "$name"; then
        rm -f "$dest"; echo "$(date '+%H:%M:%S') removed $d/$name"
      fi
    done
  done
}

case "${1:-}" in
  once) sync_once ;;
  run)
    [ -d "$home_dir" ] || { echo "Herdr's folder isn't at $home_dir. Start Herdr once first."; exit 1; }
    echo "Syncing $here -> $home_dir (Ctrl-C to stop)"
    while :; do sync_once; sleep 1; done ;;
  start)
    [ "$(uname)" = Darwin ] || { echo "start is macOS only; use ./dev.sh run"; exit 1; }
    "$here/install.sh"   # copies, checks the mods, switches Herdr to the layout
    mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$here/dev.sh</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>HERDR_APP_HOME</key><string>$home_dir</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "Live sync on. Edits here reach Herdr within a second. Log: $log" ;;
  stop)
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "Live sync off." ;;
  status)
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then echo "Live sync on. Log: $log"; tail -5 "$log" 2>/dev/null || true
    else echo "Live sync off."; fi ;;
  *) echo "usage: $0 start | stop | run | status"; exit 2 ;;
esac
