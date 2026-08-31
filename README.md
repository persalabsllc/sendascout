# Send a Scout

Your trusted local presence, on demand.

This repository contains the public website and onboarding platform for Send a Scout, a U.S. marketplace connecting customers with vetted local people who can inspect, move, meet, or wait on their behalf.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

The application is designed for deployment on Vercel. Database migrations are intentionally separate from the build so preview or concurrent builds cannot mutate production data.

For a production release, run the migration for the exact commit being deployed before promoting that commit:

```bash
DATABASE_URL=... npm run db:migrate
npm run build
```

The migration runner validates that the database ledger is a contiguous, hash-matching prefix of the repository, performs Stripe-ledger preflight checks, and applies all pending migrations atomically.

## Stripe Connect launch controls

Stripe Connect uses separate event destinations because Stripe assigns one payload format and signing secret to each destination. Configure a snapshot destination for connected-account `payout.*` and `balance_settings.updated` events with `STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET`, and a thin destination for Accounts v2 events with `STRIPE_CONNECT_THIN_WEBHOOK_SECRET`. Both destinations can target `/api/webhooks/stripe/connect`.

Scout earnings remain in the platform balance until the application initiates their Stripe Transfer on Friday UTC. Immediately before every new Transfer, the worker retrieves the connected account's current Balance Settings and requires payouts to be enabled on an exact weekly-Friday schedule. A non-Friday attempt stays pending until the next Friday UTC; a schedule mismatch fails closed and clears cached schedule readiness. Friday UTC controls Transfer request initiation, while external-bank arrival still follows Stripe's funds-availability and payout timing.

Before enabling live transfers, apply and verify these controls in both Stripe sandbox and live mode:

- In **Connect → Express Dashboard → Features**, disable connected accounts' ability to change their payout schedule and to create manual payouts.
- Do not enable Instant Payouts or any workflow that changes the account to a manual payout schedule.
- Keep automatic payouts set to weekly on Friday, subscribe the connected snapshot destination to `balance_settings.updated`, and verify that a test connected account cannot change the schedule or manually pay itself out.
- Treat the application Friday-UTC gate and authoritative API check as required controls; Dashboard configuration is an additional defense against out-of-band payout changes.
