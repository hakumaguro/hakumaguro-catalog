// AST writer — SPEC.md §8. Edits site.ts / page.tsx with ts-morph, touching
// only the nodes that changed, then verifies with the REPO'S OWN `tsc --noEmit`
// (not this tool's TypeScript) so Next's types / next-env.d.ts resolve correctly.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { SyntaxKind } = require("ts-morph");

const { newProject, siteTsPath, pageTsxPath } = require("./siteAst");

// Applied to the whole file before every save. Needed because ts-morph's
// structural manipulations (removeElement especially) can leave neighboring,
// untouched elements re-indented relative to the source — verified: a plain
// append+delete round-trip on `lifeSource` left `life-8` re-indented by 2
// spaces until this was added. A whole-file LanguageService format pass
// converges everything back to the project's actual 2-space convention, and
// round-trips byte-clean once applied consistently.
const FORMAT_SETTINGS = { indentSize: 2, convertTabsToSpaces: true };

function escapeString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function fieldText(value) {
  if (typeof value === "number") return String(value);
  return `"${escapeString(value)}"`;
}

/**
 * Renders a plain object as a multi-line TS object-literal, in the given key
 * order. No base indent of its own — ts-morph positions the first line to
 * match sibling array elements when inserting, so baking in extra indent here
 * would double up (verified against a real append to hakumaguroDev/site.ts).
 */
