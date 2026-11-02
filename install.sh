#!/bin/sh
# metacom installer:  curl -fsSL https://metacom.dev/install.sh | sh
#
# Installs the hub and the metacom command into ~/.metacom (no sudo, no global npm): downloads the
# release tarball, checks its SHA-256, installs each part's dependencies, and puts `metacom`, `mc` and
# `metacom-hub` in ~/.metacom/bin.
#
#   METACOM_VERSION=0.1.0       which release (default: this installer's)
#   METACOM_HOME=~/.metacom     where to install
#   METACOM_TARBALL=<url>       a tarball elsewhere (file:// works); its checksum at <url>.sha256
#   METACOM_NO_MODIFY_PATH=1    don't add ~/.metacom/bin to your shell's PATH
#
# Needs Node.js 22+ and, to build the terminal library, a compiler: python3, make and g++ on Linux,
# the Xcode command line tools on macOS.
#
# Uninstall: rm -rf ~/.metacom, and remove the "metacom" line from ~/.profile (and ~/.zshrc).
# Your hub's data is in ~/.local/share/metacom-hub and your sign-in in ~/.config/metacom-hub.
set -eu

VERSION="${METACOM_VERSION:-0.1.0}"
HOME_DIR="${METACOM_HOME:-$HOME/.metacom}"
URL="${METACOM_TARBALL:-https://github.com/metacomdev/metacom/releases/download/v$VERSION/metacom-$VERSION.tar.gz}"

say() { printf '%s\n' "$*"; }
fail() { printf 'metacom install: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is needed: https://nodejs.org (or: nvm install 22)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "Node.js $(node -v) found; 22 or newer is needed (nvm install 22)"
command -v npm >/dev/null 2>&1 || fail "npm is needed; it comes with Node.js"
command -v tar >/dev/null 2>&1 || fail "tar is needed"
# the terminal library (node-pty) is compiled on install
case "$(uname -s)" in
  Darwin) xcode-select -p >/dev/null 2>&1 || fail "the Xcode command line tools are needed: xcode-select --install" ;;
  *) for tool in python3 make g++; do
       command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed to build the terminal library: sudo apt install python3 make g++ (Debian/Ubuntu) or sudo dnf install python3 make gcc-c++ (Fedora)"
     done ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else fail "curl or wget is needed"; fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
say "metacom $VERSION: downloading"
fetch "$URL" "$tmp/metacom.tar.gz" || fail "could not download $URL"
fetch "$URL.sha256" "$tmp/metacom.tar.gz.sha256" || fail "could not download the checksum ($URL.sha256)"
expected=$(cut -d' ' -f1 < "$tmp/metacom.tar.gz.sha256")
actual=$(sha256 "$tmp/metacom.tar.gz")
[ "$expected" = "$actual" ] || fail "checksum mismatch: expected $expected, got $actual"

say "installing into $HOME_DIR"
rm -rf "$HOME_DIR/app.new"
mkdir -p "$HOME_DIR/app.new" "$HOME_DIR/bin"
tar -xzf "$tmp/metacom.tar.gz" -C "$HOME_DIR/app.new" --strip-components=1
for part in metacom hub cli; do
  say "  $part: dependencies"
  (cd "$HOME_DIR/app.new/$part" && npm install --omit=dev --no-audit --no-fund --update-notifier=false --loglevel=error >/dev/null) || fail "npm install failed in $part"
done
rm -rf "$HOME_DIR/app"
mv "$HOME_DIR/app.new" "$HOME_DIR/app"

launcher() {
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$2" > "$HOME_DIR/bin/$1"
  chmod +x "$HOME_DIR/bin/$1"
}
launcher metacom "$HOME_DIR/app/cli/bin/metacom.js"
launcher mc "$HOME_DIR/app/cli/bin/mc.js"
launcher metacom-hub "$HOME_DIR/app/hub/server.js"

on_path=no
case ":$PATH:" in *":$HOME_DIR/bin:"*) on_path=yes ;; esac
if [ "$on_path" = no ] && [ "${METACOM_NO_MODIFY_PATH:-}" != 1 ]; then
  line="export PATH=\"$HOME_DIR/bin:\$PATH\"  # metacom"
  for rc in "$HOME/.profile" "$HOME/.zshrc"; do
    if [ "$rc" = "$HOME/.profile" ] || [ -f "$rc" ]; then
      grep -qs '# metacom$' "$rc" || printf '\n%s\n' "$line" >> "$rc"
    fi
  done
fi

say ""
say "metacom $VERSION is installed."
[ "$on_path" = yes ] || say "Open a new terminal (or run: export PATH=\"$HOME_DIR/bin:\$PATH\")."
say ""
say "  metacom-hub                    # start your hub (keep it running)"
say "  metacom connect ws://127.0.0.1:8900 \"\$(cat ~/.local/share/metacom-hub/bootstrap-token.txt)\""
say "  metacom dev -n builder claude  # an agent joins room dev; you: metacom dev -n you"
