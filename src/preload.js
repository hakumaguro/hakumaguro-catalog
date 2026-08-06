const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("catalog", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  pickRepoFolder: () => ipcRenderer.invoke("settings:pickRepoFolder"),

  scan: () => ipcRenderer.invoke("catalog:scan"),
  fixedSlots: () => ipcRenderer.invoke("catalog:fixedSlots"),
  targetSizes: () => ipcRenderer.invoke("catalog:targetSizes"),
  nextId: (arrayKey) => ipcRenderer.invoke("catalog:nextId", { arrayKey }),
  targetFor: (kind, span, lifeHeight) => ipcRenderer.invoke("catalog:targetFor", { kind, span, lifeHeight }),
  centeredCropRect: (sourceWidth, sourceHeight, target) =>
    ipcRenderer.invoke("catalog:centeredCropRect", { sourceWidth, sourceHeight, target }),

  pickImage: () => ipcRenderer.invoke("dialog:pickImage"),

  queueList: () => ipcRenderer.invoke("queue:list"),
  queueAdd: (payload) => ipcRenderer.invoke("queue:add", payload),
  queueRemove: (key) => ipcRenderer.invoke("queue:remove", { key }),
  queueDiscardAll: () => ipcRenderer.invoke("queue:discardAll"),
  queueDiff: () => ipcRenderer.invoke("queue:diff"),
  queueApply: () => ipcRenderer.invoke("queue:apply"),
});
