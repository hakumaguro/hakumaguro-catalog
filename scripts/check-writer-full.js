const {
  appendArrayEntry,
  updateArrayEntry,
  deleteArrayEntry,
  reorderArray,
  updateFixedPageSlot,
  verifyTypecheck,
} = require("../src/main/writer");

const { resolveRepoPathForScripts } = require("../src/main/settings");

const repoPath = resolveRepoPathForScripts();

async function main() {
  // 1. append
  appendArrayEntry(repoPath, "artPieces", {
    id: "art-7",
    mediaLabel: "test — writer smoke",
    image: "/art-7.webp",
  });
  console.log("appended art-7");

  // 2. update a field
  updateArrayEntry(repoPath, "artPieces", "art-7", { mediaLabel: "test — updated label" });
  console.log("updated art-7 mediaLabel");

  // 3. reorder — move art-7 to the front
  reorderArray(repoPath, "artPieces", [
    "art-7",
    "art-1",
    "art-2",
    "art-3",
    "art-4",
    "art-5",
    "art-6",
  ]);
  console.log("reordered artPieces (art-7 first)");

  // 4. delete it
  deleteArrayEntry(repoPath, "artPieces", "art-7");
  console.log("deleted art-7");

  // 5. fixed-slot update (contact avatar — simplest, single label prop)
  updateFixedPageSlot(repoPath, {
    oldSrc: "/haku-contact.webp",
    newSrc: "/haku-contact.webp", // same file, just proving the alt-sync path
    newAlt: "Haku chibi (smoke test)",
    wrapperAttr: "avatar",
    labelProp: "avatarLabel",
  });
  console.log("updated contact-avatar alt+avatarLabel");

  const result = await verifyTypecheck(repoPath);
  console.log("tsc ok:", result.ok);
  if (!result.ok) console.log(result.output);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
