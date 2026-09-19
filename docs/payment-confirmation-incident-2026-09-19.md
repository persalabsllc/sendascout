# Booking confirmation recovery — September 19, 2026

## Confirmed cause

Production received `checkout.session.completed` and `payment_intent.succeeded`, but the atomic payment/publication statement failed with PostgreSQL `42804`: `preferred_scout_exclusive_until` is a timestamp while its `CASE` expression resolved to text. Both date-or-null expressions now explicitly cast to `timestamptz`.

Two separate presentation issues concealed the cause: every draft was called “Pulled” / “Paused by support,” and a newly created PaymentIntent awaiting its first payment method was classified as failed even without a provider error.

## Recovery and safeguards

- Signed webhooks still validate and apply success through the existing atomic ledger/publication statement.
- PaymentIntent events retrieve current Stripe state instead of trusting delivery order.
- A prior paid timestamp prevents a replay from reopening a funded support hold.
- Customer checkout return reconciles only a session matched to that customer's ledger. Customer and admin actions check existing Stripe objects without creating a checkout or charging a card.
- The existing authenticated five-minute worker checks up to 25 unsettled, recent booking payments on unarchived drafts; cancelled/archive recovery policy is unchanged.
- Session/intent/customer/mission/kind/amount/currency/mode/transfer-group identity must match before success is applied. Existing late-payment and dispute rules remain in force.
- Control Room exposes payment state, failed-success-webhook warnings, blocking reasons, ledger/Stripe references, “Check Stripe,” and new mission/payment issue counts. Reopen is offered only for paid drafts.
- Webhook failures create operational alerts with the root error code rather than SQL or payment parameters. Customer billing actions no longer squeeze into the generic 20-pixel arrow column.

## Verification

- The production SQL, executed with all migrations in PGlite PostgreSQL, reproduced the exact production error before the fix and passes afterward.
- Database tests cover failed-ledger recovery, deadlines, idempotency, legacy missions, support holds, cancelled/disputed/archived missions, and audit-failure rollback.
- Recovery service tests cover ownership, provider identity/mode/amount mismatches, no duplicate charge/create path, pending results, publication errors, and failed-webhook visibility.
- 261 automated tests passed; Next.js production build, TypeScript and targeted ESLint passed.

## Operator check

Refresh Control Room. A recovered booking should show Payment: Paid and mission Open. The customer should see Collected $39 and an open mission. If confirmation remains delayed, use **Check Stripe** on the existing booking, not another checkout or a manual paid flag. Inspect operational alerts on failure.

Live recovery must be confirmed separately in runtime logs or the authenticated mission record; test success alone is not proof of an individual production recovery.
