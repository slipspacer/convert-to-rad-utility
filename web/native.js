// Hand-off to Spark's native build-lod tool, which has no browser memory limit.
//
// "server" mode: the page was opened through the Start RAD Converter launcher,
// whose serve.py runs build-lod locally (downloading it on first use). The
// page uploads the file to it and gets the .rad back; nothing leaves the PC.
//
// "manual" mode: any other way of opening the page. We generate a one-click
// script (.bat / .command) preset with the same settings, plus the command.
import { lodProgress } from "./progress.js";

const API = "api/native";
const HEADERS = { "X-RAD-Converter": "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const native = { mode: "unknown", status: null, manifest: null };

export async function probeNative() {
  try {
    const res = await fetch(`${API}/status`, { headers: HEADERS, cache: "no-store" });
    if (res.ok) {
      native.status = await res.json();
      native.mode = native.status.platform ? "server" : "unsupported";
    } else {
      native.mode = "manual";
    }
  } catch {
    native.mode = "manual";
  }
  try {
    native.manifest = await (await fetch("native/manifest.json", { cache: "no-store" })).json();
  } catch {}
  return native;
}

// ---------- settings -> build-lod flags (the one mapping used everywhere)

export function buildLodFlags(settings) {
  const p = settings.process;
  const flags = [];
  if (p.lodBase != null) flags.push(`--${p.lod === "quick" ? "tiny-lod" : "bhatt-lod"}=${p.lodBase}`);
  else flags.push(p.lod === "quick" ? "--quick" : "--quality");
  if (settings.compact) flags.push("--csplat");
  if (p.maxSh != null) flags.push(`--max-sh=${p.maxSh}`);
  if (p.minBox) flags.push(`--min-box=${p.minBox.join(",")}`);
  if (p.maxBox) flags.push(`--max-box=${p.maxBox.join(",")}`);
  if (p.withinDist) flags.push(`--within-dist=${p.withinDist.join(",")}`);
  if (p.inflate) flags.push("--inflate");
  flags.push(settings.chunked ? "--rad-chunked" : "--rad");
  return flags;
}

/** Reason the native tool can't do this job, or null. */
export function nativeBlocker(settings, fileName) {
  if (settings.process.lod === "none") {
    return "The native tool always builds an LoD tree. Choose Quality or Quick, or use the browser engine for output without LoD.";
  }
  if (/\.rad$/i.test(fileName)) {
    return "RAD files are converted in the browser. The native tool can't rebuild an existing LoD tree.";
  }
  if (!/\.(ply|spz|splat|ksplat|sog|zip)$/i.test(fileName)) {
    return "The native tool reads .ply, .spz, .splat, .ksplat, .sog and .zip files.";
  }
  return null;
}

/** Settings the native tool doesn't support (they're ignored). */
export function nativeIgnored(settings) {
  const notes = [];
  if (Object.values(settings.encode).some((v) => v && v !== "Auto")) notes.push("custom property encodings (it always uses Auto)");
  if (settings.fileType) notes.push("the forced input format (it detects the format itself)");
  return notes;
}

// ---------- server mode

async function call(method, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: body ? { ...HEADERS, "Content-Type": "application/json" } : HEADERS,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Native engine error (${res.status})`);
  return data;
}

export function discardNativeJob(id) {
  if (id) fetch(`${API}/jobs/${id}`, { method: "DELETE", headers: HEADERS }).catch(() => {});
}

/**
 * Run one conversion through serve.py. hooks: stage(name, progress|null),
 * log(line), input({fileType, splatCount, shDegree}).
 * Resolves with { files: [{name, size, url}], meta, seconds } or null if cancelled.
 */
export function runNativeJob(file, settings, hooks) {
  let cancelled = false;
  let xhr = null;
  let jobId = null;

  const promise = (async () => {
    const flags = buildLodFlags(settings);
    let status = await call("GET", "status");
    if (!status.installed) {
      hooks.stage("install", null);
      hooks.log("Downloading Spark's native build-lod tool (first use only)…");
      await call("POST", "install");
      for (;;) {
        await sleep(500);
        if (cancelled) return null;
        status = await call("GET", "status");
        if (status.installed) break;
        const inst = status.install;
        if (inst.state === "error") throw new Error(inst.error);
        if (inst.total) hooks.stage("install", inst.received / inst.total);
      }
      hooks.log("Native build-lod installed.");
    }

    const job = await call("POST", "jobs", { name: file.name, flags });
    jobId = job.id;
    hooks.stage("upload", 0);
    await new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open("PUT", `${API}/jobs/${job.id}/input`);
      xhr.setRequestHeader("X-RAD-Converter", "1");
      xhr.upload.onprogress = (e) => e.lengthComputable && hooks.stage("upload", e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status < 300) return resolve();
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error("Couldn't send the file to the native engine. Is the launcher window still open?"));
      xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
      xhr.send(file);
    });

    hooks.stage("decode", null);
    let since = 0;
    const input = {};
    for (;;) {
      await sleep(400);
      if (cancelled) return null;
      const st = await call("GET", `jobs/${job.id}?since=${since}`);
      since = st.next;
      for (const line of st.log) {
        hooks.log(line);
        let m;
        if ((m = /^Detected file type: (\w+)/.exec(line))) input.fileType = m[1].toLowerCase();
        if ((m = /^Read: num_splats: (\d+) with sh_degree: (\d+)/.exec(line))) {
          input.splatCount = Number(m[1]);
          input.shDegree = Number(m[2]);
          hooks.input({ fileType: input.fileType ?? "input", ...input, hasLod: false });
          hooks.stage("lod", 0);
        }
        const p = lodProgress(line);
        if (p != null) hooks.stage("lod", p);
        if (line.startsWith("Encoding RAD file")) hooks.stage("encode", null);
      }
      if (st.state === "done") return { id: job.id, files: st.files, meta: st.meta, seconds: st.seconds };
      if (st.state === "error") throw new Error(st.error);
      if (st.state === "cancelled") return null;
    }
  })();

  return {
    promise,
    get id() { return jobId; },
    cancel() {
      cancelled = true;
      xhr?.abort();
      discardNativeJob(jobId);
    },
  };
}

// ---------- manual mode: one-click scripts and commands

export function detectOS() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "windows";
  return "other";
}

function asset(os) {
  const key = os === "windows" ? "windows-x64" : "macos-universal";
  const a = native.manifest?.assets?.[key];
  return a && { ...a, tag: native.manifest.tag };
}

export function binariesPublished() {
  return Boolean(asset("windows")?.sha256 && asset("mac")?.sha256);
}

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

/** Terminal commands for people who'd rather paste than double-click. */
export function terminalCommands(os, settings, fileName) {
  const flags = buildLodFlags(settings).join(" ");
  const a = asset(os);
  if (os === "windows") {
    return {
      shell: "PowerShell",
      install: `curl.exe -L -o build-lod.exe ${a?.url ?? "<build-lod-windows-x64.exe URL>"}`,
      run: `.\\build-lod.exe ${flags} ${psQuote(fileName)}`,
    };
  }
  return {
    shell: "Terminal",
    install: `curl -L -o build-lod ${a?.url ?? "<build-lod-macos-universal URL>"} && chmod +x build-lod`,
    run: `./build-lod ${flags} ${shQuote(fileName)}`,
  };
}

/** The output build-lod writes next to the input: last extension -> "-lod.rad". */
export function nativeOutputName(fileName) {
  const dot = fileName.lastIndexOf(".");
  return `${dot > 0 ? fileName.slice(0, dot) : fileName}-lod.rad`;
}

const WINDOWS_TEMPLATE = String.raw`@echo off
rem Converts a Gaussian splat file to Spark's RAD format with the native
rem build-lod tool (no browser memory limit). Generated by RAD Converter.
setlocal
title Convert to RAD
cd /d "%~dp0"
set "INPUT=__INPUT__"
set "TAG=__TAG__"
set "URL=__URL__"
set "SHA=__SHA__"
set "TOOLDIR=%LOCALAPPDATA%\RAD Converter"
set "TOOL=%LOCALAPPDATA%\RAD Converter\%TAG%.exe"

if not defined INPUT goto :choose
if exist "%INPUT%" goto :have_input
:choose
echo Choose the splat file to convert...
set "INPUT="
for /f "usebackq delims=" %%F in (` + "`" + String.raw`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Choose the splat file to convert'; $d.Filter = 'Gaussian splats|*.ply;*.spz;*.splat;*.ksplat;*.sog;*.zip|All files|*.*'; if ($d.ShowDialog() -eq 'OK') { $d.FileName }"` + "`" + String.raw`) do set "INPUT=%%F"
if not defined INPUT goto :no_input
if not exist "%INPUT%" goto :no_input
:have_input

if exist "%TOOL%" goto :have_tool
echo Downloading Spark's build-lod converter. This only happens the first time.
if not exist "%TOOLDIR%" mkdir "%TOOLDIR%"
curl.exe -fL --progress-bar -o "%TOOL%.part" "%URL%"
if errorlevel 1 goto :download_failed
powershell -NoProfile -Command "if ((Get-FileHash -Algorithm SHA256 -LiteralPath ($env:TOOL + '.part')).Hash -ne $env:SHA) { exit 1 }"
if errorlevel 1 goto :bad_download
move /y "%TOOL%.part" "%TOOL%" >nul
:have_tool

echo.
echo Converting "%INPUT%"
echo.
"%TOOL%" __FLAGS__ "%INPUT%"
for %%F in ("%INPUT%") do set "OUT=%%~dpnF-lod.rad"
if not exist "%OUT%" goto :failed
echo.
echo Done: "%OUT%"
explorer /select,"%OUT%"
goto :end

:no_input
echo No file was chosen.
goto :end
:download_failed
echo Couldn't download the converter. Check your internet connection and try again.
goto :end
:bad_download
del "%TOOL%.part" 2>nul
echo The downloaded converter didn't match its expected checksum, so it was deleted.
goto :end
:failed
echo.
echo The conversion didn't produce a .rad file. See the messages above.
:end
echo.
pause
`;

const MAC_TEMPLATE = `#!/bin/bash
# Converts a Gaussian splat file to Spark's RAD format with the native
# build-lod tool (no browser memory limit). Generated by RAD Converter.
cd "$(dirname "$0")" || exit 1
INPUT=__INPUT__
TAG=__TAG__
URL=__URL__
SHA=__SHA__
FLAGS=(__FLAGS__)
TOOLDIR="$HOME/Library/Application Support/RAD Converter"
TOOL="$TOOLDIR/$TAG"

finish() {
  echo
  read -n 1 -s -r -p "Press any key to close this window."
  echo
  exit "\${1:-0}"
}

if [ -z "$INPUT" ] || [ ! -f "$INPUT" ]; then
  echo "Choose the splat file to convert..."
  INPUT=$(osascript -e 'POSIX path of (choose file with prompt "Choose the splat file to convert")' 2>/dev/null)
fi
if [ -z "$INPUT" ] || [ ! -f "$INPUT" ]; then
  echo "No file was chosen."
  finish 1
fi

if [ ! -x "$TOOL" ]; then
  echo "Downloading Spark's build-lod converter. This only happens the first time."
  mkdir -p "$TOOLDIR"
  if ! curl -fL --progress-bar -o "$TOOL.part" "$URL"; then
    echo "Couldn't download the converter. Check your internet connection and try again."
    finish 1
  fi
  if [ "$(shasum -a 256 "$TOOL.part" | cut -d ' ' -f 1)" != "$SHA" ]; then
    rm -f "$TOOL.part"
    echo "The downloaded converter didn't match its expected checksum, so it was deleted."
    finish 1
  fi
  chmod +x "$TOOL.part" && mv "$TOOL.part" "$TOOL"
fi

echo
echo "Converting $INPUT"
echo
"$TOOL" "\${FLAGS[@]}" "$INPUT"
OUT="\${INPUT%.*}-lod.rad"
if [ -f "$OUT" ]; then
  echo
  echo "Done: $OUT"
  open -R "$OUT"
  finish 0
fi
echo
echo "The conversion didn't produce a .rad file. See the messages above."
finish 1
`;

const fill = (template, values) => template.replace(/__([A-Z]+)__/g, (_, k) => values[k]);

/** { name, blob } for a double-clickable converter preset with these settings. */
export async function oneClickScript(os, settings, fileName) {
  const a = asset(os);
  const flags = buildLodFlags(settings);
  const stem = fileName.replace(/\.[^.]+$/, "");
  if (os === "windows") {
    // Batch can't safely carry these characters; the script asks for the file instead.
    const input = /^[^%!^&|<>"]+$/.test(fileName) ? fileName : "";
    const text = fill(WINDOWS_TEMPLATE, { INPUT: input, TAG: a.tag, URL: a.url, SHA: a.sha256.toUpperCase(), FLAGS: flags.join(" ") });
    return { name: `Convert ${stem} to RAD.bat`, blob: new Blob([text.replace(/\r?\n/g, "\r\n")], { type: "application/octet-stream" }) };
  }
  const text = fill(MAC_TEMPLATE, {
    INPUT: shQuote(fileName), TAG: shQuote(a.tag), URL: shQuote(a.url), SHA: shQuote(a.sha256.toLowerCase()),
    FLAGS: flags.map(shQuote).join(" "),
  });
  // Browser downloads drop the execute bit, so ship it inside a zip that keeps it.
  const { zipSync, strToU8 } = await import("fflate");
  const scriptName = `Convert ${stem} to RAD.command`;
  const zip = zipSync({ [scriptName]: [strToU8(text), { os: 3, attrs: (0o100755 << 16) >>> 0 }] });
  return { name: `Convert ${stem} to RAD.zip`, blob: new Blob([zip], { type: "application/zip" }), scriptName };
}
