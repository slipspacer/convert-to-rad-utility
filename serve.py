#!/usr/bin/env python3
"""Local server for the RAD Converter.

Serves web/ like `python -m http.server`, plus a small API that lets the page
hand a conversion to Spark's native `build-lod` tool (no 4 GB browser memory
limit). Everything stays on this computer: the server only listens on
127.0.0.1, and only accepts API calls from its own page.

    python serve.py [--port 8090]

The native tool is downloaded on first use from the release named in
web/native/manifest.json and checked against its SHA-256. Set RAD_BUILD_LOD to
the path of a build-lod executable to use your own build instead.
"""

import argparse
import atexit
import hashlib
import http.server
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
BIN_DIR = ROOT / "native" / "bin"
MANIFEST = WEB / "native" / "manifest.json"
# Each server instance keeps its jobs in its own folder, so a second launcher
# never touches another one's work.
JOBS_BASE = Path(tempfile.gettempdir()) / "rad-converter-native"
JOBS_ROOT = JOBS_BASE / f"server-{os.getpid()}"
STALE_SECONDS = 24 * 3600

INPUT_EXTENSIONS = {"ply", "spz", "splat", "ksplat", "sog", "zip"}
NUM = r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?"
FLAG_PATTERNS = [
    re.compile(p)
    for p in (
        r"--(?:quality|quick|gsplat|csplat|rad|rad-chunked|inflate)",
        r"--(?:bhatt-lod|tiny-lod)=\d+(?:\.\d+)?",
        r"--max-sh=[0-3]",
        rf"--(?:min-box|max-box)={NUM},{NUM},{NUM}",
        rf"--within-dist={NUM},{NUM},{NUM},{NUM}",
    )
]
MAX_FLAGS = 16


def platform_key():
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Windows" and machine in ("amd64", "x86_64"):
        return "windows-x64"
    if system == "Darwin":
        return "macos-universal"
    return None


def load_manifest():
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def binary_path():
    override = os.environ.get("RAD_BUILD_LOD")
    if override:
        return Path(override)
    tag = load_manifest()["tag"]
    return BIN_DIR / (f"{tag}.exe" if platform.system() == "Windows" else tag)


# ---------------------------------------------------------------- install


