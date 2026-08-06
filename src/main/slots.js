// Static knowledge of hakumaguro-dev's image slots — SPEC.md §2/§3.
// Deliberately hardcoded, not introspected from site.ts's TS types (SPEC §2 / ticket 02 answer).

const TARGET_SIZES = {
  artNormal: { w: 378, h: 340 },
  artTall: { w: 378, h: 708 },
  artWideTall: { w: 783, h: 708 },
  vrClip: { w: 670, h: 376, aspect: 16 / 9 },
  hero: { w: 600, h: 600, aspect: 1 },
  shinano: { w: 600, h: 800, aspect: 3 / 4 },
  contact: { w: 320, h: 320, aspect: 1 },
  logoMark: { w: 48, h: 48, aspect: 1 },
};

function artTarget(span) {
  if (span === "wide-tall") return TARGET_SIZES.artWideTall;
  if (span === "tall") return TARGET_SIZES.artTall;
  return TARGET_SIZES.artNormal;
}

// The 4 slots that are NOT array members — replace-only, never deleted, never
// reordered, and their filename never changes (so "replace" only ever
// overwrites the same path — see writer.js). wrapperAttr/labelProp identify
// the JSX prop pair that must stay in sync with the <Image alt> (ticket 06);
// logo-mark has neither because LogoMark.tsx only has `src="/logo-mark.png"`
// hardcoded — replacing it is a pure file overwrite, no AST write at all.
const FIXED_SLOTS = [
  {
    id: "hero-portrait",
    file: "haku-hero.webp",
    section: "hero",
    bind: "page.tsx",
    target: TARGET_SIZES.hero,
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
    variableName: "lifeSource",
    idPrefix: "life",
    kind: "life",
    format: "webp",
    // life has no fixed target width — the box itself varies 323-356px @1x
    // (see assets/slot-dimensions.md); use the widest (@2x 712) and the
    // user-set height field for the target box.
    targetFor: (item) => ({ w: 712, h: (item.height || 260) * 2 }),
  },
};

module.exports = { TARGET_SIZES, FIXED_SLOTS, ARRAY_CONFIGS, artTarget };
