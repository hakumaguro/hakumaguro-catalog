"use strict";

// ---- static metadata (mirrors slots.js / SPEC.md §2, kept in the renderer
// only for display grouping + labels — all actual sizing/id rules live in
// main process modules and are asked for via IPC, never recomputed here) ----

const SECTION_ORDER = ["hero", "imagination", "virtual", "ground", "home", "brand"];
const SECTION_META = {
  hero: { name: "Hero", accent: "#5fb58f", desc: "the opening band" },
  imagination: { name: "Imagination", accent: "#c2547e", desc: "AI art bento grid" },
  virtual: { name: "Virtual", accent: "#7261b8", desc: "VRChat portrait & clips" },
  ground: { name: "Ground", accent: "#c07a3a", desc: "life gallery · masonry" },
  home: { name: "Home", accent: "#5fb58f", desc: "contact band" },
  brand: { name: "Brand", accent: "#c2547e", desc: "nav logo mark" },
};

const ARRAY_META = {
  art: { varName: "artPieces", arrayKey: "art", kind: "art", section: "imagination" },
  "vr-clip": { varName: "vrClips", arrayKey: "vrClip", kind: "vr-clip", section: "virtual" },
  life: { varName: "lifeSource", arrayKey: "life", kind: "life", section: "ground" },
};

const LIFE_TAGS = {
  Drone: { fg: "#1f6b4e", bg: "#e3efe8", bd: "#c6e0d3" },
  Gadget: { fg: "#4a4550", bg: "#eeebe6", bd: "#ddd7ce" },
  Travel: { fg: "#8a5722", bg: "#fff4e8", bd: "#f0dcc2" },
  Food: { fg: "#8c2f56", bg: "#fbe7ef", bd: "#f2ccdc" },
};
const SPANS = ["none", "wide", "tall", "wide-tall"];
const TILTS = ["left", "none", "right"];

const CROP_MAX_W = 640;
const CROP_MAX_H = 480;

// ---- state ----

const state = {
  screen: "library",
  filter: "all",
  settings: null,
  fixedSlots: [],
  scanResult: null,
  queueList: [],
  deleteConfirmKey: null, // `${varName}:${id}` currently showing inline confirm
  editor: null,
  applyResult: null, // last apply() outcome, shown on the review screen
  busy: false,
};

const dom = { app: document.getElementById("app") };

// ---- helpers ----

function fmtBytes(n) {
  if (n == null) return "—";
  return n >= 1024 * 1024 ? (n / (1024 * 1024)).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
}

