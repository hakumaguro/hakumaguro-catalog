const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sharp = require("sharp");
// libvips (sharp's backend) caches recently-read files by default, which on
// Windows can keep a file handle open well after the read completes — long
// enough that a later write to that same path (e.g. Apply overwriting an
// image scan() just read for the Library view) fails with EPERM/UNKNOWN.
// Global, process-wide setting; must be set before any sharp() call.
sharp.cache(false);

const { scan } = require("./scan");
const { processImage, centeredCropRect } = require("./pipeline");
const { readArrays } = require("./siteAst");
const { nextId } = require("./idAlloc");
const { ARRAY_CONFIGS, FIXED_SLOTS, TARGET_SIZES, artTarget } = require("./slots");
const {
  resolveRepoPath,
  validateRepo,
  saveSettings,
  derivedPaths,
  REPO_MARKERS,
} = require("./settings");
const { Queue } = require("./queue");

let mainWindow;
let currentRepoPath;
// Result of the last repo resolution/validation — drives whether the renderer
// shows the picker gate or the normal UI. See settings.js resolveRepoPath().
let repoStatus = { ok: false, missing: REPO_MARKERS.slice(), reason: "no-path", source: "none" };
const queue = new Queue();

// Shape sent to the renderer for every settings read/change: derived paths plus
// the validity verdict, so one payload answers both "where is it" and "can we
// use it". `sep` lets the renderer join paths without assuming a platform.
function settingsPayload() {
  return {
    ...derivedPaths(currentRepoPath),
    ok: repoStatus.ok,
    missing: repoStatus.missing || [],
    reason: repoStatus.reason || null,
    source: repoStatus.source || null,
    markers: REPO_MARKERS,
    sep: path.sep,
  };
}

// Guard for every handler that reads or writes the target repo. The renderer's
// gate should make this unreachable, but an IPC surface shouldn't depend on the
// renderer behaving — without it a null repoPath surfaces as a confusing ENOENT
// deep inside ts-morph or sharp.
function requireRepo() {
  if (!repoStatus.ok) {
    throw new Error("No valid hakumaguro.dev repo is selected — choose one in Settings first.");
  }
  return currentRepoPath;
}

function mimeFor(format) {
  return format === "png" ? "image/png" : "image/webp";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#fcfbf7",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  repoStatus = resolveRepoPath({
    userDataDir: app.getPath("userData"),
    appRoot: path.join(__dirname, "..", ".."),
  });
  currentRepoPath = repoStatus.repoPath;
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---- settings ----

ipcMain.handle("settings:get", () => settingsPayload());

// Returns null if the user cancelled, otherwise the same payload as
// settings:get with `ok` telling the caller whether the pick was accepted.
// A folder that isn't a hakumaguro.dev checkout is REJECTED — neither saved nor
// made current — so a mis-click can't strand the app pointing at nothing; the
// rejected path and its `missing` markers still come back so the UI can explain.
ipcMain.handle("settings:pickRepoFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select the hakumaguro.dev repo folder",
    defaultPath: currentRepoPath || undefined,
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const picked = result.filePaths[0];
  const check = validateRepo(picked);
  if (!check.ok) {
    return { ...derivedPaths(picked), ok: false, missing: check.missing, reason: check.reason, source: "rejected", markers: REPO_MARKERS, sep: path.sep };
  }

  currentRepoPath = picked;
  repoStatus = { ...check, source: "picked" };
  saveSettings(app.getPath("userData"), { repoPath: currentRepoPath });
  return settingsPayload();
});

// Re-checks the current path on demand — lets the gate offer a "Retry" for the
// case where the folder is simply not mounted yet (external drive, OneDrive
// still syncing) rather than genuinely wrong.
ipcMain.handle("settings:recheck", () => {
  if (currentRepoPath) repoStatus = { ...validateRepo(currentRepoPath), source: repoStatus.source };
  return settingsPayload();
});

// ---- catalog ----

ipcMain.handle("catalog:scan", async () => scan(requireRepo()));

