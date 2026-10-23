-- Foundation: shared trigger functions, agency settings, staff, taxonomies, stage configuration,
-- legal notices, audit trail, transactional outbox, idempotency and rate limiting.

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Rows in immutable tables can never be updated. Deletion is only possible inside an approved
-- retention operation, which sets `auren.retention_override` for its own transaction.
CREATE FUNCTION prevent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('auren.retention_override', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;

-- Attaches set_updated_at to every table that has an updated_at column. Called at the end of
-- each migration that creates such tables.
CREATE FUNCTION attach_updated_at_triggers() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT LIKE 'auth\_%'
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger tr JOIN pg_class cl ON cl.oid = tr.tgrelid
        WHERE cl.relname = c.table_name AND tr.tgname = 'set_updated_at'
      )
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t.table_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------------------------

CREATE TABLE staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth_users (id),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  role text NOT NULL CHECK (role IN ('owner', 'coordinator', 'content_editor', 'finance_viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  timezone text NOT NULL DEFAULT 'America/Denver',
  notification_preferences jsonb NOT NULL DEFAULT '{"dailyDigest": true, "taskAssigned": true}',
  last_sign_in_at timestamptz,
  suspended_at timestamptz,
  suspended_by uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email)),
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'coordinator', 'content_editor', 'finance_viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES staff_members (id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_staff_id uuid REFERENCES staff_members (id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES staff_members (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_invitations_open_email_idx ON staff_invitations (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Agency settings (single agency; one row)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE agency_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  agency_name text NOT NULL DEFAULT 'Auren Households',
  timezone text NOT NULL DEFAULT 'America/Denver',
  default_currency char(3) NOT NULL DEFAULT 'USD' CHECK (default_currency ~ '^[A-Z]{3}$'),
  -- {"mon": [["09:00","17:00"]], ...}; missing day = closed
  business_hours jsonb NOT NULL DEFAULT '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]]}',
  -- External email is not sent inside quiet hours (agency-local); it is deferred to the end.
  quiet_hours jsonb NOT NULL DEFAULT '{"start":"20:00","end":"08:00"}',
  holidays date[] NOT NULL DEFAULT '{}',
  notification_email text,
  reply_to_email text,
  require_staff_mfa boolean NOT NULL DEFAULT false,
  coordinator_scope text NOT NULL DEFAULT 'agency' CHECK (coordinator_scope IN ('agency', 'assigned')),
  draft_expiry_days integer NOT NULL DEFAULT 30 CHECK (draft_expiry_days BETWEEN 1 AND 365),
  draft_form_change_policy text NOT NULL DEFAULT 'keep_version'
    CHECK (draft_form_change_policy IN ('keep_version', 'migrate_on_resume')),
  automation_paused boolean NOT NULL DEFAULT false,
  automation_paused_reason text,
  automation_paused_by uuid REFERENCES staff_members (id),
  automation_paused_at timestamptz,
  -- A scheduled external message more than this many hours overdue is skipped, not sent.
  stale_message_hours integer NOT NULL DEFAULT 48 CHECK (stale_message_hours BETWEEN 1 AND 720),
  daily_digest_time time NOT NULL DEFAULT '08:00',
  upload_max_bytes integer NOT NULL DEFAULT 10485760 CHECK (upload_max_bytes BETWEEN 1024 AND 52428800),
  allowed_upload_types text[] NOT NULL DEFAULT '{pdf,docx,jpg,png}'
    CHECK (allowed_upload_types <@ ARRAY['pdf', 'docx', 'jpg', 'png']),
  branding jsonb NOT NULL DEFAULT '{}',
  seo_defaults jsonb NOT NULL DEFAULT '{}',
  accepting_submissions boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO agency_settings (id) VALUES (1);

