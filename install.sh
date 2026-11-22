#!/bin/sh
# Puts `qb` on your PATH. Then, in any repository: `qb up`.
#
# From a checkout:   ./install.sh
# In one line:       curl -fsSL https://raw.githubusercontent.com/bubba8587/QueueBox/main/install.sh | sh
#
# Piped, it has no checkout of its own: it clones QueueBox into $QUEUEBOX_HOME (~/.local/share/queuebox), or updates
# the clone it made before, and links that. Run again to update.
set -e
REPO="${QUEUEBOX_REPO:-https://github.com/bubba8587/QueueBox.git}"
command -v node >/dev/null || { echo "QueueBox needs Node 20 or newer: https://nodejs.org"; exit 1; }
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] || { echo "QueueBox needs Node 20 or newer; this is Node $(node -v)."; exit 1; }

# A checkout is a folder with qb beside this script; piped, there is none.
HERE=""
case "$0" in
  */install.sh) HERE="$(cd "$(dirname "$0")" && pwd)" ;;
esac
if [ -n "$HERE" ] && [ -f "$HERE/qb" ]; then
  SRC="$HERE"
else
  command -v git >/dev/null || { echo "Installing from GitHub needs git."; exit 1; }
  SRC="${QUEUEBOX_HOME:-$HOME/.local/share/queuebox}"
  if [ -d "$SRC/.git" ]; then
    echo "Updating $SRC"
    git -C "$SRC" pull --ff-only --quiet
  elif [ -e "$SRC" ] && [ -n "$(ls -A "$SRC" 2>/dev/null)" ]; then
    echo "$SRC exists and isn't a QueueBox clone. Move it, or set QUEUEBOX_HOME to another folder."
    exit 1
  else
    echo "Cloning QueueBox into $SRC"
    mkdir -p "$(dirname "$SRC")"
    git clone --quiet --depth 1 "$REPO" "$SRC"
  fi
fi

BIN="$HOME/.local/bin"
mkdir -p "$BIN"
chmod +x "$SRC/qb"
ln -sf "$SRC/qb" "$BIN/qb"
echo "Installed: $BIN/qb -> $SRC/qb"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add $BIN to your PATH (e.g. in ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
esac
echo
echo "Now, in any repository:  qb up"
