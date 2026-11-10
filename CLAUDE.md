# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm start                          # launch the Electron app in dev mode (no packaged installer exists)
npm run smoke                      # scan → convert → write → verify, end to end
node scripts/check-writer-full.js  # every write path in writer.js, one by one
```

There is no lint or test framework. The two scripts above are the automated checks, and both run against a real checkout of the hakumaguro.dev repo:

- They take its path from the `HAKUMAGURO_REPO` environment variable and fall back to the path hardcoded in the scripts and in `src/main/settings.js` (`DEFAULT_REPO_PATH`). That fallback belongs to the owner's other machine; leave it as it is and set the variable here.
- They need a **clean working tree** in that repo, because they write into its `site.ts` / `page.tsx`, run its own `tsc --noEmit`, and then restore the files. `check-writer-full.js` refuses to run on a dirty tree; `smoke.js` asserts `git diff` is empty when it finishes.
- `scripts/check-scan.js` and `scripts/check-pipeline.js` are read-only helpers for one module each.

To exercise a single module by hand, `require` it (`scan`, `pipeline`, `writer`) from a Node REPL against the same repo path. `writer.previewArrayOps` and `writer.previewFixedSlotOps` return before/after text without saving, so they are safe for trying a mutation.

To look at the real window without touching the owner's saved settings, launch Electron with `--user-data-dir=<temp folder>` holding a `settings.json` of `{ "repoPath": "…" }` (Playwright's `_electron.launch` can drive it).

## When hakumaguro.dev changes

This tool hardcodes the site's shapes, so a site change can break it without any change here. After the site's array names, entry fields, fixed image slots or display sizes change:

1. Run the scan against the site. A renamed array fails at once (`site.ts: variable "…" not found`).
2. Update `src/main/slots.js` (variable names, fixed slots with their `wrapperAttr` / `labelProp`, `@2x` target sizes, `KNOWN_NON_SLOT_FILES`), then the renderer's `ARRAY_META` / `SECTION_META` / `SECTION_ORDER` in `src/renderer/app.js`, which mirror it for display.
3. Update the expected slot total in `scripts/smoke.js`.
4. Run both check scripts, then launch the app and open one array item and one fixed slot.

Done means the scan reports every slot with none missing, both scripts pass, and the site repo is clean afterwards.

## Architecture

This is an Electron tool with **no external target-repo coupling except a filesystem path**: it reads and writes another project (hakumaguro.dev) on disk, not itself. Understanding it requires knowing the shape of that target repo:

- hakumaguro.dev has **known image slots** (36 at the time of writing): 5 "fixed" slots (hero key visual, about portrait, shinano, contact avatar, logo mark) bound into `page.tsx` / `LogoMark.tsx` by hardcoded `<Image src>` paths (never added, removed or reordered, only replaced in place), plus 3 arrays in `src/lib/site.ts` (`artPieces`, `vrClips`, `lifeItems`, all exported array literals) whose entries this tool can append, replace, delete and reorder. `ArtPiece` has only an optional `span`.
- **Array order is layout on the site.** `artPieces` is ordered so spans add up to whole rows of the 4-column grid, and `lifeItems` is ordered to balance the four desktop masonry columns. A reorder or a span change can open a hole in the art grid.
- The slot registry (target pixel sizes at `@2x`, which array each slot belongs to, the JSX prop names that carry the `alt` text) is **hardcoded** in `src/main/slots.js`, not read from the site's TypeScript types. `slots.js` is the single source for target sizes: `main.js` answers `catalog:targetFor` from it, so the crop box the editor draws is the box `scan()` measures against.

**Main-process module chain** (`src/main/`), each doing one job in the pipeline:

- `slots.js`: the static slot and target-size registry.
- `siteAst.js`: `ts-morph` readers for the `site.ts` arrays and the `page.tsx` fixed slots.
- `scan.js`: walks the target repo, cross-references it against `slots.js`, and flags aspect and resolution problems and orphaned files.
- `pipeline.js`: `sharp`-based crop, resize and encode (webp/png).
- `writer.js`: `ts-morph` mutations (append, update, delete and reorder array entries; update fixed-slot JSX) plus **preview variants** (`previewArrayOps`, `previewFixedSlotOps`) that run against an in-memory source file without `saveSync`. The real write and its preview share one function per mutation (`applyPatch`, `applyFixedSlotOp`), which is what makes the Review diff identical to what Apply writes; keep new mutation logic in a shared function for the same reason. Every real write is followed by the target repo's own `tsc --noEmit` via `verifyTypecheck`. Saves always run a whole-file `sf.formatText({ indentSize: 2 })` first: `ts-morph`'s `removeElement()` re-indents untouched siblings, and the format pass is what keeps `site.ts` diffs byte-clean.
- `queue.js`: the pending-change queue (`Queue`). Image conversion happens **at queue-add time**, so Buffers sit in memory until `apply()`. `apply()` writes all queued images first, then replays content-file mutations in queue order. It is deliberately not atomic across the two: a mid-apply failure leaves an orphan image, which `scan()` reports on the next launch.
- `settings.js`: persists `{ repoPath }` to Electron's userData directory, outside this repo. `publicDir` and `contentFile` are always derived from `repoPath`.

**Contracts that are easy to break:**

- **`Queue.list()` is the renderer's only view of the queue.** The Library reads `varName`, `id`, `orderedIds` and `file` from it to hide an entry queued for deletion, mark a queued change, and build the next move on top of a pending reorder. A field the renderer reads has to be in that summary.
- **A reorder is a full target order.** `Queue.add` keeps only the newest reorder per array, and the renderer builds each move from the pending one.
- **In a patch, `null` or `undefined` means "the entry should not have this field".** `applyPatch` removes it from an existing entry and `formatObjectLiteral` leaves it out of a new one. The renderer sends `null` (see `orNull`) so the intent survives IPC. This is how a Replace clears an art piece's `span`.
- **JSX attribute strings have no escapes.** `jsxAttrText` writes a value containing a double quote, an ampersand or a line break as an expression (`alt={"…"}`); `siteAst.readFixedPageSlots` reads both forms.
- **A fixed-slot replace copies the alt text onto the block's label prop**, even where the site's label is worded differently from its alt.

**IPC boundary**: `main.js` registers `ipcMain.handle` channels; `preload.js` exposes a matching `window.catalog.*` surface via `contextBridge` (context isolation on, node integration off). The renderer (`src/renderer/`, plain HTML/CSS/JS, no framework) talks to the main process only through that bridge.

**Data flow for a typical add or replace**: the renderer picks a source image (`dialog:pickImage`) → asks for a target box (`catalog:targetFor`) → computes a centered crop rect (`catalog:centeredCropRect`) → the user adjusts pan and zoom → `queue:add` runs `pipeline.processImage` immediately and stores the Buffer in the queue → the Review screen calls `queue:diff`, which uses the preview functions to compute the exact before/after diff without touching disk → `queue:apply` writes images, replays the `site.ts` / `page.tsx` mutations, runs `tsc --noEmit`, and clears the queue.

## Gotchas

- Working copies are CRLF (`core.autocrlf`). Keep an edited file's line endings as they are; a tool that rewrites them produces whole-file diffs.
- This repo may have no git identity configured on a given machine. Commit with the author its history already uses, passed for that commit, and leave git configuration alone.
- The scan flags a file as low-res when it is below the slot's `@2x` target. After a site layout change that enlarges a slot, existing images are flagged until they are re-exported; that is the tool working, not a bug.

## Deliberate scope cuts (not oversights)

- The crop UI always matches the target box's exact aspect ratio. There is no freeform or 8-handle resize, which rules out distortion by construction.
- Settings exposes only `repoPath`; the image directory and content file are shown read-only, derived from it.
- There is no packaged installer or icon. `npm start` in dev mode is the intended v1 UX.
