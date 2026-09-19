ALTER TABLE missions
  ADD COLUMN see_template_key text,
  ADD COLUMN see_template_snapshot jsonb,
  ADD COLUMN see_service_level text,
  ADD COLUMN see_window_hours integer,
  ADD COLUMN see_earliest_visit_at timestamptz,
  ADD COLUMN see_deadline_at timestamptz,
  ADD COLUMN see_assignment_cutoff_at timestamptz,
  ADD COLUMN see_funded_at timestamptz,
  ADD COLUMN see_base_payout_cents integer,
  ADD COLUMN see_payout_cap_cents integer,
  ADD COLUMN see_accepted_payout_cents integer,
  ADD COLUMN see_boost_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN see_offer_version integer NOT NULL DEFAULT 0,
  ADD COLUMN see_expired_at timestamptz,
  ADD COLUMN see_report_status text,
  ADD COLUMN see_report_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN see_report_released_at timestamptz;
--> statement-breakpoint
ALTER TABLE missions DROP CONSTRAINT missions_result_upload_token_count_check;
--> statement-breakpoint
ALTER TABLE missions ADD CONSTRAINT missions_result_upload_token_count_check CHECK (result_upload_token_count >= 0 AND result_upload_token_count <= 150);
--> statement-breakpoint
ALTER TABLE missions ADD CONSTRAINT missions_see_contract_check CHECK (
  see_template_key IS NULL OR (
    type = 'see' AND bundle_id IS NULL AND see_template_snapshot IS NOT NULL
    AND see_template_key IN ('property','vehicle','purchase','project','custom')
    AND see_service_level IS NOT NULL AND see_window_hours IS NOT NULL
    AND see_base_payout_cents IS NOT NULL AND see_payout_cap_cents IS NOT NULL
    AND see_service_level IN ('standard', 'priority') AND see_window_hours IN (24, 72)
    AND see_base_payout_cents >= 0 AND see_payout_cap_cents >= see_base_payout_cents
    AND see_payout_cap_cents <= customer_price_cents AND see_offer_version >= 0
    AND (see_accepted_payout_cents IS NULL OR see_accepted_payout_cents >= 0)
  )
);
--> statement-breakpoint
CREATE INDEX missions_see_open_deadline_idx ON missions(see_assignment_cutoff_at) WHERE see_template_key IS NOT NULL AND status = 'open';
--> statement-breakpoint
ALTER TABLE mission_checklist_items ADD COLUMN task_key text, ADD COLUMN guidance text, ADD COLUMN unavailable_reason text;
--> statement-breakpoint
CREATE TABLE see_mission_drafts (
  mission_id uuid PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  scout_id uuid NOT NULL REFERENCES users(id),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE see_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','review','correction','failed')),
  snapshot jsonb NOT NULL,
  storage_path text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  reviewed_by uuid REFERENCES users(id),
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(mission_id, revision)
);
--> statement-breakpoint
CREATE TABLE see_offer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  version integer NOT NULL,
  previous_cents integer NOT NULL,
  offered_cents integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(mission_id, version)
);
