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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Defense-in-depth against any other transient Windows file lock (e.g. an
// antivirus scan) — not the fix for the Chromium file:// thumbnail lock
// itself, which is handled by never opening output paths as file:// src's
// in the renderer (see catalog:thumbDataUrl in main.js).
async function renameWithRetry(tmpPath, destPath, attempts = 5, delayMs = 200) {
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.renameSync(tmpPath, destPath);
      return;
    } catch (err) {
      if (i === attempts) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
        throw err;
      }
      await sleep(delayMs);
    }
  }
}

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
   * Jump-to-change targets for the live preview, in queue order. `file` is the
   * image to scroll to and outline; ops with nothing to point at (a delete, a
   * reorder) carry `varName` instead so the caller can anchor on that array's
   * section — there is no element left to outline, and the thing being judged
   * is how the row closed up, not one image.
   */
  previewTargets() {
    return this.items.map((it) => ({
      key: it.key,
      op: it.op,
      section: it.section || null,
      file: it.outFilename || null,
      varName: it.varName || null,
      highlight: Boolean(it.outFilename),
    }));
  }

  /**
   * Writes every queued image first, then replays content-file mutations in
   * queue order (SPEC §8 — not atomic across the two, images land first so a
   * mid-way content-write failure only leaves an orphan, which scan() already
   * detects). Runs the repo's own tsc --noEmit once at the end.
   *
   * `verify: false` skips that typecheck and leaves the queue intact — the mode
   * the live preview uses when replaying the queue into its shadow copy. The
   * preview is a look, not a gate (a broken preview never blocks Apply), so
   * paying seconds of tsc on every preview would buy nothing Apply doesn't
   * already check for real.
   */
  async apply(repoPath, { verify = true } = {}) {
    const publicDir = path.join(repoPath, "public");
    const written = [];

    for (const it of this.items) {
      if (it.buffer && it.outFilename) {
        const destPath = path.join(publicDir, it.outFilename);
        const tmpPath = path.join(publicDir, `.tmp-${crypto.randomUUID()}-${it.outFilename}`);
        fs.writeFileSync(tmpPath, it.buffer);
        await renameWithRetry(tmpPath, destPath);
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

    if (!verify) return { written, tsc: null };

    const tsc = await verifyTypecheck(repoPath);
    this.clear();
    return { written, tsc };
  }
}

module.exports = { Queue };
