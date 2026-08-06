const { scan } = require("../src/main/scan");

async function main() {
  const result = await scan("C:/Users/sophanat_phokaenkaew/Documents/ClaudeBasket/hakumaguroDev");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
