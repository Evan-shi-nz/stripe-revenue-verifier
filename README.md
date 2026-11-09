# stripe-revenue-verifier

Check, by yourself, that the revenue a founder publishes is real.

The founder publishes a Stripe **restricted key that can only read their balance**. This script uses that key to read the numbers straight from Stripe, so you don't have to trust the website.

```bash
git clone https://github.com/Evan-shi-nz/stripe-revenue-verifier
cd stripe-revenue-verifier
node verify.mjs rk_live_xxx
```

Compare with what the website shows:

```bash
node verify.mjs rk_live_xxx --compare https://<site>/api/revenue
```

No dependencies, Node 18+. The script makes GET requests only. Read `verify.mjs` and `revenue.mjs` before you run it; together they are about 200 lines.

## What it checks

1. **The key cannot read customer data.** It asks Stripe for charges, customers, payment intents, invoices and checkout sessions and expects every request to be refused. If any succeeds, it stops and warns you: that key should never have been made public.
2. **The account is live.** It reads `/v1/balance` and prints `livemode`.
3. **Revenue.** It reads every balance transaction and adds them up per currency:

| Line | Stripe `reporting_category` |
|---|---|
| gross | `charge` |
| refunds | `refund`, `partial_capture_reversal` |
| disputes | `dispute`, `dispute_reversal` |
| fees | the `fee` on each of the above, plus `fee` transactions |
| net | gross + refunds + disputes − fees |

Payouts, transfers and top-ups are money movement, not revenue, and are ignored.

## For founders: create the key

1. Stripe Dashboard → **Developers → API keys → Create restricted key**.
2. Set **Balance → Read**. Leave everything else at **None**.
3. Run `node verify.mjs rk_live_xxx` yourself. Step 1 must show every line as `refused`.
4. Look at what a holder of the key can see (`curl https://api.stripe.com/v1/balance_transactions -u rk_live_xxx:`). Each transaction has a `description`. If your integration writes customer names or emails there, don't publish the key.
5. Publish the key on your site. Don't commit it to a public Git repository: GitHub's secret scanning reports Stripe keys to Stripe, which may revoke it. Put it in your hosting provider's environment variables instead.

## What this does not prove

- That every payment came from a real, unrelated customer. Someone could pay themselves, although Stripe fees make that expensive.
- Which product the money came from. A balance-only key cannot see products, which is the point.
- Costs or profit.

## Test

```bash
node test.mjs
```

MIT License.
