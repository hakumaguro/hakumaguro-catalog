// Persisted app settings — SPEC.md §4.4. Only `repoPath` is actually editable;
// image directory (`public/`) and content file (`src/lib/site.ts`) are fixed
// relative to it (see SPEC §12 — the mockup's separately-editable versions of
// those two were placeholder paths, not the real architecture) and are shown
// read-only, derived.

const fs = require("fs");
const path = require("path");

const DEFAULT_REPO_PATH = "C:\\Users\\sophanat_phokaenkaew\\Documents\\ClaudeBasket\\hakumaguroDev";

function settingsPath(userDataDir) {
  return path.join(userDataDir, "settings.json");
}

function loadSettings(userDataDir) {
  const file = settingsPath(userDataDir);
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.repoPath === "string") return { repoPath: parsed.repoPath };
    } catch (_) {
      // fall through to default
    }
  }
  return { repoPath: DEFAULT_REPO_PATH };
}

function saveSettings(userDataDir, settings) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(settings, null, 2));
}

function derivedPaths(repoPath) {
  return {
    repoPath,
    publicDir: path.join(repoPath, "public"),
    contentFile: path.join(repoPath, "src", "lib", "site.ts"),
  };
}

module.exports = { DEFAULT_REPO_PATH, loadSettings, saveSettings, derivedPaths };
