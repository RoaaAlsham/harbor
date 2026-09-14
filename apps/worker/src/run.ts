import { fetchProducts } from "./harborClient.js";
import { findLowStock } from "./digest.js";
import { sendDigestEmail } from "./mailer.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const products = await fetchProducts();
  const lowStock = findLowStock(products);

  if (lowStock.length === 0) {
    console.log("no low stock");
    return;
  }

  await sendDigestEmail(lowStock, { dryRun });
  console.log(dryRun ? "dry run — not sent" : "digest sent");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