ipcMain.handle("catalog:fixedSlots", () => FIXED_SLOTS);

ipcMain.handle("catalog:targetSizes", () => TARGET_SIZES);

ipcMain.handle("catalog:nextId", (_e, { arrayKey }) => {
  const config = ARRAY_CONFIGS[arrayKey];
  const arrays = readArrays(requireRepo());
  const bySrc = { art: arrays.artPieces, vrClip: arrays.vrClips, life: arrays.lifeSource };
  const ids = (bySrc[arrayKey] || []).map((e) => e.id);
  return nextId(ids, config.idPrefix);
});

// Library thumbnails are served as data URLs rather than file:// src's.
// Windows keeps a lasting lock on any local file Chromium has loaded via
// file://, for the life of the renderer process — which makes a later Apply
// (overwriting that same output path) fail with UNKNOWN/EPERM. A data URL
// hands over the bytes directly with no open handle left behind.
ipcMain.handle("catalog:thumbDataUrl", (_e, { filePath }) => {
  const publicDir = path.resolve(path.join(requireRepo(), "public"));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(publicDir + path.sep)) {
    throw new Error("thumbDataUrl: path outside the repo's public dir");
  }
  const buf = fs.readFileSync(resolved);
  const mime = path.extname(resolved).toLowerCase() === ".png" ? "image/png" : "image/webp";
  return `data:${mime};base64,${buf.toString("base64")}`;
});

// ---- source picking + crop math ----

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ...HEIC_EXTENSIONS]);

