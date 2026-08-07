// Live site preview — renders the *real* hakumaguro.dev in a `next dev` server
// so a queued image change can be judged as it will actually look, before
// anything is written to the real repo.
//
// The rule that shapes everything here: **the target repo is never touched by a
// preview.** Instead we keep a shadow — a copy of the target repo's working
// tree in this app's userData dir — and run `queue.apply(shadowDir)` against it.
// That reuse is the whole trick: apply() takes a repoPath, so the preview needs
// no write logic of its own and cannot drift from what Apply will really do.
//
// Why the shadow lives in userData and not next to the repo: the target repo
// sits inside OneDrive on the author's machine, and a shadow's `.next` grows to
// ~130 MB of pure build cache. Parking that beside the repo would hand OneDrive
// a permanent sync job.
//
// Two things about the shadow are NOT copies of the real repo, and both are
// forced by measurement rather than taste (see the spike notes in CLAUDE.md):
//
//   1. `node_modules` is a Windows junction back to the real repo's (472 MB /
//      21k files — copying it per preview is not viable). Turbopack rejects a
//      junction that leaves its filesystem root ("Symlink [project]/node_modules
//      is invalid, it points out of the filesystem root"), so the shadow's Next
//      config widens `turbopack.root` to the nearest common ancestor of the
//      shadow and the real repo. When there is no common ancestor — different
//      drives — no root can contain both and we fall back to `next dev
//      --webpack`, which resolves junctions fine.
//   2. A small script is injected so the app can scroll the page to a changed
//      image and outline it. The iframe is cross-origin (file:// parent,
//      http://localhost child) so nothing can reach into it except postMessage.
//      If the injection point can't be found the preview still works, minus the
//      jump-to-change buttons.
//
// Neither patch exists in the real repo, and a resync rewrites both from the
// real source every time, so they cannot rot into something the user's own
// edits fight with.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

// Top-level entries never mirrored into the shadow. `node_modules` is the
// junction; `.next` is the shadow's own build cache (keeping it warm across
// runs is what makes a second preview instant); `.git`/`out` are dead weight.
const SKIP_TOP = new Set(["node_modules", ".next", ".git", "out"]);

const INJECTED_SCRIPT = "__catalog-preview.js";

// Records which real files the shadow's patched copies were derived from, so a
// resync can leave them alone when nothing upstream changed.
const MANIFEST = ".catalog-preview.json";

/** Where the shadow for a given target repo lives. Keyed by path so switching
 *  repos in Settings gets a fresh one instead of a confusing half-stale mix. */
function shadowDirFor(userDataDir, repoPath) {
  const key = crypto
    .createHash("sha1")
    .update(path.resolve(repoPath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return path.join(userDataDir, "preview-shadow", key);
}

/** Deepest directory containing both paths, or null when they share no root
 *  (different drive letters on Windows). */
function commonAncestor(a, b) {
  const pa = path.resolve(a).split(path.sep);
  const pb = path.resolve(b).split(path.sep);
  if (pa[0].toLowerCase() !== pb[0].toLowerCase()) return null;
  const out = [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i].toLowerCase() !== pb[i].toLowerCase()) break;
    out.push(pa[i]);
  }
  return out.length ? out.join(path.sep) + path.sep : null;
}

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.size === sb.size && Math.abs(sa.mtimeMs - sb.mtimeMs) < 1;
  } catch (_) {
    return false;
  }
}

/**
 * Mirrors `src` onto `dest`: copies what differs, deletes what no longer
 * exists. Deleting matters — a preview that kept showing a file the user
 * removed from the real repo would be lying, which is the one failure mode this
 * whole feature exists to prevent.
 *
 * `managed` holds repo-relative paths this function must not touch in either
 * direction: the shadow's patched copies (see reconcileManaged). Rewriting
 * those on every sync would be worse than wasteful — `next dev` restarts itself
 * when its config file changes, so a resync under a running server killed it.
 */
