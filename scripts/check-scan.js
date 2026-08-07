const { scan } = require("../src/main/scan");
const { resolveRepoPathForScripts } = require("../src/main/settings");

async function main() {
  const result = await scan(resolveRepoPathForScripts());
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
