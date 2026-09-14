import type { Product } from "./harborClient.js";
import { signedFetch } from "./harborClient.js";

const DIGEST_TO = process.env.AUTHDEEP_DIGEST_TO ?? "";

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

export interface DigestEmail {
  to: string;
  subject: string;
  html_body: string;
  text_body: string;
}

export function buildDigestEmail(lowStock: Product[]): DigestEmail {
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

  const html_body = `<h1>${escapeHtml(subject)}</h1>
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
  </table>`;

  const text_body = [
    subject,
    ...lowStock.map((p) => `${p.sku}\t${p.name}\tqty ${p.quantity}\treorder at ${p.reorder_at}`),
  ].join("\n");

  return { to: DIGEST_TO, subject, html_body, text_body };
}

/**
 * Sends the digest via AuthDeep (gateway-integration skill §7c, sak_ + HMAC).
 * --dry-run builds the exact payload and prints it without ever touching the
 * network, so it works without AuthDeep credentials configured.
 */
export async function sendDigestEmail(
  lowStock: Product[],
  options: { dryRun: boolean }
): Promise<void> {
  const email = buildDigestEmail(lowStock);

  if (!email.to) {
    throw new Error("AUTHDEEP_DIGEST_TO must be set");
  }

  if (options.dryRun) {
    console.log(JSON.stringify(email, null, 2));
    return;
  }

  const response = await signedFetch("POST", "/api/gateway/notifications/email", email);
  if (response.status !== 202) {
    throw new Error(`notification send failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { accepted?: boolean };
  if (!body.accepted) {
    throw new Error("notification send not accepted");
  }
}