function toFileUrl(absPath) {
  return "file:///" + encodeURI(absPath.replace(/\\/g, "/")).replace(/#/g, "%23");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function imgSrc(item) {
  if (!item.file || item.missing) return null;
  return toFileUrl(state.settings.publicDir + "\\" + item.file);
}

function queueKeyFor(varName, id) {
  return `${varName}::${id}`;
}

// ---- data loading ----

async function refreshQueue() {
  state.queueList = await window.catalog.queueList();
}

async function refreshScan() {
  state.scanResult = await window.catalog.scan();
}

async function loadAll() {
  state.settings = await window.catalog.getSettings();
  state.fixedSlots = await window.catalog.fixedSlots();
  await refreshScan();
  await refreshQueue();
  render();
}

function fixedSlotById(id) {
  return state.fixedSlots.find((s) => s.id === id);
}

// order for an array section = disk order, rearranged by any pending REORDER
// queue item for that varName (SPEC-consistent: reorder is expressed as a
// full target order, so the latest queued one always wins — see main.js
// dedup in queue:add).
function effectiveOrder(varName, naturalIds) {
  const pending = state.queueList.find((q) => q.op === "REORDER" && q.varName === varName);
  if (!pending) return naturalIds;
  return pending.orderedIds.filter((id) => naturalIds.includes(id)).concat(naturalIds.filter((id) => !pending.orderedIds.includes(id)));
}

function pendingReorderIds(varName) {
  const pending = state.queueList.find((q) => q.op === "REORDER" && q.varName === varName);
  return pending ? pending.orderedIds : null;
}

function isQueuedForDelete(varName, id) {
  return state.queueList.some((q) => q.op === "DELETE" && q.varName === varName && q.id === id);
}

function hasQueuedChange(varName, id, file) {
  return state.queueList.some(
    (q) => (q.op === "NEW" || q.op === "REPLACE") && ((varName && q.varName === varName && q.id === id) || (!varName && q.file === file)),
  );
}

// ---- render dispatch ----

function render() {
  const d = computeDerived();
  dom.app.innerHTML = `
    <div class="titlebar">
      <div style="width:52px;"></div>
      <div class="titlebar-title">
        <div class="titlebar-dot"></div>
        <span class="titlebar-name">Hakumaguro Catalog</span>
      </div>
      <div class="titlebar-path"><span class="titlebar-path-dot"></span><span class="mono" style="font-size:10.5px;color:#7a7385;">${esc(state.settings ? state.settings.repoPath : "")}</span></div>
    </div>
    <div class="body-row">
      ${renderSidebar(d)}
      <div class="main">${renderScreen(d)}</div>
    </div>
  `;
  bindScreenEvents(d);
}

function computeDerived() {
  const sections = state.scanResult ? state.scanResult.sections : {};
  const deletedCount = state.queueList.filter((q) => q.op === "DELETE").length;
  let total = 0, empty = 0, warn = 0;
  for (const key of Object.keys(sections)) {
    for (const it of sections[key]) {
      if (isQueuedForDelete(itemVarName(it), it.id)) continue;
      total++;
      if (it.missing) empty++;
      if (it.warnings) warn++;
    }
  }
  return {
    sections,
    statLine: `${total} slots · ${total - empty} set · ${empty} empty`,
    warnCount: warn,
    queueCount: state.queueList.length,
  };
}

function itemVarName(it) {
  if (!it.list) return null;
  return (ARRAY_META[it.kind] || {}).varName || null;
}

function renderSidebar(d) {
  const navItems = [
    { key: "library", label: "Library", icon: "▦" },
    { key: "review", label: "Review & apply", icon: "⇄", badge: d.queueCount > 0 ? d.queueCount : null },
    { key: "settings", label: "Settings", icon: "⚙" },
  ];
  const nav = navItems
    .map(
      (n) => `
    <button class="nav-item ${state.screen === n.key ? "active" : ""}" data-nav="${n.key}">
      <span class="nav-icon">${n.icon}</span><span>${n.label}</span>
      ${n.badge ? `<span class="nav-badge">${n.badge}</span>` : ""}
    </button>`,
    )
    .join("");

  const rail = [{ key: "all", label: "All slots", accent: "#c8c2ce" }]
    .concat(SECTION_ORDER.map((k) => ({ key: k, label: SECTION_META[k].name, accent: SECTION_META[k].accent })))
    .map((r) => {
      const count = r.key === "all"
        ? Object.values(d.sections).reduce((n, s) => n + s.filter((it) => !isQueuedForDelete(itemVarName(it), it.id)).length, 0)
        : (d.sections[r.key] || []).filter((it) => !isQueuedForDelete(itemVarName(it), it.id)).length;
      const active = state.screen === "library" && state.filter === r.key;
      return `
      <button class="rail-item ${active ? "active" : ""}" data-filter="${r.key}">
        <span class="rail-dot" style="background:${r.accent}"></span>
        <span style="flex:1;text-align:left;">${r.label}</span>
        <span class="rail-count mono">${count}</span>
      </button>`;
    })
    .join("");

  return `
    <div class="sidebar">
      <div class="sidebar-section-label label">Workspace</div>
      <div class="nav-list">${nav}</div>
      <div class="sidebar-section-label label" style="padding-top:20px;">Site sections</div>
      <div class="rail-list">${rail}</div>
      <div class="sidebar-footer">
        <div class="mono">${d.statLine}</div>
        <div class="mono">no git integration</div>
      </div>
    </div>
  `;
}

function renderScreen(d) {
  if (state.screen === "library") return renderLibrary(d);
  if (state.screen === "add") return renderEditor(d);
  if (state.screen === "review") return renderReview(d);
  if (state.screen === "settings") return renderSettings(d);
  return "";
}

// ---- library ----

function renderLibrary(d) {
  const keys = state.filter === "all" ? SECTION_ORDER : [state.filter];
  const title = state.filter === "all" ? "Every slot on hakumaguro.dev" : `${SECTION_META[state.filter].name} section`;

  const blocks = keys
    .map((key) => {
      const meta = SECTION_META[key];
      const items = d.sections[key] || [];
      const arrayMetaForSection = Object.values(ARRAY_META).find((a) => a.section === key);
      const cards = renderSectionCards(key, items, arrayMetaForSection);
      const specText = arrayMetaForSection
        ? `${items.filter((it) => !isQueuedForDelete(itemVarName(it), it.id)).length} slots · growable`
        : `${items.length} slot${items.length === 1 ? "" : "s"}`;
      return `
      <div class="section-block">
        <div class="section-heading">
          <span class="section-dot" style="background:${meta.accent}"></span>
          <span class="section-name">${meta.name}</span>
          <span class="section-desc">${meta.desc}</span>
          <span class="section-rule"></span>
          <span class="section-spec mono">${specText}</span>
        </div>
        <div class="card-grid">${cards}</div>
      </div>`;
    })
    .join("");

  return `
    <div style="flex:1;display:flex;flex-direction:column;min-height:0;">
      <div class="screen-header">
        <div style="flex:1;">
          <div class="label screen-kicker">Library</div>
          <div class="screen-title">${title}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${d.warnCount > 0 ? `<div class="warn-pill"><span class="warn-pill-dot"></span><span>${d.warnCount} slots flagged</span></div>` : ""}
        </div>
      </div>
      <div class="library-scroll">${blocks || `<div class="empty-state">No slots scanned yet.</div>`}</div>
    </div>
  `;
}

function renderSectionCards(sectionKey, items, arrayMeta) {
  // A section can mix a fixed plain slot with an array (e.g. "virtual" holds
  // both vrc-portrait, a fixed slot, and the vrClips array) — render plain
  // items unconditionally, then the array's ordered list + add-tile if this
  // section has one.
  let html = "";
  const plainItems = items.filter((it) => !it.list);
  html += plainItems.map((it) => renderCard(it, null, 0, 1)).join("");

  if (arrayMeta) {
    const listItems = items.filter((it) => it.list);
    const naturalIds = listItems.map((it) => it.id);
    const order = effectiveOrder(arrayMeta.varName, naturalIds);
    const byId = new Map(listItems.map((it) => [it.id, it]));
    const visibleIds = order.filter((id) => !isQueuedForDelete(arrayMeta.varName, id));
    html += visibleIds.map((id, idx) => renderCard(byId.get(id), arrayMeta, idx, visibleIds.length)).join("");
    html += `<div class="card-add-tile" data-add-array="${arrayMeta.arrayKey}">
      <span style="font-size:22px;line-height:1;">+</span>
      <span class="label" style="color:#2e8a67;">Add ${arrayMeta.kind === "life" ? "life photo" : arrayMeta.kind === "vr-clip" ? "clip" : "art piece"}</span>
    </div>`;
  }
  return html;
}

function renderCard(it, arrayMeta, idx, total) {
  if (!it) return "";
  const varName = arrayMeta ? arrayMeta.varName : null;
  const queuedDelete = isQueuedForDelete(varName, it.id);
  const src = imgSrc(it);
  const isCircle = ["hero-portrait", "contact-avatar", "logo-mark"].includes(it.id);
  const radius = isCircle ? "50%" : "10px";
  const confirmKey = queueKeyFor(varName, it.id);
  const showConfirm = state.deleteConfirmKey === confirmKey;
  const queued = hasQueuedChange(varName, it.id, it.file);

  const thumbInner = src
    ? `<img src="${src}" alt="">`
    : `<div class="card-empty"><span class="card-empty-plus">+</span><span class="card-empty-label">not set</span></div>`;

  const warnBadge = it.warnings ? `<div class="card-warn-badge"><span class="card-warn-dot"></span><span>${esc(it.warnings[0].tag)}</span></div>` : "";
  const tagChip = it.tag ? `<div class="card-tag" style="color:${LIFE_TAGS[it.tag].fg};background:${LIFE_TAGS[it.tag].bg};">${it.tag}</div>` : "";
  const metaText = it.width ? `${it.width} × ${it.height} · ${fmtBytes(it.bytes)}` : it.missing ? "no file · slot renders blank" : "";
  const extraText = it.kind === "life" ? [it.title, `h ${it.lifeHeight}`].filter(Boolean).join(" · ")
    : it.kind === "art" ? `span ${it.span || "none"} · tilt ${it.tilt || "none"}` : "";
  const warnText = it.warnings ? `<div class="card-warn-text">${esc(it.warnings[0].text)}</div>` : "";

  let footer = "";
  if (showConfirm) {
    footer = `<div class="card-confirm">
      <span class="card-confirm-text">Delete this photo? Only the working tree changes.</span>
      <button class="card-confirm-btn card-confirm-cancel" data-cancel-delete>Cancel</button>
      <button class="card-confirm-btn card-confirm-delete" data-confirm-delete="${esc(varName)}|${esc(it.id)}">Delete</button>
    </div>`;
  } else if (queuedDelete) {
    footer = `<div class="card-deleted-pill">Queued for deletion — <a href="#" data-undo-delete="${esc(varName)}|${esc(it.id)}">undo</a></div>`;
  } else if (arrayMeta) {
    const canUp = idx > 0, canDown = idx < total - 1;
    footer = `<div class="card-toolbar">
      <button class="card-tool-btn" data-move="${esc(varName)}|${esc(it.id)}|-1" ${canUp ? "" : "disabled"} title="Move up">↑</button>
      <button class="card-tool-btn" data-move="${esc(varName)}|${esc(it.id)}|1" ${canDown ? "" : "disabled"} title="Move down">↓</button>
      <span style="flex:1;"></span>
      <button class="card-tool-btn delete" data-ask-delete="${esc(varName)}|${esc(it.id)}" title="Delete">🗑</button>
    </div>`;
    if (queued) footer += `<div class="card-queued-pill">● queued</div>`;
  } else if (queued) {
    footer = `<div class="card-queued-pill">● queued</div>`;
  }

  return `
    <div class="card ${queuedDelete ? "queued-delete" : ""}" data-open="${esc(it.id)}" data-kind="${esc(it.kind)}">
      <div class="card-thumb-wrap">
        <div class="card-thumb" style="border-radius:${radius};aspect-ratio:${isCircle ? "1" : "auto"};${isCircle ? "" : "height:150px;"}">
          ${thumbInner}
        </div>
        ${warnBadge}
        ${tagChip}
      </div>
      <div class="card-body">
        <div class="card-file mono">${esc(it.file || it.id + " (no file)")}</div>
        <div class="card-meta mono">${esc(metaText)}</div>
        ${extraText ? `<div class="card-extra mono">${esc(extraText)}</div>` : ""}
        ${warnText}
        ${footer}
      </div>
    </div>`;
}

// ---- editor (add / replace) ----

async function openEditorForExisting(itemId, kind) {
  let found = null;
  for (const key of Object.keys(state.scanResult.sections)) {
    for (const it of state.scanResult.sections[key]) {
      if (it.id === itemId) found = { section: key, it };
    }
  }
  if (!found) return;
  const { section, it } = found;

  if (kind === "plain") {
    const fixed = fixedSlotById(it.id);
    state.editor = {
      mode: "fixed", action: "replace", section, kind: "plain",
      fixedSlotId: it.id, file: it.file, wrapperAttr: fixed.wrapperAttr, labelProp: fixed.labelProp,
      hasAlt: !!fixed.wrapperAttr, altText: it.alt || "",
      target: fixed.target, format: fixed.format,
      sourcePath: null, sourceW: 0, sourceH: 0, sourceBytes: 0,
      pan: { x: 0, y: 0 }, zoom: 100,
    };
  } else {
    const arrayMeta = ARRAY_META[kind];
    state.editor = {
      mode: "array", action: "replace", section, kind,
      varName: arrayMeta.varName, arrayKey: arrayMeta.arrayKey, id: it.id, existingFile: it.file,
      mediaLabel: it.mediaLabel || "", title: it.title || "", tag: it.tag || "Food",
      lifeHeight: it.lifeHeight || 260, span: it.span || "none", tilt: it.tilt || "none",
      target: null, format: "webp",
      sourcePath: null, sourceW: 0, sourceH: 0, sourceBytes: 0,
      pan: { x: 0, y: 0 }, zoom: 100,
    };
    await refreshEditorTarget();
  }
  state.screen = "add";
  render();
}

async function openEditorForNew(arrayKey) {
  const arrayMeta = Object.values(ARRAY_META).find((a) => a.arrayKey === arrayKey);
  const id = await window.catalog.nextId(arrayKey);
  state.editor = {
    mode: "array", action: "new", section: arrayMeta.section, kind: arrayMeta.kind,
    varName: arrayMeta.varName, arrayKey, id,
    mediaLabel: "", title: "", tag: "Food", lifeHeight: 260, span: "none", tilt: "none",
    target: null, format: "webp",
    sourcePath: null, sourceW: 0, sourceH: 0, sourceBytes: 0,
    pan: { x: 0, y: 0 }, zoom: 100,
  };
  await refreshEditorTarget();
  state.screen = "add";
  render();
}

async function refreshEditorTarget() {
  const e = state.editor;
  if (e.kind === "art") e.target = await window.catalog.targetFor("art", e.span, null);
  else if (e.kind === "life") e.target = await window.catalog.targetFor("life", null, e.lifeHeight);
  else if (e.kind === "vr-clip") e.target = await window.catalog.targetFor("vr-clip", null, null);
}

function frameSizeFor(target) {
  const aspect = target.w / target.h;
  let w = CROP_MAX_W, h = CROP_MAX_W / aspect;
  if (h > CROP_MAX_H) { h = CROP_MAX_H; w = CROP_MAX_H * aspect; }
  return { w: Math.round(w), h: Math.round(h) };
}

function clampPan(e) {
  if (!e.sourcePath) return;
  const frame = frameSizeFor(e.target);
  const baseFit = Math.max(frame.w / e.sourceW, frame.h / e.sourceH);
  const scale = baseFit * (e.zoom / 100);
  const dispW = e.sourceW * scale, dispH = e.sourceH * scale;
  const maxX = Math.max(0, (dispW - frame.w) / 2);
  const maxY = Math.max(0, (dispH - frame.h) / 2);
  e.pan.x = Math.max(-maxX, Math.min(maxX, e.pan.x));
  e.pan.y = Math.max(-maxY, Math.min(maxY, e.pan.y));
}

function computeCropRect(e) {
  const frame = frameSizeFor(e.target);
  const baseFit = Math.max(frame.w / e.sourceW, frame.h / e.sourceH);
  const scale = baseFit * (e.zoom / 100);
  const dispW = e.sourceW * scale, dispH = e.sourceH * scale;
  const left = (dispW - frame.w) / 2 - e.pan.x;
  const top = (dispH - frame.h) / 2 - e.pan.y;
  let cropLeft = left / scale, cropTop = top / scale;
  let cropW = frame.w / scale, cropH = frame.h / scale;
  cropLeft = Math.max(0, Math.min(e.sourceW - cropW, cropLeft));
  cropTop = Math.max(0, Math.min(e.sourceH - cropH, cropTop));
  return { left: cropLeft, top: cropTop, width: cropW, height: cropH };
}

function renderEditor() {
  const e = state.editor;
  if (!e) return "";
  const frame = e.target ? frameSizeFor(e.target) : { w: 0, h: 0 };
  const ratioLabel = e.target ? `${(e.target.w / e.target.h).toFixed(3)} : 1` : "";
  const breadcrumb = e.mode === "fixed"
    ? `${SECTION_META[e.section].name} › ${e.fixedSlotId} · ${ratioLabel} locked`
    : `${SECTION_META[e.section].name} › ${e.id} · target ${e.target ? e.target.w + "×" + e.target.h : "…"}`;

  let stageInner;
  if (e.sourcePath) {
    const baseFit = Math.max(frame.w / e.sourceW, frame.h / e.sourceH);
    const scale = baseFit * (e.zoom / 100);
    const dispW = Math.round(e.sourceW * scale), dispH = Math.round(e.sourceH * scale);
    stageInner = `
      <img id="crop-img" class="crop-image" draggable="false" src="${toFileUrl(e.sourcePath)}"
           style="width:${dispW}px;height:${dispH}px;transform:translate(-50%,-50%) translate(${e.pan.x}px,${e.pan.y}px);">
      <div class="crop-frame" style="width:${frame.w}px;height:${frame.h}px;">
        <div class="grid-v" style="left:33.33%;top:0;bottom:0;width:1px;"></div>
        <div class="grid-v" style="left:66.66%;top:0;bottom:0;width:1px;"></div>
        <div class="grid-h" style="top:33.33%;left:0;right:0;height:1px;"></div>
        <div class="grid-h" style="top:66.66%;left:0;right:0;height:1px;"></div>
        <div class="corner" style="left:-5px;top:-5px;border-left-width:3px;border-top-width:3px;"></div>
        <div class="corner" style="right:-5px;top:-5px;border-right-width:3px;border-top-width:3px;"></div>
        <div class="corner" style="left:-5px;bottom:-5px;border-left-width:3px;border-bottom-width:3px;"></div>
        <div class="corner" style="right:-5px;bottom:-5px;border-right-width:3px;border-bottom-width:3px;"></div>
        <div class="crop-ratio-label">${esc(ratioLabel)}</div>
      </div>
      <div class="overlay-pill overlay-source"><span class="mono" style="font-size:11px;">${esc(e.sourcePath.split("\\").pop())}</span><span class="mono" style="font-size:11px;color:#a29baa;">${e.sourceW} × ${e.sourceH} · ${fmtBytes(e.sourceBytes)}</span></div>
      <div class="overlay-pill overlay-output">
        <div class="label" style="margin-bottom:3px;">Output · read-only</div>
        <div class="mono" style="font-size:12px;color:#2e8a67;font-weight:600;">${esc(e.mode === "fixed" ? e.file : (e.action === "new" ? e.id + ".webp" : e.existingFile))}</div>
        <div class="mono" style="font-size:10.5px;color:#7a7385;margin-top:2px;">${e.target ? e.target.w + " × " + e.target.h : ""} · webp q82</div>
      </div>
      <div class="overlay-pill overlay-zoom">
        <span class="label">Zoom</span>
        <input type="range" min="60" max="240" value="${e.zoom}" id="zoom-slider" style="width:150px;">
        <span class="mono" id="zoom-label" style="font-size:11px;width:38px;">${e.zoom}%</span>
        <span id="reset-crop" style="font-size:11px;color:#7a7385;cursor:pointer;border-left:1px solid #e3ddd3;padding-left:11px;">Reset</span>
      </div>
    `;
  } else {
    stageInner = `
      <div class="stage-dropzone" id="stage-dropzone">
        <div class="stage-dropzone-icon">⇩</div>
        <div class="stage-dropzone-title">Drag & drop an image here</div>
        <div class="stage-dropzone-hint">or click to browse · PNG, JPG, WEBP</div>
      </div>
    `;
  }

  const sidePanel = renderEditorSidePanel(e);

  return `
    <div class="editor-row">
      <div class="editor-main">
        <div class="editor-topbar">
          <button class="btn btn-ghost" data-nav="library">← Library</button>
          <div>
            <div class="editor-title">${e.action === "new" ? "Add image" : "Replace image"}</div>
            <div class="editor-breadcrumb mono">${esc(breadcrumb)}</div>
          </div>
        </div>
        <div class="crop-stage ${e.sourcePath ? "" : "empty"}" id="crop-stage">${stageInner}</div>
      </div>
      <div class="side-panel">
        <div class="side-panel-scroll">${sidePanel}</div>
        <div class="editor-footer">
          <button class="btn btn-ghost" data-nav="library">Cancel</button>
          <button class="btn btn-primary" style="flex:1;" id="queue-btn" ${e.sourcePath ? "" : "disabled"}>Queue change</button>
        </div>
      </div>
    </div>
  `;
}

function renderEditorSidePanel(e) {
  let html = `
    <div class="dropzone" id="pick-source">
      <div class="dropzone-title">${e.sourcePath ? "Source loaded" : "Pick source image"}</div>
      <div class="dropzone-hint">${e.sourcePath ? "click or drag a new file to replace" : "click or drag & drop a file"}</div>
    </div>
    <div class="label" style="margin-bottom:9px;">Slot</div>
    <div class="info-card">
      <div class="info-row"><span>Aspect</span><span>${e.target ? (e.target.w / e.target.h).toFixed(3) : "…"}</span></div>
      <div class="info-row"><span>Renders at</span><span>${e.target ? e.target.w + " × " + e.target.h : "…"}</span></div>
      <div class="info-row"><span>Format</span><span>${e.mode === "fixed" ? e.format : "webp"} q82</span></div>
    </div>
  `;

  if (e.mode === "fixed" && e.hasAlt) {
    html += `
      <div class="label" style="margin-bottom:9px;">Alt text</div>
      <label class="field-label">Describe the image for screen readers</label>
      <input class="field-input" id="alt-input" value="${esc(e.altText)}">
    `;
  }

  if (e.kind === "life") {
    html += `
      <div class="label" style="margin-bottom:9px;">Metadata</div>
      <label class="field-label">Title</label>
      <input class="field-input" id="life-title" value="${esc(e.title)}">
      <label class="field-label">Media label (alt text)</label>
      <input class="field-input" id="media-label" value="${esc(e.mediaLabel)}">
      <label class="field-label">Category tag</label>
      <div class="chip-row">${Object.keys(LIFE_TAGS).map((t) => `<div class="chip ${e.tag === t ? "on" : ""}" data-set-tag="${t}" style="color:${e.tag === t ? LIFE_TAGS[t].fg : "#7a7385"};background:${e.tag === t ? LIFE_TAGS[t].bg : "#fff"};">${t}</div>`).join("")}</div>
      <label class="field-label" style="display:flex;justify-content:space-between;"><span>Masonry height</span><span class="mono">${e.lifeHeight}px</span></label>
      <input type="range" min="180" max="460" step="10" value="${e.lifeHeight}" id="life-height" style="width:100%;">
    `;
  } else if (e.kind === "art") {
    html += `
      <div class="label" style="margin-bottom:9px;">Metadata</div>
      <label class="field-label">Media label (alt text)</label>
      <input class="field-input" id="media-label" value="${esc(e.mediaLabel)}">
      <div class="label" style="margin-bottom:9px;">Bento layout</div>
      <label class="field-label">Span</label>
      <div class="chip-grid">${SPANS.map((s) => `<div class="chip" data-set-span="${s}" style="color:${e.span === s ? "#1f6b4e" : "#7a7385"};background:${e.span === s ? "#e3efe8" : "#fff"};border-color:${e.span === s ? "#5fb58f" : "#e3ddd3"};">${s}</div>`).join("")}</div>
      <label class="field-label">Hover tilt</label>
      <div class="chip-row">${TILTS.map((t) => `<div class="chip" data-set-tilt="${t}" style="color:${e.tilt === t ? "#1f6b4e" : "#7a7385"};background:${e.tilt === t ? "#e3efe8" : "#fff"};border-color:${e.tilt === t ? "#5fb58f" : "#e3ddd3"};">${t}</div>`).join("")}</div>
    `;
  } else if (e.kind === "vr-clip") {
    html += `
      <div class="label" style="margin-bottom:9px;">Metadata</div>
      <label class="field-label">Media label (alt text)</label>
      <input class="field-input" id="media-label" value="${esc(e.mediaLabel)}">
    `;
  } else {
    html += `<div class="plain-note">This slot carries no array metadata. Crop${e.hasAlt ? " and alt text are" : " is"} the only decision.</div>`;
  }
  return html;
}

// ---- review & apply ----

function renderReview(d) {
  const items = state.queueList;
  const rows = items
    .map(
      (p) => `
    <div class="pending-row">
      <div class="pending-thumb">${p.previewDataUrl ? `<img src="${p.previewDataUrl}">` : ""}</div>
      <div style="width:78px;flex:none;"><span class="pending-op pending-op-${p.op}">${p.op}</span></div>
      <div style="flex:1;min-width:0;">
        <div class="pending-path mono">${esc(p.path)}</div>
        <div class="pending-transform mono">${esc(p.transform)}</div>
      </div>
      <div class="pending-sizes">${esc(p.sizes)}</div>
      <button class="pending-drop" data-drop-queue="${p.key}">×</button>
    </div>`,
    )
    .join("");

  return `
    <div style="flex:1;display:flex;flex-direction:column;min-height:0;">
      <div class="screen-header" style="border-bottom:none;">
        <div style="flex:1;">
          <div class="label screen-kicker">Review &amp; apply</div>
          <div style="display:flex;align-items:baseline;gap:12px;">
            <div class="screen-title">${items.length} pending change${items.length === 1 ? "" : "s"}</div>
            <div style="font-size:12.5px;color:#9a93a3;">Nothing has been written to disk yet.</div>
          </div>
        </div>
      </div>
      <div class="review-scroll" id="diff-scroll">
        <div class="label" style="margin-bottom:10px;">Files</div>
        ${items.length ? `<div style="margin-bottom:26px;">${rows}</div>` : `<div class="empty-state">Nothing queued. Go to Library and open a slot.</div>`}
        <div id="diff-target"></div>
        ${state.applyResult ? renderApplyResult(state.applyResult) : ""}
      </div>
      <div class="review-footer">
        <div style="flex:1;">
          <div class="review-footer-note">Last checkpoint before disk.</div>
          <div class="review-footer-sub">The app never touches git — commit afterwards if you want an undo.</div>
        </div>
        <button class="btn btn-ghost" id="discard-all" ${items.length ? "" : "disabled"}>Discard all</button>
        <button class="btn btn-primary btn-pill" id="apply-btn" ${items.length ? "" : "disabled"}>${state.busy ? "Applying…" : "Apply " + items.length + " to disk"}</button>
      </div>
    </div>
  `;
}

function renderApplyResult(result) {
  const t = result.tsc;
  const writtenText = result.written.length ? `Written: ${result.written.join(", ")}` : "No image files needed writing.";
  return `<div class="tsc-result ${t.ok ? "tsc-ok" : "tsc-fail"}">${t.ok ? `tsc --noEmit passed. ${esc(writtenText)}` : esc(t.output)}</div>`;
}

function renderDiffFiles(files) {
  if (!files.length) return "";
  return files
    .map(
      (f) => `
    <div class="diff-file">
      <div class="diff-file-head">
        <span>${esc(f.file)}${f.varName ? ` (${f.varName})` : ""}</span>
        <span class="diff-add-count">+${f.additions}</span>
        <span class="diff-del-count">−${f.deletions}</span>
      </div>
      <div class="diff-body">
        ${f.rows
          .map((r) => {
            const cls = r.mark === "+" ? "add" : r.mark === "-" ? "del" : r.mark === "…" ? "skip" : "ctx";
            return `<div class="diff-row ${cls}"><span class="diff-n">${r.n ?? ""}</span><span class="diff-mark">${r.mark === " " ? "" : r.mark}</span><span class="diff-text">${esc(r.text)}</span></div>`;
          })
          .join("")}
      </div>
    </div>`,
    )
    .join("");
}

// ---- settings ----

function renderSettings() {
  const s = state.settings || {};
  return `
    <div class="settings-scroll">
      <div class="settings-max">
        <div class="label screen-kicker">Settings</div>
        <div class="screen-title" style="margin-bottom:22px;">Repository &amp; output</div>
        <div class="settings-card">
          <label class="field-label">Repo path</label>
          <div class="settings-path-value"><span>${esc(s.repoPath || "")}</span><button class="btn btn-ghost" id="pick-repo" style="padding:4px 10px;font-size:11px;">Change…</button></div>
          <label class="field-label">Image directory (derived)</label>
          <div class="settings-path-value">${esc(s.publicDir || "")}</div>
          <label class="field-label">Content file (derived)</label>
          <div class="settings-path-value" style="margin-bottom:0;">${esc(s.contentFile || "")}</div>
        </div>
        <div class="settings-card mono" style="color:#7a7385;font-size:12px;line-height:1.6;">
          Output format is fixed: webp q82 for everything except logo-mark, which
          is PNG (its path is hardcoded with a .png extension). No slider — this
          matches SPEC.md §4.4.
        </div>
      </div>
    </div>
  `;
}

// ---- events ----

function bindScreenEvents(d) {
  dom.app.querySelectorAll("[data-nav]").forEach((el) => {
    el.onclick = () => { state.screen = el.dataset.nav; state.deleteConfirmKey = null; render(); };
  });
  dom.app.querySelectorAll("[data-filter]").forEach((el) => {
    el.onclick = () => { state.screen = "library"; state.filter = el.dataset.filter; render(); };
  });

  if (state.screen === "library") bindLibraryEvents();
  else if (state.screen === "add") bindEditorEvents();
  else if (state.screen === "review") bindReviewEvents();
  else if (state.screen === "settings") bindSettingsEvents();
}

function bindLibraryEvents() {
  dom.app.querySelectorAll("[data-add-array]").forEach((el) => {
    el.onclick = () => openEditorForNew(el.dataset.addArray);
  });
  dom.app.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest("[data-ask-delete],[data-confirm-delete],[data-cancel-delete],[data-move],[data-undo-delete]")) return;
      openEditorForExisting(el.dataset.open, el.dataset.kind);
    };
  });
  dom.app.querySelectorAll("[data-ask-delete]").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); state.deleteConfirmKey = el.dataset.askDelete.replace("|", "::"); render(); };
  });
  dom.app.querySelectorAll("[data-cancel-delete]").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); state.deleteConfirmKey = null; render(); };
  });
  dom.app.querySelectorAll("[data-confirm-delete]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const [varName, id] = el.dataset.confirmDelete.split("|");
      const sectionKey = SECTION_ORDER.find((k) => (state.scanResult.sections[k] || []).some((it) => it.id === id));
      await window.catalog.queueAdd({ kind: "array-delete", section: sectionKey, varName, id });
      state.deleteConfirmKey = null;
      await refreshQueue();
      render();
    };
  });
  dom.app.querySelectorAll("[data-undo-delete]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const [varName, id] = el.dataset.undoDelete.split("|");
      const target = state.queueList.find((x) => x.op === "DELETE" && x.path === `${varName}[${id}]`);
      if (target) await window.catalog.queueRemove(target.key);
      await refreshQueue();
      render();
    };
  });
  dom.app.querySelectorAll("[data-move]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const [varName, id, dirStr] = el.dataset.move.split("|");
      const dir = parseInt(dirStr, 10);
      const sectionKey = SECTION_ORDER.find((k) => (state.scanResult.sections[k] || []).some((it) => it.id === id));
      const items = (state.scanResult.sections[sectionKey] || []).filter((it) => it.list);
      const naturalIds = items.map((it) => it.id);
      const current = effectiveOrder(varName, naturalIds).filter((x) => !isQueuedForDelete(varName, x));
      const i = current.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= current.length) return;
      const next = current.slice();
      [next[i], next[j]] = [next[j], next[i]];
      await window.catalog.queueAdd({ kind: "array-reorder", section: sectionKey, varName, orderedIds: next });
      await refreshQueue();
      render();
    };
  });
}

let dragState = null;

const DROPPABLE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

function applyPickedSource(picked) {
  const e = state.editor;
  if (!picked) return;
  e.sourcePath = picked.sourcePath;
  e.sourceW = picked.width;
  e.sourceH = picked.height;
  e.sourceBytes = picked.bytes;
  e.pan = { x: 0, y: 0 };
  e.zoom = 100;
  render();
}

async function pickSourceViaDialog() {
  const picked = await window.catalog.pickImage();
  applyPickedSource(picked);
}

async function pickSourceViaDrop(dataTransfer) {
  const file = dataTransfer.files && dataTransfer.files[0];
  if (!file) return;
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!DROPPABLE_EXTENSIONS.includes(ext)) {
    alert(`Can't use "${file.name}" — drop a PNG, JPG, or WEBP image.`);
    return;
  }
  const sourcePath = window.catalog.getPathForFile(file);
  if (sourcePath) {
    const picked = await window.catalog.imageInfo(sourcePath);
    applyPickedSource(picked);
    return;
  }
  // No real filesystem path (common for images dragged straight out of a
  // browser tab) — fall back to sending the raw bytes over instead.
  const buffer = await file.arrayBuffer();
  const picked = await window.catalog.importImageBuffer(file.name, buffer);
  applyPickedSource(picked);
}

function bindDropTarget(el) {
  if (!el) return;
  el.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (ev) => {
    ev.preventDefault();
    el.classList.remove("drag-over");
    pickSourceViaDrop(ev.dataTransfer);
  });
}

