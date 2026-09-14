import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "apps", "api", "data");
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db = new Database(join(dataDir, "harbor.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    reorder_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const products = [
  { sku: "WIDGET-1", name: "Widget", quantity: 100, reorder_at: 10 },
  { sku: "GADGET-2", name: "Gadget", quantity: 3, reorder_at: 10 },
  { sku: "BOLT-9", name: "Bolt", quantity: 0, reorder_at: 5 },
  { sku: "CRATE-4", name: "Crate", quantity: 50, reorder_at: 5 },
];

const upsert = db.prepare(`
  INSERT INTO products (sku, name, quantity, reorder_at, updated_at)
  VALUES (@sku, @name, @quantity, @reorder_at, @updated_at)
  ON CONFLICT(sku) DO UPDATE SET
    name = excluded.name,
    quantity = excluded.quantity,
    reorder_at = excluded.reorder_at,
    updated_at = excluded.updated_at
`);

const now = new Date().toISOString();
const insertMany = db.transaction((rows) => {
  for (const row of rows) {
    upsert.run({ ...row, updated_at: now });
  }
});

insertMany(products);

console.log(`Seeded ${products.length} products.`);
db.close();
