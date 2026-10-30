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
fp_native_path() {
  if [ "$(fp_os)" = windows ]; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}
fp_rust_env() {
  [ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
  export PATH
  unset RUSTC RUSTC_WORKSPACE_WRAPPER RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET CARGO_TARGET_DIR CARGO_BUILD_TARGET_DIR CARGO_BUILD_RUSTC
  export RUSTC_WRAPPER="" CARGO_BUILD_RUSTC_WRAPPER=""
  if command -v rustup >/dev/null 2>&1 && rustup toolchain list 2>/dev/null | grep -q '^stable'; then
    export RUSTUP_TOOLCHAIN="${FORMPDF_RUST_TOOLCHAIN:-stable}"
  fi
}
fp_rust_fresh() {
  local target="$FORMPDF_ROOT/src-tauri/target" now
  now="$(rustc -vV 2>/dev/null | tr '\n' ' ')"
  if [ -d "$target/release" ] && [ "$(cat "$target/.formpdf-rustc" 2>/dev/null)" != "$now" ]; then
    fp_say "the Rust compiler differs from the one that built src-tauri/target; cleaning it"
    ( cd "$FORMPDF_ROOT/src-tauri" && cargo clean )
  fi
  mkdir -p "$target"
  printf '%s' "$now" > "$target/.formpdf-rustc"
}
