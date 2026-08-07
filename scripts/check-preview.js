// Headless check for the live preview's shadow copy.
//
// It deliberately does NOT boot `next dev`. The failure this guards against is
// the one you cannot see with your eyes: the preview writing into the real
// hakumaguro.dev checkout. Everything else about the preview is visible the
// moment you look at it — a stale image, a wrong crop, a broken layout all
// announce themselves. A leak into the real repo does not.
//
// So the assertion that matters is the same technique smoke.js uses: snapshot
// the real repo's bytes, run a full preview render against it, and prove not a
// single byte moved. Comparing bytes rather than `git diff` is deliberate —
// with core.autocrlf on, git can normalise away a line-ending regression that a
// byte comparison catches.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { resolveRepoPathForScripts } = require("../src/main/settings");
const { syncShadow, shadowDirFor, commonAncestor, clearShadow, INJECTED_SCRIPT } = require("../src/main/preview");
const { Queue } = require("../src/main/queue");
const { readArrays } = require("../src/main/siteAst");

const REPO = resolveRepoPathForScripts();

// A throwaway stand-in for Electron's userData dir, so a check run never
// disturbs the shadow the real app has warmed up.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-preview-check-"));

function assert(cond, msg) {
  if (!cond) throw new Error("CHECK FAILED: " + msg);
}

/** sha256 of every file in the real repo that a preview could plausibly reach:
 *  the content files it rewrites and every image in public/. */
function fingerprint(repoPath) {
  const out = {};
  const add = (abs, rel) => {
    out[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  };
  for (const rel of [
    path.join("src", "lib", "site.ts"),
    path.join("src", "app", "page.tsx"),
    path.join("src", "app", "layout.tsx"),
    path.join("src", "ds", "LogoMark.tsx"),
    "next.config.ts",
  ]) {
    const abs = path.join(repoPath, rel);
    if (fs.existsSync(abs)) add(abs, rel);
  }
  const pub = path.join(repoPath, "public");
  for (const name of fs.readdirSync(pub)) {
    const abs = path.join(pub, name);
    if (fs.statSync(abs).isFile()) add(abs, `public/${name}`);
  }
  return out;
}

function diffFingerprints(before, after) {
  const changed = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) changed.push(k);
  }
  return changed;
}

