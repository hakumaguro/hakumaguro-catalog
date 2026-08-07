const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("catalog", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  pickRepoFolder: () => ipcRenderer.invoke("settings:pickRepoFolder"),
  recheckRepo: () => ipcRenderer.invoke("settings:recheck"),

  // Electron removed File.path from renderer-side File objects (Electron 32+);
  // webUtils.getPathForFile is the replacement, but it's only callable from
  // the preload/main context, not the sandboxed renderer directly.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  scan: () => ipcRenderer.invoke("catalog:scan"),
  fixedSlots: () => ipcRenderer.invoke("catalog:fixedSlots"),
  targetSizes: () => ipcRenderer.invoke("catalog:targetSizes"),
  nextId: (arrayKey) => ipcRenderer.invoke("catalog:nextId", { arrayKey }),
  thumbDataUrl: (filePath) => ipcRenderer.invoke("catalog:thumbDataUrl", { filePath }),
  targetFor: (kind, span, lifeHeight) => ipcRenderer.invoke("catalog:targetFor", { kind, span, lifeHeight }),
  centeredCropRect: (sourceWidth, sourceHeight, target) =>
    ipcRenderer.invoke("catalog:centeredCropRect", { sourceWidth, sourceHeight, target }),

  pickImage: () => ipcRenderer.invoke("dialog:pickImage"),
  imageInfo: (sourcePath) => ipcRenderer.invoke("dialog:imageInfo", { sourcePath }),
  importImageBuffer: (name, data) => ipcRenderer.invoke("dialog:importImageBuffer", { name, data }),

  queueList: () => ipcRenderer.invoke("queue:list"),
  queueAdd: (payload) => ipcRenderer.invoke("queue:add", payload),
  queueRemove: (key) => ipcRenderer.invoke("queue:remove", { key }),
  queueDiscardAll: () => ipcRenderer.invoke("queue:discardAll"),
  queueDiff: () => ipcRenderer.invoke("queue:diff"),
  queueApply: () => ipcRenderer.invoke("queue:apply"),

  previewRender: () => ipcRenderer.invoke("preview:render"),
  previewState: () => ipcRenderer.invoke("preview:state"),
  previewStop: () => ipcRenderer.invoke("preview:stop"),
  previewClearCache: () => ipcRenderer.invoke("preview:clearCache"),
  previewCacheSize: () => ipcRenderer.invoke("preview:cacheSize"),
});
