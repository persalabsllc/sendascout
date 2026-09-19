CREATE TABLE platform_activity_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('mission_launched','scout_signup','customer_created','alerts_enabled')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','accepted','failed','ignored')),
  request_payload jsonb,
  provider_message_id text,
  lease_token uuid,
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX platform_activity_alerts_pending_idx ON platform_activity_alerts(status,next_attempt_at);
--> statement-breakpoint
-- Suppress historical launches, even if an older funded mission is reopened.
INSERT INTO platform_activity_alerts(event_key,kind,payload,status)
SELECT 'mission_launched:' || id, 'mission_launched', '{}', 'ignored'
FROM missions WHERE payment_status IN ('paid','partially_refunded','refunded','disputed')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION queue_platform_account_alert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_kind := CASE NEW.role WHEN 'customer' THEN 'customer_created' WHEN 'scout' THEN 'scout_signup' ELSE NULL END;
  ELSIF NEW.role = 'scout' AND OLD.role <> 'scout' THEN
    event_kind := 'scout_signup';
  END IF;
  IF event_kind IS NOT NULL THEN
    INSERT INTO platform_activity_alerts(event_key,kind,payload)
    VALUES(event_kind || ':' || NEW.id, event_kind, jsonb_build_object(
      'userId', NEW.id, 'name', concat_ws(' ',NEW.first_name,NEW.last_name),
      'email',NEW.email,'phone',NEW.phone,'createdAt',now(),
      'location',concat_ws(', ',NEW.city,NEW.state,NEW.zip)))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER platform_account_alert AFTER INSERT OR UPDATE OF role ON users
FOR EACH ROW EXECUTE FUNCTION queue_platform_account_alert();
--> statement-breakpoint
CREATE FUNCTION queue_platform_mission_alert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'open' AND NEW.payment_status = 'paid' AND NEW.archived_at IS NULL
     AND (NEW.bundle_id IS NULL OR NEW.bundle_sequence = 1) THEN
    INSERT INTO platform_activity_alerts(event_key,kind,payload)
    SELECT 'mission_launched:' || NEW.id, 'mission_launched', jsonb_build_object(
      'missionId',NEW.id,'title',NEW.title,'missionType',NEW.type,
      'address',concat_ws(', ',NEW.address_line_1,NEW.address_line_2,NEW.city,NEW.state,NEW.zip),
      'location',concat_ws(', ',NEW.city,NEW.state,NEW.zip),
      'name',concat_ws(' ',customer.first_name,customer.last_name),'email',customer.email,'phone',customer.phone,
      'customerPriceCents',COALESCE(bundle.customer_price_cents,NEW.customer_price_cents),
      'scoutPayoutCents',COALESCE(bundle.scout_payout_cents,NEW.scout_payout_cents),
      'deadline',NEW.see_deadline_at,'assignmentCutoff',NEW.see_assignment_cutoff_at,
      'scheduledFor',NEW.scheduled_for,'timeZone',NEW.timezone,
      'instructions',left(NEW.instructions,3000),'createdAt',now())
    FROM users AS customer LEFT JOIN mission_bundles AS bundle ON bundle.id = NEW.bundle_id
    WHERE customer.id = NEW.customer_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER platform_mission_alert AFTER INSERT OR UPDATE OF status,payment_status ON missions
FOR EACH ROW EXECUTE FUNCTION queue_platform_mission_alert();
--> statement-breakpoint
INSERT INTO platform_activity_alerts(event_key,kind,payload)
VALUES('platform_activity_alerts:enabled:v1','alerts_enabled','{}');
