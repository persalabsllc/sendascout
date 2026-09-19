# Send a Scout outreach CRM

Admin-only UI: `/control-room/outreach`. Existing Resend notification rules are unchanged.

## Google Workspace connection

Create an OAuth Web application in a Google Cloud project owned by the Send a Scout Workspace organization. Enable Gmail API. Configure the app as Internal when eligible, otherwise complete Google's applicable verification. Request only `gmail.send` and `gmail.readonly`; the latter is needed for reply metadata checks and searching Sent mail to reconcile uncertain sends. The app does not delete or change mail.

Authorized redirect URI: `https://www.sendascout.com/api/outreach/google/callback`

Set these server-only Production environment variables and redeploy:

- `OUTREACH_GOOGLE_CLIENT_ID`
- `OUTREACH_GOOGLE_CLIENT_SECRET`
- `OUTREACH_TOKEN_KEY`: 32 cryptographically random bytes represented as 64 hexadecimal characters. Keep this key stable and backed up securely; changing it requires reconnecting the mailbox.
- `OUTREACH_GOOGLE_MAILBOX`: defaults to `support@sendascout.com`. Must be the actual Google mailbox identity, not merely an alias or Google Group.

Then an authorized Control Room administrator selects Connect Google Workspace and grants consent in Google. OAuth state is single-use, ten-minute, cookie- and administrator-bound with PKCE. Refresh tokens are encrypted with AES-256-GCM; no tokens are returned to the client or logged. Disconnect removes the stored token and pauses sending. The administrator can additionally revoke the app under Google Account permissions.

Save a valid Send a Scout postal address. Sending starts paused, at ten approved messages per weekday. Imported prospects are research-only. A documented request or opt-in is required before queueing. These controls implement an allowed requested/permission-based workflow; they are not a workaround for Google's prohibition on unsolicited mass email. Sources and personalization alone are not consent.

## Daily workflow

Add a business or paste up to 100 CSV rows. Columns: `company,email,contactName,segment,website,location,researchNote,sourceUrl,notes`. Segments: property, vehicle, project, purchase, custom. Existing normalized email addresses are skipped; imports never change suppression or permission.

Drafting combines the saved verified opening line with the relevant See It offer. It is a deterministic drafting aid, not an AI web research service. Review factual claims, save any edits, then explicitly approve the saved draft. Queueing never bypasses recorded contact permission. Changing prospect details cancels queued messages for fresh review.

Cron `/api/cron/outreach` runs every five minutes, protected by CRON_SECRET. It syncs replies even while sending is paused. A global lease serializes workers, including manual checks. Sends are production-only, Monday–Friday 09:00–17:00 America/New_York, one per invocation, subject to the atomic daily attempt cap. Each initial email can have one explicitly reviewed follow-up, at least three days later. A fresh thread check is mandatory immediately before a follow-up. Any incoming response, including an automatic response, stops follow-ups for review. Purchases, suppression, closed or interested stages also block sending.

Gmail provider acceptance is distinct from inbox delivery. No open tracking is used. Gmail does not support a send idempotency key; uncertain outcomes are never automatically resent. The worker searches Sent mail by deterministic RFC Message-ID, and pauses sending after an uncertain result. Review unmatched unknown records in Gmail before deciding whether any new message is appropriate.

Unsubscribe GET renders confirmation; POST suppresses outreach and cancels pending drafts/queued messages. One-click unsubscribe uses POST on that same opaque-token URL. Mission and account emails are unaffected. Suppression cannot be cleared by imports or ordinary stage changes. An already in-flight provider request cannot be recalled.

Paid booking matches use the prospect email or explicitly linked customer ID. Dashboard revenue includes paid/partially refunded bookings after an accepted outreach email, less refunds, before Scout compensation and other costs. It is matched account activity, not causal attribution. Prospect detail also shows earlier matching purchases. All purchases stop prospecting sends.

## Validation and remaining integrations

Automated tests cover migrations, permission and suppression gates, exclusive claiming, daily caps, conversions, follow-up reply gates, encryption, CSV normalization, headers, and mocked Gmail failure/reply handling. Live sending and reply sync require the Google OAuth setup and mailbox authorization above. No production prospects or emails are seeded. Automated prospect discovery and AI research are not enabled in this version.