function bindEditorEvents() {
  const e = state.editor;

  const pickSourceEl = dom.app.querySelector("#pick-source");
  if (pickSourceEl) pickSourceEl.onclick = pickSourceViaDialog;
  bindDropTarget(pickSourceEl);

  const stageDropzoneEl = dom.app.querySelector("#stage-dropzone");
  if (stageDropzoneEl) stageDropzoneEl.onclick = pickSourceViaDialog;

  const stage = dom.app.querySelector("#crop-stage");
  bindDropTarget(stage);
  if (stage && e.sourcePath) {
    stage.addEventListener("mousedown", (ev) => {
      ev.preventDefault(); // stop the browser's native image-drag from hijacking the pan gesture
      dragState = { startX: ev.clientX, startY: ev.clientY, ox: e.pan.x, oy: e.pan.y };
      window.addEventListener("mousemove", onCropDrag);
      window.addEventListener("mouseup", onCropDragEnd);
    });
  }

  const zoomSlider = dom.app.querySelector("#zoom-slider");
  if (zoomSlider) zoomSlider.oninput = (ev) => {
    e.zoom = +ev.target.value;
    clampPan(e);
    updateCropTransformOnly();
  };

  const resetBtn = dom.app.querySelector("#reset-crop");
  if (resetBtn) resetBtn.onclick = () => { e.pan = { x: 0, y: 0 }; e.zoom = 100; render(); };

  const altInput = dom.app.querySelector("#alt-input");
  if (altInput) altInput.oninput = (ev) => { e.altText = ev.target.value; };

  const mediaLabelInput = dom.app.querySelector("#media-label");
  if (mediaLabelInput) mediaLabelInput.oninput = (ev) => { e.mediaLabel = ev.target.value; };

  const lifeTitleInput = dom.app.querySelector("#life-title");
  if (lifeTitleInput) lifeTitleInput.oninput = (ev) => { e.title = ev.target.value; };

  const lifeHeightInput = dom.app.querySelector("#life-height");
  if (lifeHeightInput) lifeHeightInput.oninput = async (ev) => {
    e.lifeHeight = +ev.target.value;
    await refreshEditorTarget();
    clampPan(e);
    render();
  };

  dom.app.querySelectorAll("[data-set-tag]").forEach((el) => {
    el.onclick = () => { e.tag = el.dataset.setTag; render(); };
  });
  dom.app.querySelectorAll("[data-set-span]").forEach((el) => {
    el.onclick = async () => { e.span = el.dataset.setSpan; await refreshEditorTarget(); clampPan(e); render(); };
  });
  dom.app.querySelectorAll("[data-set-tilt]").forEach((el) => {
    el.onclick = () => { e.tilt = el.dataset.setTilt; render(); };
  });

  const queueBtn = dom.app.querySelector("#queue-btn");
  if (queueBtn) queueBtn.onclick = () => queueEditorChange();
}

