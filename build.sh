#!/usr/bin/env bash
# Builds rad-wasm (Rust -> WebAssembly) into web/pkg.
# Requires rustup (https://rustup.rs). Installs the wasm32 target and
# wasm-bindgen-cli automatically if missing. Set WASM_BINDGEN to use a
# specific wasm-bindgen binary.
set -euo pipefail
WASM_BINDGEN_VERSION="0.2.117"
ROOT="$(cd "$(dirname "$0")" && pwd)"

rustup target add wasm32-unknown-unknown

WB="${WASM_BINDGEN:-}"
if [ -z "$WB" ]; then
  if command -v wasm-bindgen >/dev/null && wasm-bindgen --version | grep -q "$WASM_BINDGEN_VERSION"; then
    WB=wasm-bindgen
  else
    cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked
    WB=wasm-bindgen
  fi
fi

RUSTFLAGS="-C target-feature=+simd128,+bulk-memory" \
  cargo build --release --target wasm32-unknown-unknown --manifest-path "$ROOT/rad-wasm/Cargo.toml"

"$WB" --target web --no-typescript --out-dir "$ROOT/web/pkg" \
  "$ROOT/rad-wasm/target/wasm32-unknown-unknown/release/rad_wasm.wasm"

echo "Built web/pkg. Serve with: python3 -m http.server 8090 -d web"
