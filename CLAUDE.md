# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm start        # launch the Electron app in dev mode (no packaged installer exists)
npm run smoke     # headless end-to-end regression test (see below)
```

There is no separate lint/test framework — `npm run smoke` (`scripts/smoke.js`) is the only automated check. It requires a local checkout of the hakumaguro.dev repo (located as described in **Locating the target repo** below). It writes a real test entry into that repo's `site.ts`, verifies with the repo's own `tsc --noEmit`, then deletes the entry and asserts the file is byte-identical to a snapshot taken before the write.

**A dirty target tree is fine.** It reverts via `deleteArrayEntry` (an AST-level undo of its own append), never `git checkout`, so uncommitted work is never discarded; step 3 encodes to an in-memory Buffer and writes no images. Comparing against a snapshot rather than `git diff` is also strictly stronger — with `core.autocrlf` on, a git-level diff can normalize away a line-ending regression that the byte comparison catches.

To run a single piece of it manually, `require` the relevant module (`scan`, `pipeline`, `writer`) from a Node REPL against the same target repo path.

## Locating the target repo

The target repo path is machine-specific, so **nothing hardcodes it** — `src/main/settings.js` owns resolution for both the app and the `scripts/` helpers. A folder only counts as a checkout if all of `REPO_MARKERS` exist in it (`src/lib/site.ts`, `src/app/page.tsx`, `src/ds/LogoMark.tsx`, `public/`); `validateRepo()` returns which markers are missing so the UI can explain a rejection rather than just refusing.

`resolveRepoPath()` (app launch, `main.js`) tries, in order:

1. `HAKUMAGURO_REPO` if set — and if that path is invalid it **stops there** rather than falling through to detection, since silently using a different repo than the one named would be worse. Not persisted; it's a per-launch override.
2. the saved `settings.json` path, if it still validates
3. `autoDetectRepo()` — each name in `CANDIDATE_NAMES` under every ancestor of the app folder, up to 3 levels; a hit is persisted so detection only happens once per machine
4. nothing → `ok: false`, and the renderer shows the repo-picker gate

`resolveRepoPathForScripts()` is the headless equivalent for `scripts/` (no Electron userData to read): env var, else auto-detection, else it throws an actionable message.

**The gate**: when `settings:get` returns `ok: false`, `render()` in the renderer short-circuits to `renderSetup()` — the whole window, no sidebar or nav, since every other screen reads the target repo. Its copy varies by `reason`/`source` (never configured vs. saved-path-moved vs. picked-a-wrong-folder vs. bad env var). `settings:pickRepoFolder` validates before adopting and **rejects** an invalid pick without saving or making it current, so a mis-click can't strand the app; the rejected path comes back with its `missing` markers for display. Repo-touching IPC handlers all go through `requireRepo()`, which throws a readable error rather than letting a null path surface as an ENOENT deep inside ts-morph or sharp.

## Architecture

This is an Electron tool with **no external target-repo coupling except a filesystem path** — it reads and writes another project (hakumaguro.dev) on disk, not itself. Understanding it requires knowing the shape of that target repo:

- hakumaguro.dev has **21 known image slots**: 4 "fixed" slots bound into `page.tsx`/`LogoMark.tsx` by hardcoded `<Image src>` paths (never added/removed/reordered, only replaced in place), plus 3 arrays in `src/lib/site.ts` (`artPieces`, `vrClips`, `lifeSource`) whose entries this tool can append/replace/delete/reorder.
- The full slot registry — target pixel sizes (`@2x`), which array each belongs to, JSX prop names that must stay in sync with `alt` text — is **hardcoded** in `src/main/slots.js`, not introspected from the target repo's TypeScript types. If hakumaguro.dev's slot shapes change, `slots.js` must be updated by hand.

**Main-process module chain** (`src/main/`), each doing one job in the pipeline:
- `slots.js` — static slot/target-size registry (source of truth for "what exists and what size should it be")
- `siteAst.js` — `ts-morph` readers for `site.ts` arrays and `page.tsx` fixed slots
- `scan.js` — walks the target repo, cross-references against `slots.js`, flags aspect/resolution problems and orphaned files
- `pipeline.js` — `sharp`-based crop + resize + encode (webp/png)
- `writer.js` — `ts-morph` mutations (append/update/delete/reorder array entries, update fixed-slot JSX) plus **preview variants** (`previewArrayOps`, `previewFixedSlotOps`) that run the same mutation logic against an in-memory `ts-morph` source file without calling `saveSync`, so the Review screen's diff is provably identical to what Apply will actually write. Every real write is followed by running the target repo's own `tsc --noEmit` via `verifyTypecheck`. Saves always do a whole-file `sf.formatText({ indentSize: 2 })` before writing — `ts-morph`'s `removeElement()` re-indents untouched sibling elements as a side effect, and this is required to keep `site.ts` diffs byte-clean.
- `queue.js` — the pending-change queue (`Queue` class). Image conversion happens **at queue-add time**, not at apply time — Buffers sit in memory until `apply()`. `apply()` writes all queued images first, then replays content-file mutations in queue order; this is intentionally not atomic across the two (a mid-apply failure leaves an orphan image, which `scan()` already detects and reports on next launch).
- `settings.js` — persists `{ repoPath }` to Electron's userData directory (outside this repo) and owns repo location/validation for the whole app (see **Locating the target repo**); `publicDir` and `contentFile` are always derived from `repoPath`, never independently configurable, even though earlier mockups showed them as separate fields.

**IPC boundary**: `main.js` registers `ipcMain.handle` channels; `preload.js` exposes a matching `window.catalog.*` surface via `contextBridge` (context isolation on, node integration off). The renderer (`src/renderer/`, plain HTML/CSS/JS, no framework) only ever talks to the main process through that bridge.

**Data flow for a typical add/replace**: renderer picks a source image (`dialog:pickImage`) → computes a target box (`catalog:targetFor`, using `slots.js` rules) → computes a centered crop rect (`catalog:centeredCropRect`) → user adjusts pan/zoom → `queue:add` runs `pipeline.processImage` immediately and stores the resulting Buffer in the in-memory queue → Review screen calls `queue:diff`, which uses `writer.js`'s preview functions to compute an exact before/after diff without touching disk → `queue:apply` writes images, replays `site.ts`/`page.tsx` mutations, runs `tsc --noEmit`, and clears the queue.

## Deliberate scope cuts (not oversights)

- Crop UI always matches the target box's exact aspect ratio — no freeform/8-handle resize, to avoid distortion by construction.
- Settings only exposes `repoPath`; image directory and content file are shown read-only, derived from it.
- No packaged installer/icon — `npm start` in dev mode is the intended v1 UX.
