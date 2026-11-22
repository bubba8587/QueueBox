#!/bin/sh
# Puts `qb` on your PATH. Then, in any repository: `qb up`.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null || { echo "QueueBox needs Node 20 or newer: https://nodejs.org"; exit 1; }
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
ln -sf "$HERE/qb" "$BIN/qb"
echo "Installed: $BIN/qb"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add $BIN to your PATH (e.g. in ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
esac
echo
echo "Now, in any repository:  qb up"