function onCropDrag(ev) {
  if (!dragState) return;
  const e = state.editor;
  e.pan.x = dragState.ox + (ev.clientX - dragState.startX);
  e.pan.y = dragState.oy + (ev.clientY - dragState.startY);
  clampPan(e);
  updateCropTransformOnly();
}

function onCropDragEnd() {
  dragState = null;
  window.removeEventListener("mousemove", onCropDrag);
  window.removeEventListener("mouseup", onCropDragEnd);
}

function updateCropTransformOnly() {
  const e = state.editor;
  const img = dom.app.querySelector("#crop-img");
  if (!img) return;
  const frame = frameSizeFor(e.target);
  const baseFit = Math.max(frame.w / e.sourceW, frame.h / e.sourceH);
  const scale = baseFit * (e.zoom / 100);
  img.style.width = Math.round(e.sourceW * scale) + "px";
  img.style.height = Math.round(e.sourceH * scale) + "px";
  img.style.transform = `translate(-50%,-50%) translate(${e.pan.x}px,${e.pan.y}px)`;
  const zoomLabel = dom.app.querySelector("#zoom-label");
  if (zoomLabel) zoomLabel.textContent = e.zoom + "%";
}

async function queueEditorChange() {
  const e = state.editor;
  if (!e.sourcePath) return;
  state.busy = true;
  const cropRect = computeCropRect(e);

  if (e.mode === "fixed") {
    await window.catalog.queueAdd({
      kind: "fixed-replace", section: e.section, file: e.file, newAlt: e.altText,
      wrapperAttr: e.wrapperAttr, labelProp: e.labelProp,
      sourcePath: e.sourcePath, cropRect, target: e.target, format: e.format,
    });
  } else if (e.action === "new") {
    const outFilename = `${e.id}.webp`;
    const fields = buildFields(e, e.id, `/${outFilename}`);
    await window.catalog.queueAdd({
      kind: "array-new", section: e.section, varName: e.varName, id: e.id, fields, outFilename,
      sourcePath: e.sourcePath, cropRect, target: e.target, format: "webp",
    });
  } else {
    const patch = buildPatch(e);
    await window.catalog.queueAdd({
      kind: "array-replace", section: e.section, varName: e.varName, id: e.id, patch, outFilename: e.existingFile,
      sourcePath: e.sourcePath, cropRect, target: e.target, format: "webp",
    });
  }

  state.busy = false;
  state.editor = null;
  state.screen = "review";
  state.applyResult = null;
  await refreshQueue();
  render();
}

