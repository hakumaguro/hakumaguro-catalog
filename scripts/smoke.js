// Headless smoke test — task 7. Exercises scan → convert → write → verify
// against the REAL hakumaguro.dev repo, end to end.
//
// It reverts its own site.ts write with deleteArrayEntry (an AST-level undo of
// its own append) — it never runs `git checkout`, so uncommitted work in the
// target repo is never discarded, and a dirty tree is fine to run against.
// Step 5 proves the undo was byte-clean by comparing against a snapshot taken
// at step 1. The only images it touches are read-only (step 3 encodes to an
// in-memory Buffer and writes nothing).

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { scan } = require("../src/main/scan");
const { processImage, centeredCropRect } = require("../src/main/pipeline");
const {
  appendArrayEntry,
  deleteArrayEntry,
  verifyTypecheck,
} = require("../src/main/writer");
const sharp = require("sharp");
const { resolveRepoPathForScripts } = require("../src/main/settings");

// Located the same way the app locates it (HAKUMAGURO_REPO, else auto-detected
// next to this checkout) so there's no machine-specific path baked in here.
const REPO = resolveRepoPathForScripts();
const siteTs = path.join(REPO, "src", "lib", "site.ts");

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function assert(cond, msg) {
  if (!cond) throw new Error("SMOKE FAILED: " + msg);
}

async function main() {
  // The round-trip check at step 5 compares site.ts against THIS snapshot, not
  // against HEAD — the test asserts "our append+delete changed nothing", which
  // is true whether or not the user already had edits pending. (It used to
  // assert `git diff` was empty, which made any dirty tree a guaranteed false
  // failure.) Uncommitted work is reported for context but doesn't block.
  console.log("1. baseline: snapshot site.ts + report working tree");
  const baseline = fs.readFileSync(siteTs);
  const before = git(["status", "--short"]);
  console.log(before || "(clean)");
  if (before.trim()) {
    console.log("   note: pre-existing uncommitted changes above are left untouched");
  }

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

  console.log("\n5. confirm site.ts round-tripped byte-clean (vs. step 1 snapshot)");
  const after = fs.readFileSync(siteTs);
  assert(
    after.equals(baseline),
    "site.ts differs from its pre-test state after the append+delete round-trip — " +
      "the writer did not undo itself cleanly",
  );
  console.log("   clean (byte-identical)");

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
