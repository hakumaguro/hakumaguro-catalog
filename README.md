# hakumaguro-catalog

Desktop image-catalog tool for [hakumaguro.dev](https://hakumaguro.dev) — pick, crop, convert, and bind images into the site's content files, without hand-editing `site.ts` or resizing images yourself.

An Electron app that manages the 21 image slots hakumaguro.dev's site currently uses (life photos, art pieces, logo mark, etc.), keeping the images on disk and the `site.ts` array/fixed-slot entries in sync with each other.

## What it does

- **Library** — shows all 21 slots with live thumbnails and flags problems: wrong aspect ratio, resolution below the `@2x` target, orphaned files.
- **Add / Replace** — pick a source image, crop it to the slot's exact target aspect (crop frame is locked to the target box, so there's no accidental distortion), and convert to WebP/PNG at the right size.
- **Review & Apply** — before anything touches disk, see a line-numbered diff of the `site.ts` change and the pending image write. Apply runs the site's own `tsc --noEmit` afterward to confirm the change type-checks.
- **Settings** — point the app at a local checkout of the hakumaguro.dev repo (`repoPath`); the image directory (`public/`) and content file (`src/lib/site.ts`) are derived from it, not independently configurable.

## How it works

- `src/main/slots.js` — the 21-slot registry and `@2x` target sizes
- `src/main/siteAst.js` — reads `site.ts`'s arrays and `page.tsx`'s fixed slots via `ts-morph`
- `src/main/scan.js` — scans the real repo against the slot registry, flags issues
- `src/main/pipeline.js` — crop + resize + encode via `sharp`
- `src/main/writer.js` — appends/updates/deletes/reorders `site.ts` entries via `ts-morph`, round-trips byte-clean, verifies with the target repo's own `tsc --noEmit`
- `src/main/queue.js` — holds pending changes in memory until Apply
- `src/renderer/` — plain HTML/CSS/JS UI, no framework, wired to the main process via `src/preload.js` (contextBridge)

## Requirements

- Node.js
- A local checkout of the hakumaguro.dev repo to point `repoPath` at (defaults to a path set in `src/main/settings.js` — change it in Settings on first run)

## Usage

```bash
npm install
npm start        # launch the app (dev mode; no packaged installer)
npm run smoke     # headless scan → convert → write → verify regression test
                   # against the real repo (self-cleaning, reverts its own writes)
```

## Scope notes

- Crop UI always matches the target box's aspect exactly — no freeform resize handles.
- Settings only exposes `repoPath`; the image directory and content file are read-only, derived from it.
- No packaged installer/icon — `npm start` in dev mode is the intended v1 UX.
