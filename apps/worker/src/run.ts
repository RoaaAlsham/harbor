import { fetchProducts } from "./harborClient.js";
import { findLowStock } from "./digest.js";
import { writeDigestEmail } from "./mailer.js";

async function main() {
  const products = await fetchProducts();
  const lowStock = findLowStock(products);

  if (lowStock.length === 0) {
    console.log("no low stock");
    return;
  }

  const filePath = writeDigestEmail(lowStock);
  console.log(filePath);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
