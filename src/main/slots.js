// Static knowledge of hakumaguro-dev's image slots — SPEC.md §2/§3.
// Deliberately hardcoded, not introspected from site.ts's TS types (SPEC §2 / ticket 02 answer).

const TARGET_SIZES = {
  // Art grid is 4 columns, cell ~256.5 x 231 CSS px at full width (@2x below).
  artNormal: { w: 514, h: 462 },
  artTall: { w: 514, h: 944 },
  artWideTall: { w: 1046, h: 944 },
  vrClip: { w: 670, h: 376, aspect: 16 / 9 },
  heroPicture: { w: 1536, h: 1024, aspect: 3 / 2 },
  aboutPortrait: { w: 600, h: 600, aspect: 1 },
  shinano: { w: 800, h: 1067, aspect: 3 / 4 },
  contact: { w: 320, h: 320, aspect: 1 },
  logoMark: { w: 64, h: 64, aspect: 1 },
};

// Files in public/ that are deliberately not image slots (so scan() does not
// report them as orphans). og.jpg is the Open Graph card referenced from
// src/app/layout.tsx metadata.
const KNOWN_NON_SLOT_FILES = ["og.jpg"];

function artTarget(span) {
  if (span === "wide-tall") return TARGET_SIZES.artWideTall;
  if (span === "tall") return TARGET_SIZES.artTall;
  return TARGET_SIZES.artNormal;
}

// The 5 slots that are NOT array members — replace-only, never deleted, never
// reordered, and their filename never changes (so "replace" only ever
// overwrites the same path — see writer.js). wrapperAttr/labelProp identify
// the JSX prop pair that must stay in sync with the <Image alt> (ticket 06);
// logo-mark has neither because LogoMark.tsx only has `src="/logo-mark.png"`
// hardcoded — replacing it is a pure file overwrite, no AST write at all.
const FIXED_SLOTS = [
  {
    id: "hero-picture",
    file: "haku-sky.webp",
    section: "hero",
    bind: "page.tsx",
    target: TARGET_SIZES.heroPicture,
    format: "webp",
    wrapperAttr: "picture",
    labelProp: "pictureLabel",
  },
  {
    id: "about-portrait",
    file: "haku-hero.webp",
    section: "about",
    bind: "page.tsx",
    target: TARGET_SIZES.aboutPortrait,
    format: "webp",
    wrapperAttr: "portrait",
    labelProp: "portraitLabel",
  },
  {
    id: "vrc-portrait",
    file: "shinano.webp",
    section: "virtual",
    bind: "page.tsx",
    target: TARGET_SIZES.shinano,
    format: "webp",
    wrapperAttr: "portrait",
    labelProp: "portraitLabel",
  },
  {
    id: "contact-avatar",
    file: "haku-contact.webp",
    section: "home",
    bind: "page.tsx",
    target: TARGET_SIZES.contact,
    format: "webp",
    wrapperAttr: "avatar",
    labelProp: "avatarLabel",
  },
  {
    id: "logo-mark",
    file: "logo-mark.png",
    section: "brand",
    bind: "LogoMark.tsx",
    target: TARGET_SIZES.logoMark,
    format: "png",
  },
];

// The 3 arrays in site.ts that the tool appends/replaces/deletes/reorders members of.
const ARRAY_CONFIGS = {
  art: {
    section: "imagination",
    variableName: "artPieces",
    idPrefix: "art",
    kind: "art",
    format: "webp",
    targetFor: (item) => artTarget(item.span),
  },
  vrClip: {
    section: "virtual",
    variableName: "vrClips",
    idPrefix: "vr-clip",
    kind: "vr-clip",
    format: "webp",
    targetFor: () => TARGET_SIZES.vrClip,
  },
  life: {
    section: "ground",
    variableName: "lifeItems",
    idPrefix: "life",
    kind: "life",
    format: "webp",
    // life has no fixed target width — the box varies by breakpoint: ~252px
    // in the 4-column desktop layout, up to ~293px in the 2-column layout just
    // under 640px (on phones the height is scaled to 62%). Use 560 wide (@2x of
    // the desktop tile) and the user-set `height` field (desktop tile height in
    // CSS px) x 2 for the target box.
    targetFor: (item) => ({ w: 560, h: (item.height || 260) * 2 }),
  },
};

module.exports = { TARGET_SIZES, KNOWN_NON_SLOT_FILES, FIXED_SLOTS, ARRAY_CONFIGS, artTarget };
