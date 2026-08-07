// Image pipeline — SPEC.md §5. Crop is always manual (a pixel rect chosen in
// the renderer's pan/zoom UI, in source-image coordinates); this module just
// extracts that rect, resizes to the slot's target box, and encodes.
// webp q82 for everything except logo-mark, which must stay PNG (its path is
// hardcoded with a .png extension in LogoMark.tsx — see ticket 06).

const sharp = require("sharp");

const WEBP_QUALITY = 82;

const COPYRIGHT_EXIF = {
  IFD0: {
    Copyright: "© Hakumaguro. All rights reserved.",
    Artist: "Hakumaguro",
  },
};

/**
 * @param {string} sourcePath - absolute path to the original picked file
 * @param {{left:number, top:number, width:number, height:number}} cropRect - in source-pixel coordinates
 * @param {{w:number, h:number}} target - output pixel dimensions
 * @param {"webp"|"png"} format
 * @returns {Promise<Buffer>}
 */
async function processImage(sourcePath, cropRect, target, format) {
  let pipeline = sharp(sourcePath).extract({
    left: Math.round(cropRect.left),
    top: Math.round(cropRect.top),
    width: Math.round(cropRect.width),
    height: Math.round(cropRect.height),
  });

  pipeline = pipeline.resize(target.w, target.h, { fit: "fill" });

  if (format === "png") {
    return pipeline.png({ compressionLevel: 9 }).toBuffer();
  }
  return pipeline
    .withMetadata({ exif: COPYRIGHT_EXIF })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

/** A centered crop rect matching the target aspect ratio — used as the default
 * crop-frame position before the user drags/zooms in the renderer. */
function centeredCropRect(sourceWidth, sourceHeight, target) {
  const targetAspect = target.w / target.h;
  const sourceAspect = sourceWidth / sourceHeight;

  let width, height;
  if (sourceAspect > targetAspect) {
    height = sourceHeight;
    width = Math.round(height * targetAspect);
  } else {
    width = sourceWidth;
    height = Math.round(width / targetAspect);
  }
  return {
    left: Math.round((sourceWidth - width) / 2),
    top: Math.round((sourceHeight - height) / 2),
    width,
    height,
  };
}

module.exports = { processImage, centeredCropRect, WEBP_QUALITY };