function importsDir() {
  const dir = path.join(app.getPath("temp"), "hakumaguro-catalog-imports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// sharp/libvips can read a HEIC file's container/metadata but not decode its
// pixels — prebuilt sharp binaries don't ship the HEVC decoder plugin (the
// codec iPhones actually use) due to its patent licensing, only the
// royalty-free AVIF codec within the same HEIF container. heic-convert uses
// a separate (patent-unencumbered) pure JS/WASM decoder instead. Converts to
// a real JPEG temp file so the rest of the pipeline — which is entirely
// sharp/fs path-based — never needs to know the source was ever HEIC.
async function normalizeSourcePath(sourcePath) {
  if (!HEIC_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) return sourcePath;
  const heicConvert = require("heic-convert");
  const inputBuffer = fs.readFileSync(sourcePath);
  const jpegBuffer = await heicConvert({ buffer: inputBuffer, format: "JPEG", quality: 0.92 });
  const outPath = path.join(importsDir(), `${Date.now()}-${crypto.randomUUID()}.jpg`);
  fs.writeFileSync(outPath, jpegBuffer);
  return outPath;
}

async function readImageInfo(rawSourcePath) {
  const sourcePath = await normalizeSourcePath(rawSourcePath);
  const meta = await sharp(sourcePath).metadata();
  const bytes = fs.statSync(sourcePath).size;
  return { sourcePath, width: meta.width, height: meta.height, bytes };
}

ipcMain.handle("dialog:pickImage", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "heic", "heif"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return readImageInfo(result.filePaths[0]);
});

// Companion to dialog:pickImage for drag-and-dropped files, where the
// renderer already has an absolute path (via webUtils.getPathForFile) and
// just needs the same metadata a picker selection would have produced.
ipcMain.handle("dialog:imageInfo", async (_e, { sourcePath }) => {
  if (!IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
    throw new Error(`Unsupported file type: ${path.extname(sourcePath)}`);
  }
  return readImageInfo(sourcePath);
});

// Fallback for drops webUtils.getPathForFile can't resolve a path for — e.g.
// an image dragged straight out of a browser tab rather than a saved file,
// which Chromium sometimes hands over as data with no real filesystem
// backing. The renderer reads the File's raw bytes itself and sends them
// here; we write them to a real temp file so the rest of the pipeline (which
// is all path-based, via sharp/fs) doesn't need to know the difference.
ipcMain.handle("dialog:importImageBuffer", async (_e, { name, data }) => {
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }
  const sourcePath = path.join(importsDir(), `${Date.now()}-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(sourcePath, Buffer.from(data));
  return readImageInfo(sourcePath);
});

ipcMain.handle("catalog:targetFor", (_e, { kind, span, lifeHeight }) => {
  if (kind === "art") return artTarget(span);
  if (kind === "life") return { w: 712, h: (lifeHeight || 260) * 2 };
  if (kind === "vr-clip") return TARGET_SIZES.vrClip;
  // plain/fixed slots pass their target explicitly via FIXED_SLOTS lookup instead
  return null;
});

ipcMain.handle("catalog:centeredCropRect", (_e, { sourceWidth, sourceHeight, target }) =>
  centeredCropRect(sourceWidth, sourceHeight, target),
);

// ---- queue ----

ipcMain.handle("queue:list", () => queue.list());

ipcMain.handle("queue:remove", (_e, { key }) => {
  queue.remove(key);
  return queue.list();
});

ipcMain.handle("queue:discardAll", () => {
  queue.clear();
  return queue.list();
});

ipcMain.handle("queue:diff", () => queue.diff(requireRepo()));

ipcMain.handle("queue:apply", async () => {
  const result = await queue.apply(requireRepo());
  return result;
});

/**
 * payload.kind: "array-new" | "array-replace" | "array-delete" | "array-reorder" | "fixed-replace"
 * For the image-bearing kinds, payload carries sourcePath/cropRect/target/format
 * and the queued Buffer is produced here (SPEC §4.2 — convert happens at queue time).
 */
ipcMain.handle("queue:add", async (_e, payload) => {
  const format = payload.format || "webp";

  if (payload.kind === "array-delete") {
    queue.add({
      op: "DELETE",
      section: payload.section,
      varName: payload.varName,
      id: payload.id,
      contentDescription: `${payload.varName}[${payload.id}]`,
      transform: "remove from library + content array",
    });
    return { ok: true, list: queue.list() };
  }

  if (payload.kind === "array-reorder") {
    queue.add({
      op: "REORDER",
      section: payload.section,
      varName: payload.varName,
      orderedIds: payload.orderedIds,
      contentDescription: `src/lib/site.ts (${payload.varName} order)`,
      transform: `${payload.section} section order changed`,
    });
    return { ok: true, list: queue.list() };
  }

  // image-bearing kinds: array-new, array-replace, fixed-replace
  const sourceBytes = fs.statSync(payload.sourcePath).size;
  const buffer = await processImage(payload.sourcePath, payload.cropRect, payload.target, format);
  const previewDataUrl = `data:${mimeFor(format)};base64,${buffer.toString("base64")}`;

  if (payload.kind === "array-new") {
    queue.add({
      op: "NEW",
      section: payload.section,
      varName: payload.varName,
      id: payload.id,
      fields: payload.fields,
      buffer,
      outFilename: payload.outFilename,
      sourceBytes,
      previewDataUrl,
      transform: `new · ${payload.target.w} × ${payload.target.h}`,
    });
  } else if (payload.kind === "array-replace") {
    queue.add({
      op: "REPLACE",
      section: payload.section,
      varName: payload.varName,
      id: payload.id,
      patch: payload.patch,
      buffer,
      outFilename: payload.outFilename,
      sourceBytes,
      previewDataUrl,
      transform: `recrop · ${payload.target.w} × ${payload.target.h}`,
    });
  } else if (payload.kind === "fixed-replace") {
    queue.add({
      op: "REPLACE",
      section: payload.section,
      file: payload.file,
      newAlt: payload.newAlt,
      wrapperAttr: payload.wrapperAttr,
      labelProp: payload.labelProp,
      buffer,
      outFilename: payload.file,
      sourceBytes,
      previewDataUrl,
      transform: `recrop · ${payload.target.w} × ${payload.target.h}`,
    });
  } else {
    throw new Error(`queue:add — unknown kind "${payload.kind}"`);
  }

  return { ok: true, list: queue.list() };
});

module.exports = { FIXED_SLOTS };
