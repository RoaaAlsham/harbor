import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Product } from "./harborClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outboxDir = join(__dirname, "..", "data", "outbox");

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function writeDigestEmail(lowStock: Product[]): string {
  if (!existsSync(outboxDir)) {
    mkdirSync(outboxDir, { recursive: true });
  }

  const now = new Date();
  const safeTimestamp = now.toISOString().replace(/[:.]/g, "-");
  const filePath = join(outboxDir, `digest-${safeTimestamp}.html`);
  const subject = `Harbor low-stock digest — ${lowStock.length} item(s)`;

  const rows = lowStock
    .map(
      (p) => `      <tr>
        <td>${escapeHtml(p.sku)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.quantity)}</td>
        <td>${escapeHtml(p.reorder_at)}</td>
      </tr>`
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(subject)}</title>
</head>
<body>
  <h1>${escapeHtml(subject)}</h1>
  <table border="1" cellpadding="6" cellspacing="0">
    <thead>
      <tr>
        <th>SKU</th>
        <th>Name</th>
        <th>Quantity</th>
        <th>Reorder at</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;

  writeFileSync(filePath, html, "utf-8");
  return filePath;
}
