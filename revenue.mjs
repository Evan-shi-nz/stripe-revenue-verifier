// Shared, dependency-free revenue aggregation for Stripe balance transactions.
// The same file is copied into the website (functions/_lib/revenue.mjs) so the
// numbers on the site and the numbers from `verify.mjs` come from identical code.

export const STRIPE_API = "https://api.stripe.com/v1";

// Stripe `reporting_category` values that count toward revenue.
// Everything else (payouts, transfers, top-ups, ...) is money movement, not revenue.
const GROSS = new Set(["charge"]);
const REFUND = new Set(["refund", "partial_capture_reversal"]);
const DISPUTE = new Set(["dispute", "dispute_reversal"]);
const STRIPE_FEE = new Set(["fee"]);

export async function stripeGet(key, path, params = {}) {
  const url = new URL(STRIPE_API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Returns true when the key is refused for `path` (what we want for customer data).
export async function isForbidden(key, path) {
  const r = await stripeGet(key, path, { limit: 1 });
  return !r.ok && (r.status === 401 || r.status === 403);
}

// Pages through every balance transaction. `maxPages` protects runtimes with a
// sub-request limit (Cloudflare free plan: 50 per request).
export async function fetchAllBalanceTransactions(key, { maxPages = Infinity, onPage } = {}) {
  const all = [];
  let startingAfter;
  for (let page = 0; page < maxPages; page++) {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const r = await stripeGet(key, "/balance_transactions", params);
    if (!r.ok) {
      const msg = r.body?.error?.message || `HTTP ${r.status}`;
      throw new Error(`Stripe refused /balance_transactions: ${msg}`);
    }
    all.push(...r.body.data);
    onPage?.(page + 1, all.length);
    if (!r.body.has_more) return { transactions: all, complete: true };
    startingAfter = r.body.data[r.body.data.length - 1].id;
  }
  return { transactions: all, complete: false };
}

function bucket() {
  return { gross: 0, refunds: 0, disputes: 0, fees: 0, net: 0, payments: 0 };
}

// Aggregates amounts per currency (minor units, e.g. cents): all time, per UTC month,
// per UTC day for the last DAILY_DAYS days, the last 30 days and the 30 days before that.
// Only totals leave this function: no IDs, descriptions or customer references.
export const DAILY_DAYS = 90;

export function aggregate(transactions, now = Date.now()) {
  const byCurrency = {};
  const last30 = {};
  const prev30 = {};
  const nowSec = Math.floor(now / 1000);
  const cutoff30 = nowSec - 30 * 86400;
  const cutoff60 = nowSec - 60 * 86400;
  const dailyStart = startOfUtcDay(nowSec) - (DAILY_DAYS - 1) * 86400;

  for (const tx of transactions) {
    const cat = tx.reporting_category;
    if (!GROSS.has(cat) && !REFUND.has(cat) && !DISPUTE.has(cat) && !STRIPE_FEE.has(cat)) continue;
    const cur = tx.currency;
    const c = (byCurrency[cur] ??= { total: bucket(), months: {}, days: emptyDays(dailyStart) });
    const month = new Date(tx.created * 1000).toISOString().slice(0, 7);
    const targets = [c.total, (c.months[month] ??= bucket())];
    if (tx.created >= dailyStart) {
      const day = new Date(tx.created * 1000).toISOString().slice(0, 10);
      if (c.days[day]) targets.push(c.days[day]);
    }
    if (tx.created >= cutoff30) targets.push((last30[cur] ??= bucket()));
    else if (tx.created >= cutoff60) targets.push((prev30[cur] ??= bucket()));

    for (const t of targets) {
      if (GROSS.has(cat)) {
        t.gross += tx.amount;
        t.fees += tx.fee;
        t.payments += 1;
      } else if (REFUND.has(cat)) {
        t.refunds += tx.amount; // negative
        t.fees += tx.fee;
      } else if (DISPUTE.has(cat)) {
        t.disputes += tx.amount; // negative for disputes, positive for reversals
        t.fees += tx.fee;
      } else {
        t.fees += -tx.amount; // separately billed Stripe fees are negative amounts
      }
    }
  }

  const all = [
    ...Object.values(byCurrency).flatMap((c) => [c.total, ...Object.values(c.months), ...Object.values(c.days)]),
    ...Object.values(last30),
    ...Object.values(prev30),
  ];
  for (const t of all) t.net = t.gross + t.refunds + t.disputes - t.fees;

  for (const c of Object.values(byCurrency)) {
    c.months = Object.fromEntries(Object.entries(c.months).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { currencies: byCurrency, last30Days: last30, previous30Days: prev30 };
}

function startOfUtcDay(sec) {
  return sec - (sec % 86400);
}

function emptyDays(startSec) {
  const days = {};
  for (let i = 0; i < DAILY_DAYS; i++) {
    days[new Date((startSec + i * 86400) * 1000).toISOString().slice(0, 10)] = bucket();
  }
  return days;
}

export function formatMoney(minor, currency) {
  const zeroDecimal = new Set(["jpy", "krw", "vnd", "clp", "pyg", "ugx", "xaf", "xof"]);
  const value = zeroDecimal.has(currency) ? minor : minor / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(value);
}
