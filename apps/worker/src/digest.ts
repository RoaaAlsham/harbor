import type { Product } from "./harborClient.js";

export function findLowStock(products: Product[]): Product[] {
  return products.filter((p) => p.quantity <= p.reorder_at);
}
