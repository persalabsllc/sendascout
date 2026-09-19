# See It product rollout

The public entry point is `/request`. Five versioned packages share a contract across ordering, Scout checklists, and PDF reports. Existing booked missions with a null `see_template_key` retain their original pricing and workflow. Reorders are reviewed as new packages at current prices.

## Prices and fulfillment

| Product | Standard customer price | Starting Scout offer | Default cap |
|---|---:|---:|---:|
| Property, Purchase, Project, Custom | $39 | $22 | $34 |
| Vehicle | $49 | $28 | $44 |

Standard targets 72 hours from funding. A customer can specify a target 12 hours to 14 days from ordering. The assignment cutoff is four hours before that target. Priority adds $20 to the price and $10 to starting Scout pay, and targets 24 hours; it is offered only for exact five-digit ZIPs in the optional `SEE_IT_PRIORITY_ZIPS` comma-separated environment variable. With no configuration, Priority is unavailable.

The authenticated `/api/cron/see-it` job runs every five minutes using the existing `CRON_SECRET`. It adds $4 to the starting offer at one-third of the funded window, $8 at two-thirds, and $12 at five-sixths, capped per mission. The customer price does not change. A missed worker interval jumps directly to the currently due tier. Offers never decrease. Claiming records the accepted payout in the same atomic claim operation. Existing Scout identity, handbook, payment readiness, and travel preferences still apply.

Offer changes lock the mission and paid booking allocation, reject refunds/disputes/transfer records or mismatched funding, update both balances, and insert an offer audit atomically. No Stripe charge or transfer is created by an offer increase. Normal settlement still reconciles the paid allocations before transferring the Scout amount.

Notifications expand from 10 to 25 to 50 miles alongside the first two deadline tiers, always respecting the Scout's own travel radius and readiness. Public mission pages allow anyone to review safe assignment details at `/missions/[id]`; exact addresses, customer-written instructions, and contacts are not public. Existing Scouts may still browse other eligible missions within their own radius.

At cutoff, only a paid, open, unassigned mission is cancelled. `see_expired_at` is a durable refund intent, retried with a stable idempotency key. Claimed or traveling missions are never automatically cancelled by this job. Control Room highlights overdue assigned work for follow-up. Refund failures remain visible through payment status and server logs and must be reconciled.

## Operator controls

`/control-room/see-it` shows supply counts, offers and caps, deadlines, recruiting links and copy, report review, and progress toward 100 completed paid missions in 25 city/state markets. Supply distance is approximate, using ZIP centers. Gross price less Scout payout excludes payment processing, refunds, support, and acquisition costs.

Operators can pause a mission's increases, adjust its cap within the funded customer price and above its current offer, and record recruiting notes. `SEE_IT_BOOSTS_PAUSED=true` pauses all increases without stopping expiry refunds or report processing. Recruitment is a human workflow; the application does not buy ads or post to communities automatically.

## Evidence and reports

The mission stores a snapshot of the selected template/version, questions, access instructions, pricing, and window. Scouts capture named photo/video slots and written answers. Photo files are limited to 10 MB, videos to 50 MB, and the submission total to 250 MB. Each file belongs to one checklist slot. A vehicle wheel slot requires four views unless a limitation is documented. Uploads and draft answers are saved before final submission and can be resumed.

An unavailable checklist item requires an explanation. Submission atomically writes the evidence, answers, result, and immutable report snapshot and advances the report revision. A duplicate or stale submission cannot create another revision. PDF generation validates and embeds readable photos, labels evidence, records visit details and verification limits, and links to authenticated online video. File/device time is not represented as independently verified capture time.

Complete reports become ready after PDF preparation. Missing evidence puts the report into operations review. Failed PDF preparation is retried up to five attempts; operators can retry or request correction. Releasing a reviewed report starts the customer review window. Requesting correction returns the assigned Scout to the checklist and preserves the previous report snapshot. Corrected submission creates another revision.

Customer confirmation and the hourly automatic completion query require a ready report. Automatic completion waits 24 hours after report release. An open mission case continues to block the existing lifecycle and settlement safeguards. PDFs and original evidence require participant or administrator authorization. The public `/sample-report` is generated by the same layout using explicitly fictional data and illustrations.

## Deployment and verification

Migration `0019_see_it_products.sql` is additive and was deployed before the feature code. Production's existing build script backs up the schema and applies pending migrations before building. Roll back application code if necessary; do not drop the new tables or rewrite migration history.

Run `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build`. Database tests apply every migration in PGlite/PostgreSQL, execute the actual payout and submission SQL, verify idempotency, reject invalid funding and expired claims, and force an audit failure to verify rollback of both financial balances. Existing legacy and Stripe safety tests remain part of the suite.
