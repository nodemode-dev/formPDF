#!/usr/bin/env bash
FORMPDF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export FORMPDF_ROOT
fp_say() { printf '[formpdf] %s\n' "$*"; }
fp_die() { printf '[formpdf] error: %s\n' "$*" >&2; exit 1; }
fp_os() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo macos ;;
    Linux) echo linux ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo unknown ;;
  esac
}
fp_python() {
  local c
  for c in python3.14 python3.13 python3.12 python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
      echo "$c"
      return 0
    fi
  done
  return 1
}
fp_venv() {
  local act="$FORMPDF_ROOT/backend/venv/bin/activate"
  [ -f "$act" ] || act="$FORMPDF_ROOT/backend/venv/Scripts/activate"
  [ -f "$act" ] || fp_die "backend venv missing, run ./formpdf install"
  # shellcheck disable=SC1090
  source "$act"
}
fp_target_triple() {
  if [ -n "${FORMPDF_TARGET:-}" ]; then echo "$FORMPDF_TARGET"; return 0; fi
  command -v rustc >/dev/null 2>&1 || return 1
  rustc -vV | awk '/^host:/ {print $2}'
}
fp_exe() { [ "$(fp_os)" = windows ] && echo ".exe" || echo ""; }