function formatObjectLiteral(fields, indent = "") {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${indent}  ${k}: ${fieldText(v)},`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function getArrayLiteral(sf, varName) {
  const decl = sf.getVariableDeclaration(varName);
  if (!decl) throw new Error(`site.ts: variable "${varName}" not found`);
  const init = decl.getInitializerIfKind(SyntaxKind.ArrayLiteralExpression);
  if (!init) throw new Error(`site.ts: "${varName}" is not an array literal`);
  return init;
}

/**
 * ts-morph never adds a trailing comma after whatever ends up as the array's
 * last element (append/delete/reorder can all leave a different element
 * last) — but hakumaguroDev's site.ts consistently uses trailing commas.
 * Verified empirically against a real reorder round-trip that otherwise left
 * a spurious single-line diff. Call after any array mutation.
 */
function ensureTrailingComma(arrayLiteral) {
  const elements = arrayLiteral.getElements();
  if (elements.length === 0) return;
  const last = elements[elements.length - 1];
  const nextSibling = last.getNextSibling();
  const alreadyHasComma = nextSibling && nextSibling.getKind() === SyntaxKind.CommaToken;
  if (!alreadyHasComma) {
    last.replaceWithText(last.getText() + ",");
  }
}

function findElementById(arrayLiteral, id) {
  return arrayLiteral.getElements().find((el) => {
    if (el.getKind() !== SyntaxKind.ObjectLiteralExpression) return false;
    const idProp = el.getProperty("id");
    if (!idProp) return false;
    const init = idProp.getInitializer();
    return init && init.getKind() === SyntaxKind.StringLiteral && init.getLiteralText() === id;
  });
}

/** Appends a new entry to the end of an array in site.ts. `fields` key order is preserved. */
function appendArrayEntry(repoPath, varName, fields) {
  const project = newProject(siteTsPath(repoPath));
  const sf = project.addSourceFileAtPath(siteTsPath(repoPath));
  const arrayLiteral = getArrayLiteral(sf, varName);
  arrayLiteral.addElement(formatObjectLiteral(fields));
  ensureTrailingComma(arrayLiteral);
  sf.formatText(FORMAT_SETTINGS);
  sf.saveSync();
}

/** Patches specific fields on an existing entry (by id), leaving the rest untouched. */
function updateArrayEntry(repoPath, varName, id, patch) {
  const project = newProject(siteTsPath(repoPath));
  const sf = project.addSourceFileAtPath(siteTsPath(repoPath));
  const arrayLiteral = getArrayLiteral(sf, varName);
  const el = findElementById(arrayLiteral, id);
  if (!el) throw new Error(`site.ts: "${varName}" has no entry with id "${id}"`);

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = el.getProperty(key);
    if (existing) {
      existing.setInitializer(fieldText(value));
    } else {
      el.addPropertyAssignment({ name: key, initializer: fieldText(value) });
    }
  }
  sf.formatText(FORMAT_SETTINGS);
  sf.saveSync();
}

function deleteArrayEntry(repoPath, varName, id) {
  const project = newProject(siteTsPath(repoPath));
  const sf = project.addSourceFileAtPath(siteTsPath(repoPath));
  const arrayLiteral = getArrayLiteral(sf, varName);
  const el = findElementById(arrayLiteral, id);
  if (!el) throw new Error(`site.ts: "${varName}" has no entry with id "${id}"`);
  arrayLiteral.removeElement(el);
  ensureTrailingComma(arrayLiteral);
  sf.formatText(FORMAT_SETTINGS);
  sf.saveSync();
}

/** Reorders an array to match `orderedIds` exactly (ids not listed keep their relative order, appended last). */
function reorderArray(repoPath, varName, orderedIds) {
  const project = newProject(siteTsPath(repoPath));
  const sf = project.addSourceFileAtPath(siteTsPath(repoPath));
  const arrayLiteral = getArrayLiteral(sf, varName);

  const elements = arrayLiteral.getElements();
  const byId = new Map();
  for (const el of elements) {
    const idProp = el.getProperty("id");
    const init = idProp && idProp.getInitializer();
    const id = init && init.getKind() === SyntaxKind.StringLiteral ? init.getLiteralText() : null;
    byId.set(id, el.getText());
  }

  const seen = new Set();
  const texts = [];
  for (const id of orderedIds) {
    if (byId.has(id)) {
      texts.push(byId.get(id));
      seen.add(id);
    }
  }
  for (const [id, text] of byId) {
    if (!seen.has(id)) texts.push(text);
  }

  arrayLiteral.getElements().forEach((el) => arrayLiteral.removeElement(el));
  texts.forEach((text) => arrayLiteral.addElement(text));
  ensureTrailingComma(arrayLiteral);
  sf.formatText(FORMAT_SETTINGS);
  sf.saveSync();
}

/**
 * Replaces one of the 4 fixed slots in page.tsx: the <Image src=...> attribute,
 * its `alt`, and the sibling `portraitLabel`/`avatarLabel` prop on the parent
 * block component (kept in sync — see ticket 06). `wrapperAttr` is the JSX
 * attribute name holding the <Image> ("portrait" | "avatar"); `labelProp` is
 * the sibling attribute name that echoes the label ("portraitLabel" | "avatarLabel").
 */
function updateFixedPageSlot(repoPath, { oldSrc, newSrc, newAlt, wrapperAttr, labelProp }) {
  const project = newProject(pageTsxPath(repoPath));
  const sf = project.addSourceFileAtPath(pageTsxPath(repoPath));

  const images = sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  const target = images.find((img) => {
    if (img.getTagNameNode().getText() !== "Image") return false;
    const srcAttr = img.getAttribute("src");
    const init = srcAttr && srcAttr.getInitializer();
    return init && init.getKind() === SyntaxKind.StringLiteral && init.getLiteralText() === oldSrc;
  });
  if (!target) throw new Error(`page.tsx: no <Image src="${oldSrc}"> found`);

  target.getAttributeOrThrow("src").setInitializer(`"${escapeString(newSrc)}"`);
  target.getAttributeOrThrow("alt").setInitializer(`"${escapeString(newAlt)}"`);

  // Walk up to the JsxAttribute named `wrapperAttr` (e.g. portrait={<Image .../>}),
  // then its parent JsxOpeningElement/JsxSelfClosingElement carries the label prop.
  const wrapperJsxAttr = target
    .getAncestors()
    .find(
      (a) =>
        a.getKind() === SyntaxKind.JsxAttribute &&
        a.getNameNode().getText() === wrapperAttr,
    );
  if (!wrapperJsxAttr) {
    throw new Error(`page.tsx: <Image src="${oldSrc}"> is not inside a "${wrapperAttr}" prop`);
  }
  // JsxAttribute's parent is the JsxAttributes list, not the element itself
  // (and the element is a JsxOpeningElement when the block has children, e.g.
  // ContactBlock/VRChatBlock, or a JsxSelfClosingElement when it doesn't, e.g.
  // HeroBlock) — walk up to whichever ancestor kind actually matches.
  const blockElement =
    wrapperJsxAttr.getFirstAncestorByKind(SyntaxKind.JsxOpeningElement) ||
    wrapperJsxAttr.getFirstAncestorByKind(SyntaxKind.JsxSelfClosingElement);
  if (!blockElement) {
    throw new Error(`page.tsx: could not find the block element wrapping "${wrapperAttr}"`);
  }
  const labelAttr = blockElement.getAttribute(labelProp);
  if (!labelAttr) {
    throw new Error(`page.tsx: block element has no "${labelProp}" attribute`);
  }
  labelAttr.setInitializer(`"${escapeString(newAlt)}"`);

  sf.formatText(FORMAT_SETTINGS);
  sf.saveSync();
}

/** Runs the REPO'S OWN `tsc --noEmit` (not this tool's) so Next's types resolve. */
function verifyTypecheck(repoPath) {
  return new Promise((resolve) => {
    const tscPath = path.join(
      repoPath,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsc.cmd" : "tsc",
    );
    if (!fs.existsSync(tscPath)) {
      resolve({ ok: false, output: `tsc not found at ${tscPath}` });
      return;
    }
    // shell:true is required on Windows to spawn a .cmd file at all (verified:
    // without it, execFile throws EINVAL). The DEP0190 warning this triggers
    // only matters when args are attacker-influenced; ours is the fixed
    // literal "--noEmit", so it's inert here.
    execFile(tscPath, ["--noEmit"], { cwd: repoPath, shell: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: (stdout || "") + (stderr || "") });
      } else {
        resolve({ ok: true, output: "" });
      }
    });
  });
}

/**
 * Dry-run: applies a sequence of array ops to ONE in-memory sourceFile
 * (never saved to disk) and returns the before/after full text, for the
 * Review & Apply diff view. Mirrors the exact per-op logic of
 * append/update/delete/reorderArrayEntry above, just without opening a
 * fresh Project per op and without saveSync — so the diff shown is exactly
 * what applying the same ops for real (in the same order) will produce.
 */
function previewArrayOps(repoPath, varName, ops) {
  const project = newProject(siteTsPath(repoPath));
  const sf = project.addSourceFileAtPath(siteTsPath(repoPath));
  const before = sf.getFullText();
  const arrayLiteral = getArrayLiteral(sf, varName);

  for (const op of ops) {
    if (op.type === "append") {
      arrayLiteral.addElement(formatObjectLiteral(op.fields));
    } else if (op.type === "update") {
      const el = findElementById(arrayLiteral, op.id);
      if (!el) throw new Error(`site.ts: "${varName}" has no entry with id "${op.id}"`);
      for (const [key, value] of Object.entries(op.patch)) {
        if (value === undefined) continue;
        const existing = el.getProperty(key);
        if (existing) {
          existing.setInitializer(fieldText(value));
        } else {
          el.addPropertyAssignment({ name: key, initializer: fieldText(value) });
        }
      }
    } else if (op.type === "delete") {
      const el = findElementById(arrayLiteral, op.id);
      if (!el) throw new Error(`site.ts: "${varName}" has no entry with id "${op.id}"`);
      arrayLiteral.removeElement(el);
    } else if (op.type === "reorder") {
      const elements = arrayLiteral.getElements();
      const byId = new Map();
      for (const el of elements) {
        const idProp = el.getProperty("id");
        const init = idProp && idProp.getInitializer();
        const id = init && init.getKind() === SyntaxKind.StringLiteral ? init.getLiteralText() : null;
        byId.set(id, el.getText());
      }
      const seen = new Set();
      const texts = [];
      for (const id of op.orderedIds) {
        if (byId.has(id)) {
          texts.push(byId.get(id));
          seen.add(id);
        }
      }
      for (const [id, text] of byId) {
        if (!seen.has(id)) texts.push(text);
      }
      arrayLiteral.getElements().forEach((el) => arrayLiteral.removeElement(el));
      texts.forEach((text) => arrayLiteral.addElement(text));
    } else {
      throw new Error(`previewArrayOps: unknown op type "${op.type}"`);
    }
  }

  ensureTrailingComma(arrayLiteral);
  sf.formatText(FORMAT_SETTINGS);
  return { before, after: sf.getFullText() };
}

/** Dry-run counterpart of updateFixedPageSlot — same per-op logic, no save, batched over one sourceFile. */
function previewFixedSlotOps(repoPath, ops) {
  const project = newProject(pageTsxPath(repoPath));
  const sf = project.addSourceFileAtPath(pageTsxPath(repoPath));
  const before = sf.getFullText();

  for (const { oldSrc, newSrc, newAlt, wrapperAttr, labelProp } of ops) {
    const images = sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
    const target = images.find((img) => {
      if (img.getTagNameNode().getText() !== "Image") return false;
      const srcAttr = img.getAttribute("src");
      const init = srcAttr && srcAttr.getInitializer();
      return init && init.getKind() === SyntaxKind.StringLiteral && init.getLiteralText() === oldSrc;
    });
    if (!target) throw new Error(`page.tsx: no <Image src="${oldSrc}"> found`);

    target.getAttributeOrThrow("src").setInitializer(`"${escapeString(newSrc)}"`);
    target.getAttributeOrThrow("alt").setInitializer(`"${escapeString(newAlt)}"`);

    const wrapperJsxAttr = target
      .getAncestors()
      .find(
        (a) =>
          a.getKind() === SyntaxKind.JsxAttribute &&
          a.getNameNode().getText() === wrapperAttr,
      );
    if (!wrapperJsxAttr) {
      throw new Error(`page.tsx: <Image src="${oldSrc}"> is not inside a "${wrapperAttr}" prop`);
    }
    const blockElement =
      wrapperJsxAttr.getFirstAncestorByKind(SyntaxKind.JsxOpeningElement) ||
      wrapperJsxAttr.getFirstAncestorByKind(SyntaxKind.JsxSelfClosingElement);
    if (!blockElement) {
      throw new Error(`page.tsx: could not find the block element wrapping "${wrapperAttr}"`);
    }
    const labelAttr = blockElement.getAttribute(labelProp);
    if (!labelAttr) {
      throw new Error(`page.tsx: block element has no "${labelProp}" attribute`);
    }
    labelAttr.setInitializer(`"${escapeString(newAlt)}"`);
  }

  sf.formatText(FORMAT_SETTINGS);
  return { before, after: sf.getFullText() };
}

module.exports = {
  formatObjectLiteral,
  appendArrayEntry,
  updateArrayEntry,
  deleteArrayEntry,
  reorderArray,
  updateFixedPageSlot,
  verifyTypecheck,
  previewArrayOps,
  previewFixedSlotOps,
};
