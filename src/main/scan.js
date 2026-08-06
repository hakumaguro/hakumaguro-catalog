// Catalog scanner — SPEC.md §2/§7. Scans public/ + parses site.ts/page.tsx to
// build the current state of all 21 known slots, and flags what doesn't match
// (orphan files, missing-file bindings, wrong size/aspect/weight).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const { readArrays, readFixedPageSlots } = require("./siteAst");
const { FIXED_SLOTS, ARRAY_CONFIGS } = require("./slots");

const BYTES_HEAVY_THRESHOLD = 300 * 1024; // flag anything heavier than this outright
const OVERSIZE_FACTOR = 2.5; // actual px more than this many times the target = "oversized"
const UNDERSIZE_FACTOR = 0.9; // actual px less than this fraction of target = "undersized"
const ASPECT_TOLERANCE = 0.1; // relative tolerance before flagging a locked-aspect mismatch

async function fileInfo(publicDir, filename) {
  const full = path.join(publicDir, filename);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  const meta = await sharp(full).metadata();
  return { filename, path: full, bytes: stat.size, width: meta.width, height: meta.height };
}

function warningsFor(info, target, format) {
  if (!info) return null;
  const warnings = [];

  if (target.aspect) {
    const actual = info.width / info.height;
    if (Math.abs(actual - target.aspect) / target.aspect > ASPECT_TOLERANCE) {
      warnings.push({
        tag: "aspect",
        text: `บังคับ aspect ${target.aspect.toFixed(3)} แต่ไฟล์จริงเป็น ${actual.toFixed(3)} — object-cover จะครอปมากกว่าที่ตั้งใจ`,
      });
    }
  }

  if (info.width < target.w * UNDERSIZE_FACTOR || info.height < target.h * UNDERSIZE_FACTOR) {
    warnings.push({
      tag: "low res",
      text: `ต้องการอย่างน้อย ${target.w}×${target.h} แต่ไฟล์จริง ${info.width}×${info.height}`,
    });
  }

  if (info.width > target.w * OVERSIZE_FACTOR || info.height > target.h * OVERSIZE_FACTOR) {
    warnings.push({
      tag: "oversized",
      text: `ใหญ่กว่าที่ต้องการมาก (เป้าหมาย ${target.w}×${target.h}, จริง ${info.width}×${info.height})`,
    });
  }

  if (info.bytes > BYTES_HEAVY_THRESHOLD) {
    warnings.push({
      tag: "file size",
      text: `หนัก ${(info.bytes / 1024).toFixed(0)} KB — น่าจะบีบอัดได้มากกว่านี้`,
    });
  }

  const actualFormat = path.extname(info.filename).slice(1);
  if (format && actualFormat !== format) {
    warnings.push({ tag: "format", text: `ควรเป็น .${format} แต่ไฟล์จริงเป็น .${actualFormat}` });
  }

  return warnings.length ? warnings : null;
}

async function scan(repoPath) {
  const publicDir = path.join(repoPath, "public");
  const arrays = readArrays(repoPath);
  const fixedPageSlots = readFixedPageSlots(repoPath);
  const pageSlotBySrc = new Map(fixedPageSlots.map((s) => [s.src, s]));

  const knownFilenames = new Set();
  const sections = {};
  const addItem = (sectionKey, item) => {
    if (!sections[sectionKey]) sections[sectionKey] = [];
    sections[sectionKey].push(item);
  };

  // --- fixed slots (hero/vrc-portrait/contact-avatar/logo-mark) ---
  for (const slot of FIXED_SLOTS) {
    knownFilenames.add(slot.file);
    const info = await fileInfo(publicDir, slot.file);
    const pageSlot = pageSlotBySrc.get("/" + slot.file);
    addItem(slot.section, {
      id: slot.id,
      file: slot.file,
      kind: "plain",
      list: false,
      missing: !info,
      alt: pageSlot ? pageSlot.alt : slot.id === "logo-mark" ? "hakumaguro.dev logo" : undefined,
      width: info && info.width,
      height: info && info.height,
      bytes: info && info.bytes,
      warnings: warningsFor(info, slot.target, slot.format),
    });
  }

  // --- array-backed slots (art/vr-clip/life) ---
  const arrayByConfigKey = { art: arrays.artPieces, vrClip: arrays.vrClips, life: arrays.lifeSource };
  for (const [key, config] of Object.entries(ARRAY_CONFIGS)) {
    const entries = arrayByConfigKey[key] || [];
    entries.forEach((entry, index) => {
      const filename = (entry.image || "").replace(/^\//, "");
      if (filename) knownFilenames.add(filename);
      const target = config.targetFor(entry);
      addItem(config.section, {
        id: entry.id,
        file: filename,
        kind: config.kind,
        list: true,
        index,
        missing: filename ? !fs.existsSync(path.join(publicDir, filename)) : true,
        mediaLabel: entry.mediaLabel,
        title: entry.title,
        tag: entry.tag,
        span: entry.span,
        tilt: entry.tilt,
        lifeHeight: entry.height,
        warnings: null, // filled below once we have file info
        _target: target,
        _format: config.format,
      });
    });
  }

  // fill in warnings for array-backed slots (needs an async fileInfo call)
  for (const section of Object.values(sections)) {
    for (const item of section) {
      if (!item.list) continue;
      const info = item.file ? await fileInfo(publicDir, item.file) : null;
      item.width = info && info.width;
      item.height = info && info.height;
      item.bytes = info && info.bytes;
      item.warnings = warningsFor(info, item._target, item._format);
      delete item._target;
      delete item._format;
    }
  }

  // --- orphans: files in public/ that no slot claims ---
  const allFiles = fs.existsSync(publicDir) ? fs.readdirSync(publicDir) : [];
  const orphans = allFiles.filter(
    (f) => /\.(webp|png|jpe?g)$/i.test(f) && !knownFilenames.has(f),
  );

  const totalSlots = Object.values(sections).reduce((n, s) => n + s.length, 0);
  const emptySlots = Object.values(sections).reduce(
    (n, s) => n + s.filter((i) => i.missing).length,
    0,
  );

  return {
    sections,
    orphans,
    stats: { total: totalSlots, set: totalSlots - emptySlots, empty: emptySlots },
  };
}

module.exports = { scan };