async function main() {
  console.log(`target repo: ${REPO}`);
  console.log(`scratch userData: ${USER_DATA}\n`);

  console.log("1. fingerprint the real repo");
  const before = fingerprint(REPO);
  console.log(`   ${Object.keys(before).length} files hashed`);

  console.log("\n2. syncShadow()");
  const t0 = Date.now();
  const { shadowDir, turbopackRoot, useWebpack, canFocus } = syncShadow(USER_DATA, REPO);
  console.log(`   ${shadowDir}`);
  console.log(`   ${Date.now() - t0}ms · turbopack.root=${turbopackRoot || "(none)"} · webpack fallback=${useWebpack} · jump-to-change=${canFocus}`);

  assert(shadowDir === shadowDirFor(USER_DATA, REPO), "shadow dir is not stable for the same repo path");
  assert(fs.existsSync(path.join(shadowDir, "src", "lib", "site.ts")), "shadow is missing site.ts");
  assert(fs.existsSync(path.join(shadowDir, "public", INJECTED_SCRIPT)), "preview script was not injected");
  assert(canFocus, "the preview script was not referenced from layout.tsx");
  assert(!fs.existsSync(path.join(shadowDir, ".git")), ".git should not be mirrored into the shadow");

  const junction = fs.lstatSync(path.join(shadowDir, "node_modules"));
  assert(junction.isSymbolicLink(), "node_modules should be a junction, not a copy");
  assert(
    fs.existsSync(path.join(shadowDir, "node_modules", "next", "package.json")),
    "the node_modules junction does not resolve"
  );

  if (commonAncestor(shadowDir, REPO)) {
    const cfg = fs.readFileSync(path.join(shadowDir, "next.config.ts"), "utf8");
    assert(/turbopack/.test(cfg) && /root:/.test(cfg), "next.config.ts wrapper is missing the widened turbopack root");
    assert(
      fs.existsSync(path.join(shadowDir, "next.config.original.ts")),
      "the real next.config.ts was not carried over for the wrapper to import"
    );
  }

  console.log("\n3. apply a queue into the shadow (verify off, as the preview does)");
  const arrays = readArrays(REPO);
  const victim = arrays.artPieces.find((e) => e && typeof e.image === "string");
  assert(victim, "no artPieces entry with an image to exercise");
  const victimFile = victim.image.split("/").pop();

  const queue = new Queue();
  queue.add({
    op: "REPLACE",
    section: "Art",
    varName: "artPieces",
    id: victim.id,
    patch: { mediaLabel: "preview-check" },
    outFilename: victimFile,
    buffer: Buffer.from("not-a-real-image-just-bytes"),
  });
  queue.add({ op: "DELETE", section: "Art", varName: "artPieces", id: victim.id, contentDescription: "site.ts" });

  const result = await queue.apply(shadowDir, { verify: false });
  assert(result.tsc === null, "preview apply must not run tsc");
  assert(queue.list().length === 2, "preview apply must leave the queue intact");
  assert(result.written.includes(victimFile), `expected ${victimFile} to be written into the shadow`);

  const shadowBytes = fs.readFileSync(path.join(shadowDir, "public", victimFile));
  assert(shadowBytes.toString() === "not-a-real-image-just-bytes", "the shadow image was not replaced");
  const shadowSite = fs.readFileSync(path.join(shadowDir, "src", "lib", "site.ts"), "utf8");
  assert(!shadowSite.includes(`id: "${victim.id}"`), "the delete did not land in the shadow's site.ts");
  console.log(`   wrote ${result.written.join(", ")} and replayed 2 ops into the shadow`);

  console.log("\n4. the real repo must be byte-identical");
  const after = fingerprint(REPO);
  const changed = diffFingerprints(before, after);
  assert(changed.length === 0, `the preview modified the real repo: ${changed.join(", ")}`);
  console.log(`   ${Object.keys(after).length} files unchanged`);

  console.log("\n5. previewTargets()");
  const targets = queue.previewTargets();
  assert(targets.length === 2, "expected one target per queued op");
  assert(targets[0].file === victimFile && targets[0].highlight === true, "a replace should point at its own image");
  assert(targets[1].file === null && targets[1].varName === "artPieces", "a delete has no image, only its array");
  console.log(`   ${targets.map((t) => `${t.op}->${t.file || t.varName}`).join(", ")}`);

  console.log("\n6. resync restores the shadow to match the real repo");
  const configName = fs.existsSync(path.join(shadowDir, "next.config.ts")) ? "next.config.ts" : null;
  const beforeResync = configName
    ? {
        config: fs.statSync(path.join(shadowDir, configName)).mtimeMs,
        layout: fs.statSync(path.join(shadowDir, "src", "app", "layout.tsx")).mtimeMs,
      }
    : null;

  syncShadow(USER_DATA, REPO);
  const resynced = fs.readFileSync(path.join(shadowDir, "src", "lib", "site.ts"), "utf8");
  assert(resynced.includes(`id: "${victim.id}"`), "resync did not undo the previous preview's content write");
  const realBytes = fs.readFileSync(path.join(REPO, "public", victimFile));
  assert(
    fs.readFileSync(path.join(shadowDir, "public", victimFile)).equals(realBytes),
    "resync did not restore the original image"
  );
  assert(fs.existsSync(path.join(shadowDir, "public", INJECTED_SCRIPT)), "resync deleted the injected script");

  // A resync must leave the patched files alone when nothing upstream changed:
  // `next dev` restarts itself on a config write, which killed a running
  // preview server the first time this was built.
  if (beforeResync) {
    assert(
      fs.statSync(path.join(shadowDir, configName)).mtimeMs === beforeResync.config,
      "resync rewrote next.config.ts — that restarts a running dev server"
    );
    assert(
      fs.statSync(path.join(shadowDir, "src", "app", "layout.tsx")).mtimeMs === beforeResync.layout,
      "resync rewrote layout.tsx — that forces a needless recompile every preview"
    );
  }
  console.log("   shadow matches the real repo again; patched files untouched");

  console.log("\n7. clearing the shadow cannot reach through the junction");
  const canary = path.join(REPO, "node_modules", "next", "package.json");
  assert(fs.existsSync(canary), "sanity: the target repo's next package should exist before the clear");
  const cleared = clearShadow(USER_DATA, REPO);
  assert(cleared.ok, `clearShadow failed: ${cleared.error}`);
  assert(!fs.existsSync(shadowDir), "the shadow directory should be gone");
  assert(
    fs.existsSync(canary),
    "CATASTROPHE: clearing the shadow deleted through the node_modules junction into the REAL repo"
  );
  console.log("   shadow removed, the real repo's node_modules survived");

  console.log("\nPREVIEW CHECK PASSED");
}

main()
  .catch((err) => {
    console.error("\n" + err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  });