function mirror(src, dest, managed, rel = "") {
  fs.mkdirSync(dest, { recursive: true });

  const srcEntries = fs.readdirSync(src, { withFileTypes: true });
  const wanted = new Set();

  for (const e of srcEntries) {
    if (rel === "" && SKIP_TOP.has(e.name)) continue;
    wanted.add(e.name);
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (managed.has(childRel)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      mirror(s, d, managed, childRel);
    } else if (e.isFile()) {
      if (!sameFile(s, d)) {
        fs.copyFileSync(s, d);
        // Carry mtime across so the next sync can skip this file.
        const st = fs.statSync(s);
        fs.utimesSync(d, st.atime, st.mtime);
      }
    }
  }

  if (!fs.existsSync(dest)) return;
  for (const e of fs.readdirSync(dest, { withFileTypes: true })) {
    if (wanted.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (managed.has(childRel)) continue;
    if (rel === "" && SKIP_TOP.has(e.name)) continue;
    fs.rmSync(path.join(dest, e.name), { recursive: true, force: true });
  }
}

function hashFile(p) {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
  } catch (_) {
    return null;
  }
}

function ensureJunction(shadowDir, repoPath) {
  const link = path.join(shadowDir, "node_modules");
  const target = path.join(repoPath, "node_modules");
  let ok = false;
  try {
    ok = fs.readlinkSync(link).replace(/\\\\\?\\/, "").toLowerCase() === target.toLowerCase();
  } catch (_) {
    ok = false;
  }
  if (ok) return true;
  try {
    fs.rmSync(link, { recursive: true, force: true });
  } catch (_) {
    /* nothing there */
  }
  // "junction" is the one link type Windows grants without elevation.
  fs.symlinkSync(target, link, "junction");
  return true;
}

function configNameIn(dir) {
  return fs.readdirSync(dir).find((f) => /^next\.config\.(ts|mts|cts|js|mjs|cjs)$/.test(f)) || null;
}

/**
 * Gives the shadow a Next config that re-exports the real one plus a widened
 * `turbopack.root`. Wrapping instead of string-patching means the target repo
 * can restructure its config however it likes without breaking preview.
 * Returns the root, or null when no root can contain both (different drives) —
 * the caller then falls back to webpack.
 */
function writeConfigWrapper(shadowDir, repoPath, configName) {
  const root = commonAncestor(shadowDir, repoPath);
  if (!configName || !root) return null;

  const ext = path.extname(configName);
  const isTs = /^\.(ts|mts|cts)$/.test(ext);
  const carried = `next.config.original${ext}`;

  fs.copyFileSync(path.join(repoPath, configName), path.join(shadowDir, carried));
  fs.writeFileSync(
    path.join(shadowDir, configName),
    `// Generated by hakumaguro-catalog's preview. Not part of the real repo.\n` +
      `import base from "./next.config.original${ext === ".ts" ? "" : ext}";\n\n` +
      `const config${isTs ? ": any" : ""} = {\n` +
      `  ...(base${isTs ? " as any" : ""}),\n` +
      `  turbopack: {\n` +
      `    ...((base${isTs ? " as any" : ""}).turbopack || {}),\n` +
      `    root: ${JSON.stringify(root)},\n` +
      `  },\n` +
      `};\n\n` +
      `export default config;\n`,
    "utf8"
  );
  return root;
}

const PREVIEW_SCRIPT = `// Injected by hakumaguro-catalog preview. Not part of the real site.
(function () {
  var HL = "__catalog-hl";
  var style = document.createElement("style");
  style.textContent =
    "." + HL + "{outline:3px solid #ff2d78;outline-offset:4px;border-radius:6px;" +
    "box-shadow:0 0 0 9999px rgba(0,0,0,.28);transition:outline-color .15s}";
  document.documentElement.appendChild(style);

  function clear() {
    var hit = document.querySelectorAll("." + HL);
    for (var i = 0; i < hit.length; i++) hit[i].classList.remove(HL);
  }

  function findByFile(file) {
    var imgs = document.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute("src") || "";
      var name = src.split("?")[0].split("/").pop();
      if (name === file) return imgs[i];
    }
    return null;
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (d.type === "catalog:clear") { clear(); return; }
    if (d.type !== "catalog:focus") return;
    clear();
    var el = d.file ? findByFile(d.file) : null;
    if (!el) {
      if (d.top) window.scrollTo({ top: 0, behavior: "smooth" });
      parent.postMessage({ type: "catalog:focus-result", file: d.file, found: false }, "*");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (d.highlight !== false) el.classList.add(HL);
    parent.postMessage({ type: "catalog:focus-result", file: d.file, found: true }, "*");
  });

  parent.postMessage({ type: "catalog:ready" }, "*");
})();
`;

const LAYOUT_REL = "src/app/layout.tsx";

