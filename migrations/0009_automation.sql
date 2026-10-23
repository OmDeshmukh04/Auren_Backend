-- Durable automation: templates, versioned workflows, runs, step executions, delivery ledger,
-- suppressions, provider webhooks, per-record pauses and runner heartbeats.

CREATE TABLE email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_.]{1,80}$'),
  name text NOT NULL,
  description text,
  category text NOT NULL CHECK (category IN ('transactional', 'outreach', 'staff_notification', 'security')),
  -- Variables this template may reference, fixed by the trigger that uses it.
  allowed_variables text[] NOT NULL DEFAULT '{}',
  current_version_id uuid,
  system boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES email_templates (id),
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body_text text NOT NULL,
  created_by uuid REFERENCES staff_members (id),
  published_by uuid REFERENCES staff_members (id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_number),
  UNIQUE (template_id, id)
);
ALTER TABLE email_templates
  ADD CONSTRAINT email_templates_current_fk FOREIGN KEY (id, current_version_id) REFERENCES email_template_versions (template_id, id);

CREATE FUNCTION versioned_content_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION '% rows cannot be deleted after publishing', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RAISE EXCEPTION 'Published % rows are immutable; create a new version', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_template_versions_freeze BEFORE UPDATE OR DELETE ON email_template_versions
  FOR EACH ROW EXECUTE FUNCTION versioned_content_freeze();

CREATE TABLE workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_.]{1,80}$'),
  name text NOT NULL,
  description text,
  category text NOT NULL CHECK (category IN ('transactional', 'follow_up', 'staff', 'scheduled')),
  trigger_event text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  current_version_id uuid,
  status_reason text,
  changed_by uuid REFERENCES staff_members (id),
  changed_at timestamptz,
  system boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR current_version_id IS NOT NULL)
);
CREATE INDEX workflow_definitions_trigger_idx ON workflow_definitions (trigger_event) WHERE enabled;

CREATE TABLE workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflow_definitions (id),
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  definition jsonb NOT NULL,
  change_note text,
  created_by uuid REFERENCES staff_members (id),
  published_by uuid REFERENCES staff_members (id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version_number),
  UNIQUE (workflow_id, id)
);
ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_current_fk FOREIGN KEY (id, current_version_id) REFERENCES workflow_versions (workflow_id, id);
CREATE TRIGGER workflow_versions_freeze BEFORE UPDATE OR DELETE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION versioned_content_freeze();

-- One run per (workflow, enrollment key): repeated event delivery cannot enroll twice.
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  trigger_event_id bigint REFERENCES outbox_events (id),
  enrollment_key text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'failed')),
  context jsonb NOT NULL DEFAULT '{}',
  cancel_reason text,
  cancelled_by uuid REFERENCES staff_members (id),
  cancelled_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, enrollment_key),
  FOREIGN KEY (workflow_id, workflow_version_id) REFERENCES workflow_versions (workflow_id, id)
);
CREATE INDEX workflow_runs_subject_idx ON workflow_runs (subject_type, subject_id) WHERE status = 'active';
CREATE INDEX workflow_runs_workflow_idx ON workflow_runs (workflow_id, started_at DESC);

CREATE TABLE workflow_step_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs (id),
  step_key text NOT NULL,
  step_index smallint NOT NULL,
  action text NOT NULL CHECK (action IN (
    'create_task', 'notify_staff', 'send_email', 'request_information', 'schedule_follow_up', 'generate_draft_presentation'
  )),
  -- awaiting_approval: an external message that staff must approve before it is sent.
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled', 'running', 'awaiting_approval', 'succeeded', 'skipped', 'failed', 'cancelled', 'action_needed'
  )),
  approved_by uuid REFERENCES staff_members (id),
  approved_at timestamptz,
  due_at timestamptz NOT NULL,
  -- When the step is next eligible to run (due_at, or a retry time after a transient failure).
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  subject_revision integer,
  result jsonb NOT NULL DEFAULT '{}',
  skip_reason text,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_key)
);
CREATE INDEX workflow_step_executions_due_idx ON workflow_step_executions (next_attempt_at) WHERE status IN ('scheduled', 'running');
CREATE INDEX workflow_step_executions_attention_idx ON workflow_step_executions (updated_at) WHERE status IN ('action_needed', 'awaiting_approval');

