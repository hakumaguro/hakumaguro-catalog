// Pending-change queue — SPEC.md §4.2/§4.3/§8. Holds queued image Buffers +
// content-file mutations in main-process memory only; nothing touches disk
// until apply(). Convert-on-queue already happened by the time an item is
// added here (the ipc handler runs pipeline.processImage before calling add).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  appendArrayEntry,
  updateArrayEntry,
  deleteArrayEntry,
  reorderArray,
  updateFixedPageSlot,
  previewArrayOps,
  previewFixedSlotOps,
  verifyTypecheck,
} = require("./writer");
const { siteTsPath, pageTsxPath } = require("./siteAst");
const { diffSummary } = require("./diffText");

function fmtBytes(n) {
  if (n == null) return "—";
  return n >= 1024 * 1024 ? (n / (1024 * 1024)).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
}

class Queue {
  constructor() {
    this.items = [];
  }

  add(item) {
    const key = crypto.randomUUID();
    this.items.push({ key, ...item });
    return key;
  }

  remove(key) {
    this.items = this.items.filter((i) => i.key !== key);
  }

  clear() {
    this.items = [];
  }

  /** Safe-for-renderer summaries — no Buffers. */
  list() {
    return this.items.map((it) => ({
      key: it.key,
      op: it.op,
      section: it.section,
      path: it.outFilename ? `public/${it.outFilename}` : it.contentDescription,
      transform: it.transform,
      sizes: it.buffer
        ? `${fmtBytes(it.sourceBytes)} → ${fmtBytes(it.buffer.length)}`
        : "",
      previewDataUrl: it.previewDataUrl || null,
    }));
  }

  /** Grouped ops for previewArrayOps, in queue order, per varName. */
  _arrayOpsByVarName() {
    const grouped = {};
    for (const it of this.items) {
      if (!it.varName) continue;
      if (!grouped[it.varName]) grouped[it.varName] = [];
      if (it.op === "NEW") grouped[it.varName].push({ type: "append", fields: it.fields });
      else if (it.op === "REPLACE") grouped[it.varName].push({ type: "update", id: it.id, patch: it.patch });
      else if (it.op === "DELETE") grouped[it.varName].push({ type: "delete", id: it.id });
      else if (it.op === "REORDER") grouped[it.varName].push({ type: "reorder", orderedIds: it.orderedIds });
    }
    return grouped;
  }

  _fixedOps() {
    return this.items
      .filter((it) => it.op === "REPLACE" && it.wrapperAttr)
      .map((it) => ({
        oldSrc: `/${it.file}`,
        newSrc: `/${it.file}`,
        newAlt: it.newAlt,
        wrapperAttr: it.wrapperAttr,
        labelProp: it.labelProp,
      }));
  }

  /** Real diff of what apply() will write, computed without touching disk. */
  diff(repoPath) {
    const files = [];
    const arrayOps = this._arrayOpsByVarName();
    for (const [varName, ops] of Object.entries(arrayOps)) {
      if (ops.length === 0) continue;
      const { before, after } = previewArrayOps(repoPath, varName, ops);
      const { rows, additions, deletions } = diffSummary(before, after);
      files.push({ file: "src/lib/site.ts", varName, rows, additions, deletions });
    }
    const fixedOps = this._fixedOps();
    if (fixedOps.length > 0) {
      const { before, after } = previewFixedSlotOps(repoPath, fixedOps);
      const { rows, additions, deletions } = diffSummary(before, after);
      files.push({ file: "src/app/page.tsx", rows, additions, deletions });
    }
    return files;
  }

  /**
   * Writes every queued image first, then replays content-file mutations in
   * queue order (SPEC §8 — not atomic across the two, images land first so a
   * mid-way content-write failure only leaves an orphan, which scan() already
   * detects). Runs the repo's own tsc --noEmit once at the end.
   */
  async apply(repoPath) {
    const publicDir = path.join(repoPath, "public");
    const written = [];

    for (const it of this.items) {
      if (it.buffer && it.outFilename) {
        fs.writeFileSync(path.join(publicDir, it.outFilename), it.buffer);
        written.push(it.outFilename);
      }
    }

    for (const it of this.items) {
      if (it.op === "NEW" && it.varName) {
        appendArrayEntry(repoPath, it.varName, it.fields);
      } else if (it.op === "REPLACE" && it.varName) {
        updateArrayEntry(repoPath, it.varName, it.id, it.patch);
      } else if (it.op === "DELETE" && it.varName) {
        deleteArrayEntry(repoPath, it.varName, it.id);
      } else if (it.op === "REORDER" && it.varName) {
        reorderArray(repoPath, it.varName, it.orderedIds);
      } else if (it.op === "REPLACE" && it.wrapperAttr) {
        updateFixedPageSlot(repoPath, {
          oldSrc: `/${it.file}`,
          newSrc: `/${it.file}`,
          newAlt: it.newAlt,
          wrapperAttr: it.wrapperAttr,
          labelProp: it.labelProp,
        });
      }
    }

    const tsc = await verifyTypecheck(repoPath);
    this.clear();
    return { written, tsc };
  }
}

module.exports = { Queue };