class Installer:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"  # idle | downloading | error
        self.received = 0
        self.total = 0
        self.error = None

    def status(self):
        return {"state": self.state, "received": self.received, "total": self.total, "error": self.error}

    def start(self):
        with self.lock:
            if self.state == "downloading":
                return
            self.state, self.received, self.total, self.error = "downloading", 0, 0, None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            key = platform_key()
            asset = load_manifest()["assets"].get(key) if key else None
            if not asset:
                raise RuntimeError(f"No native build-lod is published for this platform ({platform.system()} {platform.machine()}).")
            if not asset.get("sha256"):
                raise RuntimeError("The native build-lod release hasn't been published yet.")
            target = binary_path()
            target.parent.mkdir(parents=True, exist_ok=True)
            part = target.with_name(target.name + ".part")
            digest = hashlib.sha256()
            with urllib.request.urlopen(asset["url"], timeout=60) as resp, open(part, "wb") as out:
                self.total = int(resp.headers.get("Content-Length") or 0)
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    digest.update(chunk)
                    self.received += len(chunk)
            if digest.hexdigest().lower() != asset["sha256"].lower():
                part.unlink(missing_ok=True)
                raise RuntimeError("The downloaded build-lod didn't match its expected SHA-256, so it was discarded.")
            if platform.system() != "Windows":
                part.chmod(part.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            os.replace(part, target)
            self.state = "idle"
        except Exception as err:  # reported to the page
            self.state, self.error = "error", str(err)


INSTALLER = Installer()


# ------------------------------------------------------------------- jobs


class Job:
    def __init__(self, name, flags):
        base, ext = split_input_name(name)  # validate before creating anything
        self.id = uuid.uuid4().hex
        self.token = uuid.uuid4().hex
        self.dir = JOBS_ROOT / self.id
        self.dir.mkdir(parents=True)
        self.input = self.dir / f"{base}.{ext}"
        self.flags = flags
        self.state = "waiting"  # waiting | uploading | running | done | error | cancelled
        self.log = []
        self.error = None
        self.proc = None
        self.started = None
        self.finished = None

    def outputs(self):
        if self.state != "done":
            return []
        files = [p for p in self.dir.iterdir() if p.is_file() and p != self.input]
        # The .rad header first, then chunks in numeric order.
        def key(p):
            m = re.search(r"-(\d+)\.radc$", p.name)
            return (p.suffix != ".rad", int(m.group(1)) if m else 0, p.name)
        return sorted(files, key=key)

    def run(self, exe):
        self.state = "running"
        self.started = time.time()
        kwargs = {}
        if platform.system() == "Windows":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        self.proc = subprocess.Popen(
            [str(exe), *self.flags, self.input.name],
            cwd=self.dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            **kwargs,
        )
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for raw in self.proc.stdout:
            self.log.append(raw.decode("utf-8", "replace").rstrip("\r\n"))
        code = self.proc.wait()
        self.finished = time.time()
        if self.state == "cancelled":
            return
        # build-lod exits 0 even when it gives up, so success means "wrote output".
        produced = [p for p in self.dir.iterdir() if p.is_file() and p != self.input and p.suffix in (".rad", ".radc")]
        if produced and code == 0:
            self.state = "done"
            try:
                self.input.unlink()  # free disk space; outputs stay until discarded
            except OSError:
                pass
        else:
            problems = [l for l in self.log if re.search(r"fail|error|invalid|stopping|panick", l, re.I)]
            self.error = problems[-1] if problems else f"build-lod exited with code {code} without writing a .rad file."
            self.state = "error"

    def cancel(self):
        self.state = "cancelled"
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()

    def discard(self):
        self.cancel()
        shutil.rmtree(self.dir, ignore_errors=True)


JOBS = {}
JOBS_LOCK = threading.Lock()


def split_input_name(name):
    name = Path(name).name
    lower = name.lower()
    ext = next((e for e in INPUT_EXTENSIONS if lower.endswith("." + e)), None)
    if ext is None:
        raise ValueError("Unsupported input type for the native engine.")
    base = name[: -(len(ext) + 1)]
    base = re.sub(r"\.compressed$", "", base, flags=re.I)
    base = re.sub(r"-lod$", "", base, flags=re.I)  # build-lod skips *-lod inputs
    base = re.sub(r"[^\w .()-]", "_", base).strip(" .") or "scene"
    return base[:120], ext


def busy():
    return any(j.state in ("uploading", "running") for j in JOBS.values())


def rad_meta(path):
    with open(path, "rb") as f:
        head = f.read(8)
        if len(head) < 8 or head[:4] != b"RAD0":
            return None
        size = int.from_bytes(head[4:8], "little")
        meta = json.loads(f.read(size))
    meta.pop("comment", None)
    meta.pop("chunks", None)
    return meta


def remove_stale_jobs():
    """Delete job folders left behind by servers that didn't exit cleanly."""
    if not JOBS_BASE.is_dir():
        return
    now = time.time()
    for d in JOBS_BASE.iterdir():
        try:
            if d != JOBS_ROOT and now - d.stat().st_mtime > STALE_SECONDS:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


def cleanup_all():
    with JOBS_LOCK:
        for job in list(JOBS.values()):
            job.discard()
        JOBS.clear()
    shutil.rmtree(JOBS_ROOT, ignore_errors=True)


# ---------------------------------------------------------------- handler


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):  # keep the launcher window readable
        pass

    # --- helpers

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def trusted(self, job=None):
        """Only this page may use the API: right Host (blocks DNS rebinding),
        same Origin if sent, and our custom header (or the job's token)."""
        port = self.server.server_address[1]
        allowed = {f"localhost:{port}", f"127.0.0.1:{port}"}
        if self.headers.get("Host") not in allowed:
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{h}" for h in allowed}:
            return False
        if self.headers.get("X-RAD-Converter") == "1":
            return True
        token = parse_qs(urlparse(self.path).query).get("t", [None])[0]
        return job is not None and token == job.token

    def route(self):
        # Split first, then decode each segment, so names with spaces or other
        # escaped characters ("Artist%20Journey-lod.rad") match the files on disk.
        parts = [unquote(p) for p in urlparse(self.path).path.strip("/").split("/")]
        if parts[:2] != ["api", "native"]:
            return None
        return parts[2:]

    def job_for(self, rest):
        with JOBS_LOCK:
            return JOBS.get(rest[1]) if len(rest) >= 2 else None

    # --- verbs

    def do_GET(self):
        rest = self.route()
        if rest is None:
            return super().do_GET()
        job = self.job_for(rest) if rest[:1] == ["jobs"] else None
        if not self.trusted(job):
            return self.send_json(403, {"error": "forbidden"})

        if rest == ["status"]:
            exe = binary_path()
            return self.send_json(200, {
                "platform": platform_key(),
                "installed": exe.is_file(),
                "custom": bool(os.environ.get("RAD_BUILD_LOD")),
                "install": INSTALLER.status(),
                "busy": busy(),
            })
        if rest[:1] == ["jobs"] and job:
            if len(rest) == 2:
                since = int(parse_qs(urlparse(self.path).query).get("since", ["0"])[0])
                files = [
                    {"name": p.name, "size": p.stat().st_size,
                     "url": f"/api/native/jobs/{job.id}/files/{quote(p.name)}?t={job.token}"}
                    for p in job.outputs()
                ]
                meta = rad_meta(job.dir / files[0]["name"]) if files else None
                return self.send_json(200, {
                    "state": job.state, "log": job.log[since:], "next": len(job.log),
                    "error": job.error, "files": files, "meta": meta,
                    "seconds": (job.finished or time.time()) - job.started if job.started else 0,
                })
            if len(rest) == 4 and rest[2] == "files":
                wanted = {p.name: p for p in job.outputs()}
                path = wanted.get(rest[3])
                if not path:
                    return self.send_json(404, {"error": "no such file"})
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(path.stat().st_size))
                self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(path.name)}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(path, "rb") as f:
                    shutil.copyfileobj(f, self.wfile, 1 << 20)
                return
        return self.send_json(404, {"error": "not found"})

    def do_POST(self):
        rest = self.route()
        if rest is None or not self.trusted():
            return self.send_json(403 if rest is not None else 405, {"error": "forbidden"})
        if rest == ["install"]:
            INSTALLER.start()
            return self.send_json(202, INSTALLER.status())
        if rest == ["jobs"]:
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                flags = body.get("flags", [])
                if not isinstance(flags, list) or len(flags) > MAX_FLAGS or not all(
                    isinstance(f, str) and any(p.fullmatch(f) for p in FLAG_PATTERNS) for f in flags
                ):
                    raise ValueError("Unsupported build-lod option.")
                if not binary_path().is_file():
                    raise ValueError("The native engine isn't installed yet.")
                with JOBS_LOCK:
                    if busy():
                        return self.send_json(409, {"error": "The native engine is already converting another file."})
                    job = Job(str(body.get("name", "")), flags)
                    JOBS[job.id] = job
            except ValueError as err:
                return self.send_json(400, {"error": str(err)})
            return self.send_json(201, {"id": job.id, "token": job.token})
        return self.send_json(404, {"error": "not found"})

    def do_PUT(self):
        rest = self.route()
        job = self.job_for(rest) if rest and rest[:1] == ["jobs"] else None
        if rest is None or not self.trusted():
            return self.send_json(403, {"error": "forbidden"})
        if not (job and len(rest) == 3 and rest[2] == "input" and job.state == "waiting"):
            return self.send_json(404, {"error": "not found"})
        remaining = int(self.headers.get("Content-Length") or 0)
        job.state = "uploading"
        try:
            with open(job.input, "wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        raise ConnectionError("upload interrupted")
                    out.write(chunk)
                    remaining -= len(chunk)
        except (OSError, ConnectionError) as err:
            job.state, job.error = "error", f"Upload failed: {err}"
            return self.send_json(400, {"error": job.error})
        if job.state == "cancelled":
            return self.send_json(409, {"error": "cancelled"})
        job.run(binary_path())
        return self.send_json(202, {"state": job.state})

    def do_DELETE(self):
        rest = self.route()
        if rest is None or not self.trusted():
            return self.send_json(403, {"error": "forbidden"})
        if rest[:1] == ["jobs"] and len(rest) == 2:
            with JOBS_LOCK:
                job = JOBS.pop(rest[1], None)
            if job:
                job.discard()
            return self.send_json(200, {"ok": True})
        return self.send_json(404, {"error": "not found"})


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()

    remove_stale_jobs()
    atexit.register(cleanup_all)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"Serving RAD Converter at http://localhost:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
