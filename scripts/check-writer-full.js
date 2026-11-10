// Exercises every real write path in writer.js against the hakumaguro.dev
// repo, checks that each one changes only what it should, and puts the two
// content files back with git when it is done (also on failure). No image
// files are written.
//
// Requires a clean working tree in the target repo — it refuses to run
// otherwise, because the cleanup is a `git checkout` of site.ts and page.tsx.

const { execFileSync } = require("child_process");

const {
  appendArrayEntry,
  updateArrayEntry,
  deleteArrayEntry,
  reorderArray,
  updateFixedPageSlot,
  verifyTypecheck,
} = require("../src/main/writer");
const { readArrays } = require("../src/main/siteAst");
const { FIXED_SLOTS, ARRAY_CONFIGS } = require("../src/main/slots");

const repoPath = process.env.HAKUMAGURO_REPO || "C:/Users/sophanat_phokaenkaew/Documents/ClaudeBasket/hakumaguroDev";
const CONTENT_FILES = ["src/app/page.tsx", "src/lib/site.ts"];

function git(args) {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
}

/** The +/- lines of the working-tree diff for one file, without the headers. */
function changedLines(file) {
  return git(["diff", "--unified=0", "--", file])
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
}

function restore() {
  git(["checkout", "--", ...CONTENT_FILES]);
}

let failed = false;
function report(ok, message, detail) {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok && detail) console.log(detail);
}

async function main() {
  if (git(["status", "--short"]).trim()) {
    throw new Error(`${repoPath} has uncommitted changes — commit or stash them first`);
  }

  try {
    // 1. fixed slots: an alt update must touch that slot's alt + label, nothing else
    for (const slot of FIXED_SLOTS.filter((s) => s.bind === "page.tsx")) {
      updateFixedPageSlot(repoPath, {
        oldSrc: `/${slot.file}`,
        newSrc: `/${slot.file}`, // same file, just proving the alt-sync path
        newAlt: `writer check ${slot.id}`,
        wrapperAttr: slot.wrapperAttr,
        labelProp: slot.labelProp,
      });
      const lines = changedLines("src/app/page.tsx");
      const added = lines.filter((l) => l.startsWith("+"));
      report(
        added.length === 2 && added.every((l) => l.includes(`writer check ${slot.id}`)),
        `fixed slot ${slot.id}: alt + ${slot.labelProp} updated, ${lines.length} changed lines`,
        lines.join("\n"),
      );
      restore();
    }

    // 2. arrays: append → update → reorder → reorder back → delete must
    //    typecheck with the entry in place and leave site.ts byte-identical
    const arrays = readArrays(repoPath);
    const testEntries = {
      artPieces: [{ id: "art-check", mediaLabel: "writer check", image: "/art-check.webp" }, { span: "tall" }],
      vrClips: [{ id: "vr-clip-check", mediaLabel: "writer check", image: "/vr-clip-check.webp" }, { mediaLabel: "writer check 2" }],
      lifeItems: [
        { id: "life-check", tag: "Food", title: "writer check", height: 260, mediaLabel: "writer check", image: "/life-check.webp" },
        { title: "writer check 2" },
      ],
    };
    for (const config of Object.values(ARRAY_CONFIGS)) {
      const varName = config.variableName;
      const [entry, patch] = testEntries[varName];
      const ids = arrays[varName].map((e) => e.id);
      appendArrayEntry(repoPath, varName, entry);
      updateArrayEntry(repoPath, varName, entry.id, patch);
      reorderArray(repoPath, varName, [entry.id, ...ids]);
      const tsc = await verifyTypecheck(repoPath);
      reorderArray(repoPath, varName, [...ids, entry.id]);
      deleteArrayEntry(repoPath, varName, entry.id);
      const lines = changedLines("src/lib/site.ts");
      report(
        tsc.ok && lines.length === 0,
        `${varName}: tsc with the test entry ${tsc.ok ? "ok" : "FAILED"}, ${lines.length} lines left changed after delete`,
        (tsc.ok ? "" : tsc.output + "\n") + lines.slice(0, 20).join("\n"),
      );
      restore();
    }

    // 3. an in-place update must change exactly the edited line
    updateArrayEntry(repoPath, "lifeItems", arrays.lifeItems[0].id, { title: "writer check title" });
    const lines = changedLines("src/lib/site.ts");
    report(lines.length === 2, `lifeItems in-place update: ${lines.length} changed lines`, lines.slice(0, 20).join("\n"));
  } finally {
    restore();
  }

  const left = git(["status", "--short"]).trim();
  report(!left, "target repo is clean again", left);
  if (failed) process.exit(1);
  console.log("\nALL WRITER CHECKS PASSED");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  try {
    restore();
  } catch (_) {
    /* nothing to restore */
  }
  process.exit(1);
});
