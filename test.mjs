// Offline test of the aggregation logic with hand-made transactions.
import assert from "node:assert/strict";
import { aggregate } from "./revenue.mjs";

const day = 86400;
const now = Date.UTC(2026, 10, 9) / 1000;
const tx = (reporting_category, amount, fee, daysAgo, currency = "usd") => ({
  reporting_category, amount, fee, currency, created: now - daysAgo * day,
});

const r = aggregate(
  [
    tx("charge", 2000, 88, 2),        // $20 payment, recent
    tx("charge", 1000, 59, 60),       // $10 payment, two months ago
    tx("refund", -1000, 0, 55),       // refund of the $10
    tx("dispute", -2000, 1500, 1),    // dispute with $15 dispute fee
    tx("fee", -300, 0, 3),            // separately billed Stripe fee
    tx("payout", -5000, 0, 1),        // ignored: money movement
    tx("charge", 50000, 0, 1, "nzd"), // other currency
  ],
  now * 1000,
);

const usd = r.currencies.usd.total;
assert.equal(usd.gross, 3000);
assert.equal(usd.refunds, -1000);
assert.equal(usd.disputes, -2000);
assert.equal(usd.fees, 88 + 59 + 1500 + 300);
assert.equal(usd.net, 3000 - 1000 - 2000 - 1947);
assert.equal(usd.payments, 2);
assert.equal(r.last30Days.usd.gross, 2000);
assert.equal(r.last30Days.usd.refunds, 0);
assert.equal(r.currencies.nzd.total.gross, 50000);
assert.equal(Object.keys(r.currencies.usd.months).length, 2);
// previous 30 days window (30-60 days ago): the $10 payment and its refund
assert.equal(r.previous30Days.usd.gross, 1000);
assert.equal(r.previous30Days.usd.refunds, -1000);
// daily buckets: 180 days, oldest first, recent payment lands on its UTC day
const days = Object.keys(r.currencies.usd.days);
assert.equal(days.length, 180);
assert.equal(days[179], "2026-11-09");
assert.equal(r.currencies.usd.days["2026-11-07"].gross, 2000);
assert.equal(r.currencies.usd.days["2026-11-08"].disputes, -2000);
assert.equal(Object.values(r.currencies.usd.days).reduce((a, d) => a + d.gross, 0), 3000);
console.log("ok - aggregation");