function buildFields(e, id, image) {
  if (e.kind === "life") return { id, tag: e.tag, title: e.title, height: e.lifeHeight, mediaLabel: e.mediaLabel, image };
  if (e.kind === "art") return { id, mediaLabel: e.mediaLabel, span: e.span, tilt: e.tilt, image };
  return { id, mediaLabel: e.mediaLabel, image };
}

function buildPatch(e) {
  if (e.kind === "life") return { tag: e.tag, title: e.title, height: e.lifeHeight, mediaLabel: e.mediaLabel };
  if (e.kind === "art") return { mediaLabel: e.mediaLabel, span: e.span, tilt: e.tilt };
  return { mediaLabel: e.mediaLabel };
}

function bindReviewEvents() {
  dom.app.querySelectorAll("[data-drop-queue]").forEach((el) => {
    el.onclick = async () => { await window.catalog.queueRemove(el.dataset.dropQueue); await refreshQueue(); render(); };
  });
  const discardBtn = dom.app.querySelector("#discard-all");
  if (discardBtn) discardBtn.onclick = async () => { await window.catalog.queueDiscardAll(); await refreshQueue(); state.applyResult = null; render(); };
  const applyBtn = dom.app.querySelector("#apply-btn");
  if (applyBtn) applyBtn.onclick = async () => {
    state.busy = true; render();
    const result = await window.catalog.queueApply();
    state.applyResult = result;
    state.busy = false;
    await refreshScan();
    await refreshQueue();
    render();
  };

  if (state.queueList.length) {
    window.catalog.queueDiff().then((files) => {
      const target = dom.app.querySelector("#diff-target");
      if (target) target.innerHTML = `<div class="label" style="margin-bottom:10px;">Content file changes</div>${renderDiffFiles(files)}`;
    });
  }
}

function bindSettingsEvents() {
  const pickBtn = dom.app.querySelector("#pick-repo");
  if (pickBtn) pickBtn.onclick = async () => {
    const s = await window.catalog.pickRepoFolder();
    if (s) { state.settings = s; await refreshScan(); await refreshQueue(); render(); }
  };
}

loadAll();
