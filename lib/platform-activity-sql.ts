import { sql } from "drizzle-orm";
import type { ActivityEmail } from "./platform-activity-email.ts";

export function claimActivityAlert(id: string, lease: string, request: ActivityEmail) {
  return sql`UPDATE platform_activity_alerts
    SET status='processing', lease_token=${lease}::uuid,
      request_payload=COALESCE(request_payload,${JSON.stringify(request)}::jsonb),
      first_attempt_at=COALESCE(first_attempt_at,now()), last_attempt_at=now()
    WHERE id=${id}::uuid AND provider_message_id IS NULL
      AND next_attempt_at<=now()
      AND (status='pending' OR (status='processing' AND last_attempt_at<now()-interval '5 minutes'))
      AND (first_attempt_at IS NULL OR first_attempt_at>now()-interval '23 hours')
    RETURNING id,request_payload`;
}
