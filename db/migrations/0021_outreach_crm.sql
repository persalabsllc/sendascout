CREATE TABLE outreach_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK(id=1),
  paused boolean NOT NULL DEFAULT true,
  daily_limit integer NOT NULL DEFAULT 10 CHECK(daily_limit BETWEEN 1 AND 40),
  postal_address text NOT NULL DEFAULT '',
  mailbox text,
  refresh_token_encrypted text,
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO outreach_settings(id) VALUES(1);
--> statement-breakpoint
CREATE TABLE outreach_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  contact_name text NOT NULL DEFAULT '',
  email text NOT NULL UNIQUE CHECK(email=lower(trim(email))),
  website text NOT NULL DEFAULT '',
  segment text NOT NULL CHECK(segment IN ('property','vehicle','project','purchase','custom')),
  location text NOT NULL DEFAULT '',
  research_note text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  stage text NOT NULL DEFAULT 'new' CHECK(stage IN ('new','contacted','replied','interested','customer','closed','unsubscribed')),
  permission text NOT NULL DEFAULT 'research_only' CHECK(permission IN ('research_only','requested','opt_in')),
  permission_note text NOT NULL DEFAULT '',
  permission_recorded_at timestamptz,
  suppressed_at timestamptz,
  suppression_reason text,
  unsubscribe_token text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text,'-',''),
  linked_customer_id uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX outreach_prospects_stage_idx ON outreach_prospects(stage,created_at);
--> statement-breakpoint
CREATE TABLE outreach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES outreach_prospects(id),
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','sending','accepted','replied','failed','unknown','cancelled')),
  followup_of uuid REFERENCES outreach_messages(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  scheduled_at timestamptz,
  attempted_at timestamptz,
  accepted_at timestamptz,
  reply_at timestamptz,
  last_checked_at timestamptz,
  google_message_id text UNIQUE,
  google_thread_id text,
  wire_message_id text NOT NULL UNIQUE,
  raw_payload text,
  sender_mailbox text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX outreach_one_followup_idx ON outreach_messages(followup_of) WHERE followup_of IS NOT NULL;
--> statement-breakpoint
CREATE INDEX outreach_messages_queue_idx ON outreach_messages(status,scheduled_at);
--> statement-breakpoint
CREATE UNIQUE INDEX outreach_one_active_send_idx ON outreach_messages(prospect_id) WHERE status IN ('queued','sending','unknown');
--> statement-breakpoint
CREATE TABLE outreach_oauth_states (
  state_hash text PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES users(id),
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);
