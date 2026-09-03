#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
YTDLP_BIN="$BIN_DIR/yt-dlp"

mkdir -p "$BIN_DIR"

# Install python3.10 via nix if needed (required by modern yt-dlp)
if ! command -v python3.10 &>/dev/null; then
  echo "[setup] Installing python3.10 via nix..."
  nix-env -iA nixpkgs.python310 2>&1 | tail -3
fi

# Always update yt-dlp to the latest master build for the freshest YouTube fixes.
echo "[setup] Updating yt-dlp to latest master..."
if curl -sSL "https://github.com/yt-dlp/yt-dlp-master-builds/releases/latest/download/yt-dlp" -o "${YTDLP_BIN}.tmp"; then
  chmod +x "${YTDLP_BIN}.tmp"
  mv "${YTDLP_BIN}.tmp" "$YTDLP_BIN"
  echo "[setup] yt-dlp updated: $(python3.10 "$YTDLP_BIN" --version 2>/dev/null)"
else
  echo "[setup] Master download failed; trying stable fallback..."
  if curl -sSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "${YTDLP_BIN}.tmp"; then
    chmod +x "${YTDLP_BIN}.tmp"
    mv "${YTDLP_BIN}.tmp" "$YTDLP_BIN"
    echo "[setup] yt-dlp stable: $(python3.10 "$YTDLP_BIN" --version 2>/dev/null)"
  elif [ -f "$YTDLP_BIN" ]; then
    echo "[setup] Using cached yt-dlp: $(python3.10 "$YTDLP_BIN" --version 2>/dev/null)"
  fi
fi
