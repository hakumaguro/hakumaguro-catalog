// Persisted app settings — SPEC.md §4.4. Only `repoPath` is actually editable;
// image directory (`public/`) and content file (`src/lib/site.ts`) are fixed
// relative to it (see SPEC §12 — the mockup's separately-editable versions of
// those two were placeholder paths, not the real architecture) and are shown
// read-only, derived.
//
// The repo path is machine-specific by nature (this app edits a checkout of
// another repo, wherever the user happens to keep it), so there is deliberately
// NO hardcoded default. Resolution order on launch is:
//   1. the saved settings.json path, if it still validates
//   2. auto-detection near this app's own folder (covers the common layout
//      where both repos are siblings in one workspace dir)
//   3. nothing — the renderer shows the repo-picker gate before any normal screen
// See resolveRepoPath().

const fs = require("fs");
const path = require("path");

// A folder only counts as a hakumaguro.dev checkout if it has all of these.
// They're exactly the paths the AST/scan/write layers reach for (siteAst.js's
// siteTsPath/pageTsxPath/logoMarkTsxPath + the public image dir), so if they're
// all present every downstream module can do its job.
const REPO_MARKERS = [
  path.join("src", "lib", "site.ts"),
  path.join("src", "app", "page.tsx"),
  path.join("src", "ds", "LogoMark.tsx"),
  "public",
];

// Folder names the target repo is known to have been checked out under, tried
// against each ancestor of this app's own directory during auto-detection.
const CANDIDATE_NAMES = ["hakumaguro-dev", "hakumaguroDev", "hakumaguro.dev"];

const REPO_ENV_VAR = "HAKUMAGURO_REPO";

function settingsPath(userDataDir) {
  return path.join(userDataDir, "settings.json");
}

/**
 * Is `repoPath` a usable hakumaguro.dev checkout?
 * Returns { ok, repoPath, missing[], reason } — `missing` lists the
 * repo-relative markers that weren't found, so the UI can say *why* a folder
 * was rejected instead of just refusing it.
 * reason: "no-path" | "not-a-folder" | "not-a-repo" | null (when ok).
 */
function validateRepo(repoPath) {
  if (!repoPath || typeof repoPath !== "string") {
    return { ok: false, repoPath: null, missing: REPO_MARKERS.slice(), reason: "no-path" };
  }
  let isDir = false;
  try {
    isDir = fs.statSync(repoPath).isDirectory();
  } catch (_) {
    isDir = false;
  }
  if (!isDir) {
    return { ok: false, repoPath, missing: REPO_MARKERS.slice(), reason: "not-a-folder" };
  }
  const missing = REPO_MARKERS.filter((marker) => !fs.existsSync(path.join(repoPath, marker)));
  return {
    ok: missing.length === 0,
    repoPath,
    missing,
    reason: missing.length === 0 ? null : "not-a-repo",
  };
}

/**
 * Paths worth trying when there's no valid saved setting, most explicit first:
 * an env var override, then each candidate name under every ancestor of
 * `appRoot` (so a sibling checkout is found whether the workspace is one level
 * up or a few).
 */
function candidateRepoPaths(appRoot) {
  const out = [];
  if (process.env[REPO_ENV_VAR]) out.push(process.env[REPO_ENV_VAR]);
  let dir = path.resolve(appRoot);
  for (let up = 0; up < 3; up++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    for (const name of CANDIDATE_NAMES) out.push(path.join(parent, name));
    dir = parent;
  }
  return out;
}

/** First candidate path that validates, or null. */
function autoDetectRepo(appRoot) {
  for (const candidate of candidateRepoPaths(appRoot)) {
    if (validateRepo(candidate).ok) return path.resolve(candidate);
  }
  return null;
}

function loadSettings(userDataDir) {
  const file = settingsPath(userDataDir);
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.repoPath === "string") return { repoPath: parsed.repoPath };
    } catch (_) {
      // unreadable/corrupt settings file — treat as unset
    }
  }
  return { repoPath: null };
}

function saveSettings(userDataDir, settings) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(settings, null, 2));
}

/**
 * The launch-time resolution described at the top of this file.
 * Returns { repoPath, ok, missing, reason, source } where source is
 * "settings" | "detected" | "stale-settings" | "none" — the last two mean the
 * caller must show the picker gate before the normal UI. A successful
 * auto-detection is persisted so it only happens once per machine.
 */
function resolveRepoPath({ userDataDir, appRoot }) {
  // An explicit env override wins outright, and a *wrong* one is reported
  // rather than quietly falling through to auto-detection — silently using a
  // different repo than the one the user named would be worse than stopping.
  // Not persisted: it's a per-launch override, not a preference.
  const fromEnv = process.env[REPO_ENV_VAR];
  if (fromEnv) return { ...validateRepo(fromEnv), source: "env" };

  const saved = loadSettings(userDataDir).repoPath;
  const savedCheck = validateRepo(saved);
  if (savedCheck.ok) return { ...savedCheck, source: "settings" };

  const detected = autoDetectRepo(appRoot);
  if (detected) {
    saveSettings(userDataDir, { repoPath: detected });
    return { ...validateRepo(detected), source: "detected" };
  }

  // Keep the stale path around (rather than nulling it) so the gate can show
  // the user which saved location stopped resolving.
  return { ...savedCheck, source: saved ? "stale-settings" : "none" };
}

/**
 * Repo path for the headless scripts in scripts/, which have no Electron
 * userData dir to read a saved setting from: env var, else auto-detection from
 * this file's own location. Throws with an actionable message rather than
 * letting a downstream ENOENT surface as a stack trace.
 */
function resolveRepoPathForScripts() {
  const fromEnv = process.env[REPO_ENV_VAR];
  if (fromEnv) {
    const check = validateRepo(fromEnv);
    if (!check.ok) {
      throw new Error(`${REPO_ENV_VAR}="${fromEnv}" is not a hakumaguro.dev checkout (missing: ${check.missing.join(", ")})`);
    }
    return path.resolve(fromEnv);
  }
  const detected = autoDetectRepo(path.join(__dirname, "..", ".."));
  if (!detected) {
    throw new Error(`Could not locate the hakumaguro.dev repo. Set ${REPO_ENV_VAR} to its path and re-run.`);
  }
  return detected;
}

function derivedPaths(repoPath) {
  if (!repoPath) return { repoPath: null, publicDir: null, contentFile: null };
  return {
    repoPath,
    publicDir: path.join(repoPath, "public"),
    contentFile: path.join(repoPath, "src", "lib", "site.ts"),
  };
}

module.exports = {
  REPO_MARKERS,
  REPO_ENV_VAR,
  validateRepo,
  autoDetectRepo,
  candidateRepoPaths,
  resolveRepoPath,
  resolveRepoPathForScripts,
  loadSettings,
  saveSettings,
  derivedPaths,
};
