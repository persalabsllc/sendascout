import "server-only";
import { after } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { platformActivityEmail, type ActivityEmail, type ActivityPayload } from "@/lib/platform-activity-email";
import { claimActivityAlert } from "@/lib/platform-activity-sql";

export function schedulePlatformActivityAlerts() {
  // Isolated from signup/payment results. A provider outage cannot undo them.
  try { after(async () => { await flushPlatformActivityAlerts(); }); }
  catch { console.error("Platform activity scheduling unavailable; cron will process queued alerts"); }
}

export async function flushPlatformActivityAlerts() {
  // Preview/local runs must never email the live operations inbox.
  if (process.env.VERCEL_ENV !== "production") return { skipped: "not_production" };
  if (!process.env.RESEND_API_KEY) { console.error("Platform activity alerts: RESEND_API_KEY is not configured"); return { errors: 1 }; }
  try {
    const db = getDb();
    const expired = await db.execute(sql`UPDATE platform_activity_alerts SET status='failed',error='Provider outcome unknown; safe retry window expired. Check Resend before resending.' WHERE status IN ('pending','processing') AND provider_message_id IS NULL AND first_attempt_at<=now()-interval '23 hours' RETURNING id`);
    if (expired.rows.length) console.error("Platform activity alerts need provider reconciliation", { count: expired.rows.length });
    const candidates = await db.execute<{ id: string; kind: string; payload: ActivityPayload; request_payload: ActivityEmail | null }>(sql`
      SELECT id,kind,payload,request_payload FROM platform_activity_alerts
      WHERE (status='pending' OR (status='processing' AND last_attempt_at<now()-interval '5 minutes'))
        AND provider_message_id IS NULL AND next_attempt_at<=now()
      ORDER BY (kind='mission_launched') DESC,created_at LIMIT 10`);
    let accepted = 0;
    let errors = 0;
    for (const row of candidates.rows) {
      const lease = crypto.randomUUID();
      const request = row.request_payload ?? platformActivityEmail(row.kind, row.payload, process.env.SENDASCOUT_EMAIL_FROM ?? "Send a Scout <alerts@sendascout.com>");
      const claim = await db.execute<{ id: string; request_payload: ActivityEmail }>(claimActivityAlert(row.id, lease, request));
      if (!claim.rows[0]) continue;
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `platform-activity-${row.id}` },
          body: JSON.stringify(claim.rows[0].request_payload), signal: AbortSignal.timeout(15000),
        });
        const result = await response.json().catch(() => null) as { id?: string } | null;
        if (!response.ok || !result?.id) throw new Error(`Email provider did not confirm acceptance (HTTP ${response.status})`);
        await db.execute(sql`UPDATE platform_activity_alerts SET status='accepted',provider_message_id=${result.id},accepted_at=now(),error=NULL WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid`);
        accepted++;
        console.info("Platform activity email accepted", { alertId: row.id, kind: row.kind, providerMessageId: result.id });
      } catch (error) {
        errors++;
        await db.execute(sql`UPDATE platform_activity_alerts SET status='pending',next_attempt_at=now()+interval '5 minutes',error='Email acceptance not confirmed; retry uses the same provider idempotency key.' WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid AND provider_message_id IS NULL`);
        console.error("Platform activity email deferred", { alertId: row.id, error: error instanceof Error ? error.message : "Unknown provider error" });
      }
    }
    return { checked: candidates.rows.length, accepted, errors, expired: expired.rows.length };
  } catch {
    console.error("Platform activity alert worker failed; queued alerts remain recoverable");
    return { errors: 1 };
  }
}
