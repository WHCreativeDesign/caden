#!/usr/bin/env bash
# The single-line installer:
#   curl -fsSL https://raw.githubusercontent.com/WHCreativeDesign/caden/main/scripts/bootstrap.sh | bash
#
# Clones (or updates) the repo, then hands off to scripts/install.sh for
# everything else. Safe to run again later to update in place.
set -euo pipefail

REPO_URL="https://github.com/WHCreativeDesign/caden.git"
BRANCH="${CADEN_BRANCH:-main}"
INSTALL_DIR="${CADEN_DIR:-$HOME/caden}"

C_AMBER=$'\033[93m'
C_DIM=$'\033[2m'
C_BOLD=$'\033[1m'
C_RESET=$'\033[0m'

printf "\n  %s%sCADEN%s  %s// bootstrap%s\n\n" "$C_BOLD" "$C_AMBER" "$C_RESET" "$C_DIM" "$C_RESET"

if ! command -v git >/dev/null 2>&1; then
  echo "  Installing git…"
  if [ "$(id -u)" -eq 0 ]; then apt-get update -y && apt-get install -y git
  else sudo apt-get update -y && sudo apt-get install -y git
  fi
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Existing checkout at $INSTALL_DIR — updating to origin/$BRANCH."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  echo "  Cloning into $INSTALL_DIR…"
  git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# This script's own stdin is the curl pipe (already exhausted by the time
# we get here) when invoked as `curl ... | bash` — install.sh's interactive
# key prompts read explicitly from /dev/tty, so they still work as long as
# there's a real terminal attached, which there is for anyone running this
# at an interactive shell.
bash "$INSTALL_DIR/scripts/install.sh"
