const fs = require("fs");
const sharp = require("sharp");
const { processImage, centeredCropRect } = require("../src/main/pipeline");

async function main() {
  const source =
    "C:/Users/sophanat_phokaenkaew/Documents/ClaudeBasket/hakumaguroDev/public/life-3.webp";
  const meta = await sharp(source).metadata();
  const target = { w: 712, h: 800 }; // pretend life target, height*2 = 800

  const crop = centeredCropRect(meta.width, meta.height, target);
  console.log("source:", meta.width, meta.height, "crop:", crop);

  const webpBuf = await processImage(source, crop, target, "webp");
  fs.writeFileSync("scripts/_out-test.webp", webpBuf);
  const outMeta = await sharp(webpBuf).metadata();
  console.log("webp output:", outMeta.width, outMeta.height, outMeta.format, webpBuf.length, "bytes");

  const pngBuf = await processImage(source, crop, { w: 48, h: 48 }, "png");
  fs.writeFileSync("scripts/_out-test.png", pngBuf);
  const pngMeta = await sharp(pngBuf).metadata();
  console.log("png output:", pngMeta.width, pngMeta.height, pngMeta.format, pngBuf.length, "bytes");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
