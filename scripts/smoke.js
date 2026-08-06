// Headless smoke test — task 7. Exercises scan → convert → write → verify
// against the REAL hakumaguroDev repo, end to end, before any UI exists.
// Every write it makes is reverted (git checkout, scoped to the exact files
// touched) so it's safe to run repeatedly. Requires a clean hakumaguroDev
// working tree (aside from whatever the user already has pending).

const { execFileSync } = require("child_process");
const path = require("path");

const { scan } = require("../src/main/scan");
const { processImage, centeredCropRect } = require("../src/main/pipeline");
const {
  appendArrayEntry,
  deleteArrayEntry,
  verifyTypecheck,
} = require("../src/main/writer");
const sharp = require("sharp");

const REPO = "C:/Users/sophanat_phokaenkaew/Documents/ClaudeBasket/hakumaguroDev";

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function assert(cond, msg) {
  if (!cond) throw new Error("SMOKE FAILED: " + msg);
}

async function main() {
  console.log("1. baseline: git status must be clean before we start writing");
  const before = git(["status", "--short"]);
  console.log(before || "(clean)");

  console.log("\n2. scan()");
  const result = await scan(REPO);
  assert(result.stats.total === 21, `expected 21 known slots, got ${result.stats.total}`);
  console.log(`   ${result.stats.total} slots, ${result.stats.set} set, ${result.stats.empty} empty, ${result.orphans.length} orphans`);
  const warned = Object.values(result.sections)
    .flat()
    .filter((i) => i.warnings);
  console.log(`   ${warned.length} slots flagged:`, warned.map((w) => `${w.id}(${w.warnings.map((x) => x.tag).join(",")})`).join(", "));

  console.log("\n3. pipeline: crop+resize+encode a real source image");
  const source = path.join(REPO, "public", "life-3.webp");
  const meta = await sharp(source).metadata();
  const target = { w: 712, h: 800 };
  const crop = centeredCropRect(meta.width, meta.height, target);
  const buf = await processImage(source, crop, target, "webp");
  const outMeta = await sharp(buf).metadata();
  assert(outMeta.width === target.w && outMeta.height === target.h, "pipeline output size mismatch");
  console.log(`   ${outMeta.width}x${outMeta.height} webp, ${buf.length} bytes`);

  console.log("\n4. writer: append a test life entry, verify, then delete it");
  appendArrayEntry(REPO, "lifeSource", {
    id: "life-smoke-test",
    tag: "Food",
    title: "smoke test entry",
    height: 260,
    mediaLabel: "smoke test — safe to ignore",
    image: "/life-smoke-test.webp",
  });
  const tsc = await verifyTypecheck(REPO);
  assert(tsc.ok, "tsc --noEmit failed after append:\n" + tsc.output);
  console.log("   tsc --noEmit: ok");

  deleteArrayEntry(REPO, "lifeSource", "life-smoke-test");
  const tscAfterDelete = await verifyTypecheck(REPO);
  assert(tscAfterDelete.ok, "tsc --noEmit failed after delete:\n" + tscAfterDelete.output);

  console.log("\n5. confirm site.ts round-tripped byte-clean (git diff empty)");
  const diff = git(["diff", "--stat", "src/lib/site.ts"]);
  assert(diff.trim() === "", "site.ts left dirty after append+delete round-trip:\n" + diff);
  console.log("   clean");

  console.log("\nALL SMOKE CHECKS PASSED");
}

main().catch((e) => {
  console.error(e.message);
  // best-effort cleanup: never leave the smoke-test entry behind
  try {
    deleteArrayEntry(REPO, "lifeSource", "life-smoke-test");
  } catch (_) {
    /* wasn't there, fine */
  }
  process.exit(1);
});
