const HARBOR_API_URL = process.env.HARBOR_API_URL ?? "http://127.0.0.1:8788";
const HARBOR_API_KEY = process.env.HARBOR_API_KEY ?? "";

export interface Product {
  id: number;
  sku: string;
  name: string;
  quantity: number;
  reorder_at: number;
  updated_at: string;
}

export async function fetchProducts(): Promise<Product[]> {
  const response = await fetch(`${HARBOR_API_URL}/products`, {
    headers: { "X-Harbor-Key": HARBOR_API_KEY },
  });

  if (!response.ok) {
    throw new Error(`GET /products failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { products: Product[] };
  return body.products;
}
