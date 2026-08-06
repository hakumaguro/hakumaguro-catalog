const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const { scan } = require("./scan");
const { processImage, centeredCropRect } = require("./pipeline");
const { readArrays } = require("./siteAst");
const { nextId } = require("./idAlloc");
const { ARRAY_CONFIGS, FIXED_SLOTS, TARGET_SIZES, artTarget } = require("./slots");
const { loadSettings, saveSettings, derivedPaths } = require("./settings");
const { Queue } = require("./queue");

let mainWindow;
let currentRepoPath;
const queue = new Queue();

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
  currentRepoPath = loadSettings(app.getPath("userData")).repoPath;
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---- settings ----

ipcMain.handle("settings:get", () => derivedPaths(currentRepoPath));

ipcMain.handle("settings:pickRepoFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  currentRepoPath = result.filePaths[0];
  saveSettings(app.getPath("userData"), { repoPath: currentRepoPath });
  return derivedPaths(currentRepoPath);
});

// ---- catalog ----

ipcMain.handle("catalog:scan", async () => scan(currentRepoPath));

ipcMain.handle("catalog:fixedSlots", () => FIXED_SLOTS);

ipcMain.handle("catalog:targetSizes", () => TARGET_SIZES);

ipcMain.handle("catalog:nextId", (_e, { arrayKey }) => {
  const config = ARRAY_CONFIGS[arrayKey];
  const arrays = readArrays(currentRepoPath);
  const bySrc = { art: arrays.artPieces, vrClip: arrays.vrClips, life: arrays.lifeSource };
  const ids = (bySrc[arrayKey] || []).map((e) => e.id);
  return nextId(ids, config.idPrefix);
});

// ---- source picking + crop math ----

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

async function readImageInfo(sourcePath) {
  const meta = await sharp(sourcePath).metadata();
  const bytes = fs.statSync(sourcePath).size;
  return { sourcePath, width: meta.width, height: meta.height, bytes };
}

ipcMain.handle("dialog:pickImage", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return readImageInfo(result.filePaths[0]);
});

// Companion to dialog:pickImage for drag-and-dropped files, where the
// renderer already has an absolute path (via the dropped File's .path) and
// just needs the same metadata a picker selection would have produced.
ipcMain.handle("dialog:imageInfo", async (_e, { sourcePath }) => {
  if (!IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
    throw new Error(`Unsupported file type: ${path.extname(sourcePath)}`);
  }
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

ipcMain.handle("queue:diff", () => queue.diff(currentRepoPath));

ipcMain.handle("queue:apply", async () => {
  const result = await queue.apply(currentRepoPath);
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