/** Copies the real layout into the shadow with the script tag spliced in.
 *  Returns false if there's no recognisable <body> to patch — the caller then
 *  degrades to a preview without jump-to-change rather than failing. */
function writeLayoutWithScript(shadowDir, repoPath) {
  const from = path.join(repoPath, ...LAYOUT_REL.split("/"));
  const to = path.join(shadowDir, ...LAYOUT_REL.split("/"));
  if (!fs.existsSync(from)) return false;

  const src = fs.readFileSync(from, "utf8");
  const m = src.match(/<body[^>]*>/);
  if (!m) {
    fs.copyFileSync(from, to);
    return false;
  }
  const at = m.index + m[0].length;
  fs.writeFileSync(to, src.slice(0, at) + `<script src="/${INJECTED_SCRIPT}" async />` + src.slice(at), "utf8");
  return true;
}

/**
 * Rewrites the shadow-only patched files, but only when their real counterpart
 * has actually changed since last time — tracked by hash in a manifest inside
 * the shadow. Rewriting them unconditionally is what killed a running server:
 * `next dev` restarts itself when its config file changes, and re-touching the
 * layout forces a needless recompile on every single preview.
 */
function reconcileManaged(shadowDir, repoPath, configName) {
  const manifestPath = path.join(shadowDir, MANIFEST);
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (_) {
    manifest = {};
  }

  let turbopackRoot = manifest.turbopackRoot || null;
  const configHash = configName ? hashFile(path.join(repoPath, configName)) : null;
  const wrapperPresent = configName && fs.existsSync(path.join(shadowDir, configName));
  if (configName && (manifest.config !== configHash || !wrapperPresent)) {
    turbopackRoot = writeConfigWrapper(shadowDir, repoPath, configName);
    manifest.config = configHash;
    manifest.turbopackRoot = turbopackRoot;
  }

  const layoutHash = hashFile(path.join(repoPath, ...LAYOUT_REL.split("/")));
  const layoutPresent = fs.existsSync(path.join(shadowDir, ...LAYOUT_REL.split("/")));
  let canFocus = manifest.canFocus !== false;
  if (manifest.layout !== layoutHash || !layoutPresent) {
    canFocus = writeLayoutWithScript(shadowDir, repoPath);
    manifest.layout = layoutHash;
    manifest.canFocus = canFocus;
  }

  const scriptPath = path.join(shadowDir, "public", INJECTED_SCRIPT);
  if (fs.readFileSync(scriptPath, "utf8").length !== PREVIEW_SCRIPT.length) {
    fs.writeFileSync(scriptPath, PREVIEW_SCRIPT, "utf8");
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { turbopackRoot, canFocus };
}

/**
 * Brings the shadow level with the real repo and reconciles the shadow-only
 * patches. Cheap by design (the target repo's src/ + public/ is under 2 MB), so
 * it runs on every preview rather than being watched for — "press preview, get
 * what is on disk right now" is a promise that fits in one sentence.
 */
function syncShadow(userDataDir, repoPath) {
  const shadowDir = shadowDirFor(userDataDir, repoPath);
  fs.mkdirSync(shadowDir, { recursive: true });
  fs.mkdirSync(path.join(shadowDir, "public"), { recursive: true });

  const configName = configNameIn(repoPath);
  const managed = new Set([`public/${INJECTED_SCRIPT}`, MANIFEST, LAYOUT_REL]);
  if (configName) {
    managed.add(configName);
    managed.add(`next.config.original${path.extname(configName)}`);
  }

  // Seed the injected script before mirroring so its own managed entry is real.
  const scriptPath = path.join(shadowDir, "public", INJECTED_SCRIPT);
  if (!fs.existsSync(scriptPath)) fs.writeFileSync(scriptPath, PREVIEW_SCRIPT, "utf8");

  mirror(repoPath, shadowDir, managed);
  ensureJunction(shadowDir, repoPath);
  const { turbopackRoot, canFocus } = reconcileManaged(shadowDir, repoPath, configName);

  return { shadowDir, turbopackRoot, useWebpack: turbopackRoot === null, canFocus };
}

// ---- dev server ----

let server = null; // { child, url, shadowDir, log[], status, error }

function pushLog(line) {
  if (!server) return;
  server.log.push(line);
  if (server.log.length > 400) server.log.splice(0, server.log.length - 400);
}

function serverState() {
  if (!server) return { status: "stopped", url: null, log: [] };
  return { status: server.status, url: server.url, error: server.error || null, log: server.log.slice(-400) };
}

/**
 * Boots `next dev` inside the shadow on a free port (`--port 0`), resolving
 * once Next prints its URL. Started lazily on first preview and left running
 * for the rest of the session: the 2-6 s first compile is paid once, and every
 * later preview is a file write the running server picks up in ~500 ms.
 */
function startServer(shadowDir, repoPath, { useWebpack = false, timeoutMs = 90000 } = {}) {
  if (server && server.shadowDir === shadowDir && server.status === "running") {
    return Promise.resolve(serverState());
  }
  stopServer();

  const bin = path.join(repoPath, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  if (!fs.existsSync(bin)) {
    return Promise.reject(
      new Error(
        `The target repo has no installed dependencies (${path.join("node_modules", ".bin")} is missing) — run \`npm install\` in hakumaguro.dev, then try the preview again.`
      )
    );
  }

  const args = ["dev", "--port", "0"];
  if (useWebpack) args.push("--webpack");

  // shell:true is required on Windows to spawn a .cmd at all — same constraint
  // (and same DEP0190 warning) as verifyTypecheck in writer.js.
  const child = spawn(bin, args, {
    cwd: shadowDir,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none" },
  });

  server = { child, url: null, shadowDir, log: [], status: "starting", error: null };

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const onData = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) if (line.trim()) pushLog(line);
      if (!server) return;
      const m = text.match(/https?:\/\/localhost:(\d+)/);
      if (m && !server.url) {
        server.url = m[0];
        server.status = "running";
        done(resolve, serverState());
      }
      // Turbopack panics *after* printing its URL, so a fatal has to be able to
      // fail a preview that already looked like it started.
      if (/FATAL|TurbopackInternalError/.test(text)) {
        server.status = "failed";
        server.error = "Next.js failed to compile the preview — open the log for details.";
        done(reject, new Error(server.error));
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      if (server) {
        server.status = "failed";
        server.error = err.message;
      }
      done(reject, err);
    });
    child.on("exit", (code) => {
      if (server && server.status !== "running") {
        server.status = "failed";
        server.error = server.error || `next dev exited with code ${code}`;
        done(reject, new Error(server.error));
      } else if (server) {
        server.status = "stopped";
      }
    });

    const timer = setTimeout(() => {
      done(reject, new Error("next dev did not start within 90 s — open the log for details."));
    }, timeoutMs);
  });
}

