#!/usr/bin/env node
// Verify a founder's published Stripe revenue with their public, balance-only key.
//
//   node verify.mjs rk_live_xxx
//   node verify.mjs rk_live_xxx --compare https://example.com/api/revenue
//   node verify.mjs rk_live_xxx --json
//
// Node 18+ only, no dependencies. Read this file and revenue.mjs before running it:
// it only sends GET requests to api.stripe.com (and to the --compare URL if given).

import { aggregate, fetchAllBalanceTransactions, formatMoney, isForbidden, stripeGet } from "./revenue.mjs";

const args = process.argv.slice(2);
const key = args.find((a) => /^rk_(live|test)_/.test(a)) || process.env.STRIPE_VERIFY_KEY;
const asJson = args.includes("--json");
const compareIdx = args.indexOf("--compare");
const compareUrl = compareIdx >= 0 ? args[compareIdx + 1] : null;

if (!key) {
  console.error("Usage: node verify.mjs <rk_live_...> [--compare <site>/api/revenue] [--json]");
  console.error("Only restricted keys (rk_) are accepted. Never pass a secret key (sk_).");
  process.exit(1);
}

const log = (...m) => { if (!asJson) console.log(...m); };

// 1. The key must be unable to read customer data. If it can, stop: the owner
//    published a key that leaks customer information.
log("1. Checking that the key cannot read customer data...");
const sensitive = ["/charges", "/customers", "/payment_intents", "/invoices", "/checkout/sessions"];
const leaks = [];
for (const path of sensitive) {
  const forbidden = await isForbidden(key, path);
  log(`   ${forbidden ? "✓ refused " : "✗ ALLOWED "} ${path}`);
  if (!forbidden) leaks.push(path);
}
if (leaks.length) {
  console.error(`\nThis key can read ${leaks.join(", ")}. It exposes customer data and should not be public.`);
  console.error("Ask the owner to delete it and publish a key with only `Balance: Read`.");
  process.exit(2);
}

// 2. Current balance (proves the key is live and belongs to a real account).
log("\n2. Reading current balance...");
const bal = await stripeGet(key, "/balance");
if (!bal.ok) {
  console.error(`   Stripe refused /balance: ${bal.body?.error?.message || bal.status}`);
  process.exit(3);
}
log(`   livemode: ${bal.body.livemode}`);
for (const b of bal.body.available) log(`   available ${formatMoney(b.amount, b.currency)}`);
for (const b of bal.body.pending) log(`   pending   ${formatMoney(b.amount, b.currency)}`);

// 3. Every balance transaction, aggregated.
log("\n3. Reading all balance transactions...");
const { transactions } = await fetchAllBalanceTransactions(key, {
  onPage: (p, n) => { if (!asJson) process.stdout.write(`\r   page ${p}, ${n} transactions`); },
});
log("");
const result = aggregate(transactions);

if (asJson) {
  console.log(JSON.stringify({ livemode: bal.body.livemode, ...result }, null, 2));
} else {
  for (const [cur, c] of Object.entries(result.currencies)) {
    const t = c.total;
    if (!t.payments && !t.refunds) continue;
    log(`\n   ${cur.toUpperCase()} all time`);
    log(`     gross     ${formatMoney(t.gross, cur)}  (${t.payments} payments)`);
    log(`     refunds   ${formatMoney(t.refunds, cur)}`);
    log(`     disputes  ${formatMoney(t.disputes, cur)}`);
    log(`     fees     -${formatMoney(t.fees, cur)}`);
    log(`     net       ${formatMoney(t.net, cur)}`);
    const l30 = result.last30Days[cur]?.gross ?? 0;
    const p30 = result.previous30Days[cur]?.gross ?? 0;
    const growth = p30 ? `${(((l30 - p30) / p30) * 100).toFixed(1)}%` : "n/a";
    log(`   last 30 days gross ${formatMoney(l30, cur)}  (previous 30 days ${formatMoney(p30, cur)}, change ${growth})`);
    log(`   by month (gross / net)`);
    for (const [month, m] of Object.entries(c.months)) {
      if (m.gross || m.refunds) log(`     ${month}  ${formatMoney(m.gross, cur).padStart(14)}  ${formatMoney(m.net, cur).padStart(14)}`);
    }
  }
}

// 4. Optional: compare with the numbers the website publishes.
if (compareUrl) {
  log(`\n4. Comparing with ${compareUrl} ...`);
  const site = await fetch(compareUrl).then((r) => r.json());
  let mismatches = 0;
  for (const [cur, c] of Object.entries(result.currencies)) {
    const s = site.currencies?.[cur]?.total;
    for (const field of ["gross", "refunds", "disputes", "fees", "net"]) {
      if (!s || s[field] !== c.total[field]) {
        mismatches++;
        log(`   ✗ ${cur} ${field}: Stripe ${c.total[field]}, site ${s?.[field]}`);
      }
    }
  }
  log(mismatches ? `   ${mismatches} mismatches (the site caches for up to 6 hours; recent payments can differ).` : "   ✓ The website's totals match Stripe exactly.");
  if (mismatches) process.exitCode = 4;
}