ALTER TABLE tasks
  ADD CONSTRAINT tasks_source_step_fk FOREIGN KEY (source_step_execution_id) REFERENCES workflow_step_executions (id);

-- Permanent delivery ledger. `idempotency_key` is unique forever, so the same logical message
-- is never sent twice by us, independent of the provider's own (time-limited) idempotency.
CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  category text NOT NULL CHECK (category IN ('transactional', 'outreach', 'staff_notification', 'security')),
  template_key text,
  template_version_id uuid REFERENCES email_template_versions (id),
  recipient_type text NOT NULL CHECK (recipient_type IN ('family_contact', 'candidate', 'applicant', 'reference', 'staff', 'other')),
  recipient_id uuid,
  to_address text NOT NULL CHECK (to_address = lower(to_address)),
  subject text NOT NULL,
  -- Rendered content is kept only until the retention job clears it after final delivery.
  body_text text,
  attachments jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sending', 'provider_accepted', 'delivered', 'delayed', 'bounced', 'complained',
    'failed', 'ambiguous', 'cancelled', 'suppressed', 'blocked_by_allowlist'
  )),
  provider text,
  provider_message_id text UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  first_attempt_at timestamptz,
  last_error text,
  step_execution_id uuid REFERENCES workflow_step_executions (id),
  communication_id uuid REFERENCES communications (id),
  accepted_at timestamptz,
  delivered_at timestamptz,
  final_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX deliveries_attention_idx ON deliveries (updated_at) WHERE status IN ('ambiguous', 'failed');
CREATE INDEX deliveries_recipient_idx ON deliveries (recipient_type, recipient_id);

-- At most one attention task per problem delivery.
ALTER TABLE tasks ADD COLUMN delivery_id uuid UNIQUE REFERENCES deliveries (id);

ALTER TABLE communications
  ADD CONSTRAINT communications_delivery_fk FOREIGN KEY (delivery_id) REFERENCES deliveries (id);
ALTER TABLE presentation_releases
  ADD CONSTRAINT presentation_releases_delivery_fk FOREIGN KEY (delivery_id) REFERENCES deliveries (id);
ALTER TABLE reference_contact_attempts
  ADD CONSTRAINT reference_contact_attempts_delivery_fk FOREIGN KEY (delivery_id) REFERENCES deliveries (id);

CREATE TABLE email_suppressions (
  email text PRIMARY KEY CHECK (email = lower(email)),
  -- 'all' blocks every message; 'outreach' blocks optional outreach only (transactional still sends).
  scope text NOT NULL CHECK (scope IN ('all', 'outreach')),
  reason text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribe', 'manual')),
  note text,
  created_by uuid REFERENCES staff_members (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('processed', 'ignored', 'failed')),
  delivery_id uuid REFERENCES deliveries (id),
  detail text,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE automation_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('family', 'enquiry', 'candidate', 'job_order', 'placement')),
  subject_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) >= 3),
  paused_by uuid NOT NULL REFERENCES staff_members (id),
  paused_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid REFERENCES staff_members (id)
);
CREATE UNIQUE INDEX automation_pauses_active_idx ON automation_pauses (subject_type, subject_id) WHERE released_at IS NULL;

CREATE TABLE runner_heartbeats (
  runner_id text PRIMARY KEY,
  last_started_at timestamptz NOT NULL,
  last_finished_at timestamptz,
  last_result jsonb NOT NULL DEFAULT '{}'
);

SELECT attach_updated_at_triggers();