-- ---------------------------------------------------------------------------------------------
-- Taxonomies. Keys are stable identifiers referenced by records; labels and order are editable.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE service_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  label text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qualification_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  label text NOT NULL,
  category text NOT NULL CHECK (category IN ('certification', 'training', 'license', 'education')),
  has_expiry boolean NOT NULL DEFAULT false,
  requires_review boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skills (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  label text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Status dimensions are fixed by the domain model (their keys carry meaning for gates and
-- reports). Owners configure labels, order and whether a key is offered.
CREATE TABLE stage_definitions (
  dimension text NOT NULL CHECK (dimension IN (
    'candidate_recruitment', 'candidate_availability', 'candidate_job', 'screening_check',
    'enquiry', 'family_relationship', 'job_order', 'placement'
  )),
  key text NOT NULL,
  label text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  -- Required keys are used by intake, gates or reporting and cannot be deactivated.
  required boolean NOT NULL DEFAULT false,
  is_terminal boolean NOT NULL DEFAULT false,
  -- false = reachable only through a domain command (e.g. "presented" only by a release),
  -- never through a generic stage change.
  manual_entry boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dimension, key),
  CHECK (active OR NOT required)
);

CREATE TABLE stage_transition_rules (
  dimension text NOT NULL,
  from_key text NOT NULL,
  to_key text NOT NULL,
  PRIMARY KEY (dimension, from_key, to_key),
  FOREIGN KEY (dimension, from_key) REFERENCES stage_definitions (dimension, key),
  FOREIGN KEY (dimension, to_key) REFERENCES stage_definitions (dimension, key),
  CHECK (from_key <> to_key)
);

-- History of every status change across dimensions; reports are reproduced from this table.
CREATE TABLE stage_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dimension text NOT NULL,
  subject_id uuid NOT NULL,
  from_key text,
  to_key text NOT NULL,
  reason text,
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'applicant', 'public', 'system')),
  actor_staff_id uuid REFERENCES staff_members (id),
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_transitions_subject_idx ON stage_transitions (dimension, subject_id, occurred_at);
CREATE INDEX stage_transitions_reporting_idx ON stage_transitions (dimension, to_key, occurred_at);
CREATE TRIGGER stage_transitions_immutable BEFORE UPDATE OR DELETE ON stage_transitions
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ---------------------------------------------------------------------------------------------
-- Legal notices (versioned text that consents are recorded against)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE legal_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_key text NOT NULL CHECK (notice_key IN (
    'privacy_notice', 'application_terms', 'reference_authorization', 'background_authorization',
    'marketing_consent', 'presentation_sharing', 'family_terms'
  )),
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9._-]{1,40}$'),
  title text NOT NULL,
  body_markdown text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  published_at timestamptz,
  published_by uuid REFERENCES staff_members (id),
  created_by uuid REFERENCES staff_members (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notice_key, version)
);
CREATE UNIQUE INDEX legal_notices_one_published_idx ON legal_notices (notice_key) WHERE status = 'published';

CREATE FUNCTION legal_notice_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.body_markdown IS DISTINCT FROM OLD.body_markdown
      OR NEW.title IS DISTINCT FROM OLD.title OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.notice_key IS DISTINCT FROM OLD.notice_key) THEN
    RAISE EXCEPTION 'A published legal notice cannot be edited; create a new version' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legal_notices_freeze BEFORE UPDATE ON legal_notices FOR EACH ROW EXECUTE FUNCTION legal_notice_freeze();

-- ---------------------------------------------------------------------------------------------
-- Audit trail (append-only). Metadata holds field names and ids, never sensitive values.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'applicant', 'public', 'system', 'provider')),
  actor_staff_id uuid REFERENCES staff_members (id),
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text,
  request_id text,
  ip_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_subject_idx ON audit_events (subject_type, subject_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_staff_id, occurred_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, occurred_at DESC);
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ---------------------------------------------------------------------------------------------
-- Transactional outbox. Domain transactions insert events alongside business rows; the runner
-- claims them with SKIP LOCKED. Payloads carry ids and revisions, not personal data.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  actor_type text NOT NULL DEFAULT 'system',
  actor_staff_id uuid REFERENCES staff_members (id),
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  processed_at timestamptz,
  last_error text
);
CREATE INDEX outbox_events_due_idx ON outbox_events (available_at, id) WHERE status IN ('pending', 'processing');
CREATE INDEX outbox_events_subject_idx ON outbox_events (subject_type, subject_id, occurred_at);

-- ---------------------------------------------------------------------------------------------
-- Idempotency keys for repeatable commands. The row is written in the same transaction as the
-- command, so a concurrent duplicate waits on the unique key and then replays the response.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- Fixed-window request counters shared by every API instance.
CREATE TABLE rate_limit_buckets (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limit_buckets_window_idx ON rate_limit_buckets (window_start);

SELECT attach_updated_at_triggers();
