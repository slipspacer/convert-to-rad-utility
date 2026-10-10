# Builds rad-wasm (Rust -> WebAssembly) into web/pkg.
# Requires rustup (https://rustup.rs). Installs the wasm32 target and
# wasm-bindgen-cli automatically if missing. Set $env:WASM_BINDGEN to use a
# specific wasm-bindgen binary.
$ErrorActionPreference = "Stop"
$WasmBindgenVersion = "0.2.117"
$Root = $PSScriptRoot

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
    if (Test-Path (Join-Path $cargoBin "cargo.exe")) { $env:PATH = "$cargoBin;$env:PATH" }
    else { throw "cargo not found. Install Rust from https://rustup.rs" }
}

rustup target add wasm32-unknown-unknown
if ($LASTEXITCODE -ne 0) { throw "rustup target add failed" }

$wb = $env:WASM_BINDGEN
if (-not $wb) {
    $found = Get-Command wasm-bindgen -ErrorAction SilentlyContinue
    if ($found -and ((& $found.Source --version) -match [regex]::Escape($WasmBindgenVersion))) {
        $wb = $found.Source
    } else {
        cargo install wasm-bindgen-cli --version $WasmBindgenVersion --locked
        if ($LASTEXITCODE -ne 0) { throw "cargo install wasm-bindgen-cli failed" }
        $wb = "wasm-bindgen"
    }
}

$env:RUSTFLAGS = "-C target-feature=+simd128,+bulk-memory"
cargo build --release --target wasm32-unknown-unknown --manifest-path "$Root\rad-wasm\Cargo.toml"
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

& $wb --target web --no-typescript --out-dir "$Root\web\pkg" "$Root\rad-wasm\target\wasm32-unknown-unknown\release\rad_wasm.wasm"
if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen failed" }

Write-Host "Built web/pkg. Serve with: py serve.py"