function stopServer() {
  if (!server) return;
  const { child } = server;
  server = null;
  try {
    if (process.platform === "win32") {
      // next dev spawns a child of its own through the .cmd shim; killing only
      // the shim leaves the real server holding the port.
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch (_) {
    /* already gone */
  }
}

/**
 * Deletes the shadow. Safe against the junction: fs.rm unlinks a directory
 * junction rather than recursing through it, so the target repo's node_modules
 * is never reachable from here (locked in by scripts/check-preview.js — the
 * consequence of being wrong is deleting 472 MB out of the user's real repo).
 *
 * Retries because `next dev` releases its handles on `.next` a moment after the
 * process dies, and a failure here must not throw across IPC — the worst
 * outcome of a failed clear is that the cache is still there.
 */
function clearShadow(userDataDir, repoPath) {
  stopServer();
  const dir = shadowDirFor(userDataDir, repoPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    return { dir, ok: true };
  } catch (err) {
    return { dir, ok: false, error: err.message };
  }
}

/** Bytes on disk under the shadow, for the "clear preview cache" button. */
function shadowSize(userDataDir, repoPath) {
  const dir = shadowDirFor(userDataDir, repoPath);
  let total = 0;
  const walk = (p, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (rel === "" && e.name === "node_modules") continue; // the junction is not ours
      const child = path.join(p, e.name);
      if (e.isDirectory()) walk(child, rel ? `${rel}/${e.name}` : e.name);
      else if (e.isFile()) {
        try {
          total += fs.statSync(child).size;
        } catch (_) {
          /* vanished mid-walk */
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return total;
}

module.exports = {
  SKIP_TOP,
  INJECTED_SCRIPT,
  shadowDirFor,
  commonAncestor,
  syncShadow,
  startServer,
  stopServer,
  serverState,
  clearShadow,
  shadowSize,
};
