-- Candidate presentations, appointments, consultations, tasks, notes and communication history.

-- ---------------------------------------------------------------------------------------------
-- Presentations: draft -> approved immutable snapshot (with PDF) -> release to an authorized
-- family recipient. Only snapshot content is ever delivered; never a live candidate record.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE presentations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  job_order_id uuid NOT NULL,
  family_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'released', 'cancelled')),
  recipient_contact_id uuid REFERENCES family_contacts (id),
  title text NOT NULL,
  cover_note text,
  latest_snapshot_id uuid,
  created_by uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_order_id, family_id) REFERENCES job_orders (id, family_id),
  UNIQUE (id, job_order_id)
);
CREATE INDEX presentations_job_idx ON presentations (job_order_id);

CREATE TABLE presentation_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  presentation_id uuid NOT NULL,
  job_order_id uuid NOT NULL,
  job_candidate_id uuid NOT NULL,
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  -- Default-deny whitelist of profile fields to include (see presentation field catalogue).
  included_fields text[] NOT NULL DEFAULT '{}',
  -- Staff-written text for this family: introduction, rationale, availability/compensation wording.
  overrides jsonb NOT NULL DEFAULT '{}',
  sharing_permission_consent_id uuid REFERENCES consents (id),
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (presentation_id, candidate_id),
  FOREIGN KEY (presentation_id, job_order_id) REFERENCES presentations (id, job_order_id) ON DELETE CASCADE,
  FOREIGN KEY (job_candidate_id, job_order_id, candidate_id) REFERENCES job_candidates (id, job_order_id, candidate_id)
);

CREATE TABLE presentation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  presentation_id uuid NOT NULL REFERENCES presentations (id),
  version_number integer NOT NULL CHECK (version_number > 0),
  content jsonb NOT NULL,
  content_sha256 text NOT NULL,
  field_selection jsonb NOT NULL,
  eligibility jsonb NOT NULL,
  pdf_document_id uuid REFERENCES documents (id),
  pdf_sha256 text,
  approved_by uuid NOT NULL REFERENCES staff_members (id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (presentation_id, version_number),
  UNIQUE (presentation_id, id)
);
CREATE TRIGGER presentation_snapshots_immutable BEFORE UPDATE OR DELETE ON presentation_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
ALTER TABLE presentations
  ADD CONSTRAINT presentations_latest_snapshot_fk FOREIGN KEY (id, latest_snapshot_id) REFERENCES presentation_snapshots (presentation_id, id);

CREATE TABLE presentation_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  presentation_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  recipient_contact_id uuid NOT NULL REFERENCES family_contacts (id),
  recipient_email text NOT NULL CHECK (recipient_email = lower(recipient_email)),
  released_by uuid NOT NULL REFERENCES staff_members (id),
  released_at timestamptz NOT NULL DEFAULT now(),
  recipient_confirmed boolean NOT NULL CHECK (recipient_confirmed),
  no_revocation_acknowledged boolean NOT NULL CHECK (no_revocation_acknowledged),
  eligibility jsonb NOT NULL,
  delivery_id uuid,
  FOREIGN KEY (presentation_id, snapshot_id) REFERENCES presentation_snapshots (presentation_id, id)
);
CREATE INDEX presentation_releases_presentation_idx ON presentation_releases (presentation_id);
CREATE TRIGGER presentation_releases_immutable BEFORE DELETE ON presentation_releases
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ---------------------------------------------------------------------------------------------
-- Appointments. `revision` increments on every reschedule or cancellation so reminders
-- scheduled for an older revision are recognised as stale and never sent.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('consultation', 'candidate_interview', 'family_interview', 'trial', 'check_in', 'other')),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  location_type text NOT NULL DEFAULT 'video' CHECK (location_type IN ('in_person', 'video', 'phone')),
  location_detail text,
  organizer_staff_id uuid REFERENCES staff_members (id),
  family_id uuid REFERENCES families (id),
  enquiry_id uuid REFERENCES enquiries (id),
  candidate_id uuid REFERENCES candidates (id),
  job_order_id uuid REFERENCES job_orders (id),
  job_candidate_id uuid REFERENCES job_candidates (id),
  revision integer NOT NULL DEFAULT 1,
  cancelled_reason text,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (num_nonnulls(family_id, candidate_id) >= 1)
);
CREATE INDEX appointments_time_idx ON appointments (starts_at) WHERE status = 'scheduled';
CREATE INDEX appointments_family_idx ON appointments (family_id);
CREATE INDEX appointments_candidate_idx ON appointments (candidate_id);

CREATE TABLE appointment_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id uuid NOT NULL REFERENCES appointments (id),
  revision integer NOT NULL,
  change text NOT NULL CHECK (change IN ('created', 'rescheduled', 'cancelled', 'completed', 'no_show', 'updated')),
  previous_starts_at timestamptz,
  previous_ends_at timestamptz,
  reason text,
  actor_staff_id uuid REFERENCES staff_members (id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER appointment_changes_immutable BEFORE UPDATE OR DELETE ON appointment_changes
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

ALTER TABLE interviews
  ADD CONSTRAINT interviews_appointment_fk FOREIGN KEY (appointment_id) REFERENCES appointments (id);

CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families (id),
  enquiry_id uuid REFERENCES enquiries (id),
  appointment_id uuid UNIQUE REFERENCES appointments (id),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  outcome text CHECK (outcome IN ('proceed', 'follow_up', 'not_proceeding')),
  summary text,
  completed_at timestamptz,
  recorded_by uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX consultations_family_idx ON consultations (family_id);
CREATE INDEX consultations_enquiry_idx ON consultations (enquiry_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text,
  kind text NOT NULL DEFAULT 'general' CHECK (kind IN (
    'general', 'follow_up', 'review', 'action_needed', 'feedback', 'check_in', 'renewal', 'reconcile'
  )),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_at timestamptz,
  assigned_staff_id uuid REFERENCES staff_members (id),
  family_id uuid REFERENCES families (id),
  enquiry_id uuid REFERENCES enquiries (id),
  candidate_id uuid REFERENCES candidates (id),
  job_order_id uuid REFERENCES job_orders (id),
  job_candidate_id uuid REFERENCES job_candidates (id),
  placement_id uuid REFERENCES placements (id),
  presentation_id uuid REFERENCES presentations (id),
  reference_id uuid REFERENCES candidate_references (id),
  screening_check_id uuid REFERENCES screening_checks (id),
  appointment_id uuid REFERENCES appointments (id),
  -- Set when a workflow step created the task; unique so a retried step never duplicates it.
  source_step_execution_id uuid UNIQUE,
  created_by_staff_id uuid REFERENCES staff_members (id),
  outcome text,
  completed_at timestamptz,
  completed_by uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'done' OR completed_at IS NOT NULL)
);
CREATE INDEX tasks_open_due_idx ON tasks (due_at) WHERE status IN ('open', 'in_progress');
CREATE INDEX tasks_assignee_idx ON tasks (assigned_staff_id, status, due_at);
CREATE INDEX tasks_family_idx ON tasks (family_id);
CREATE INDEX tasks_candidate_idx ON tasks (candidate_id);

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  visibility text NOT NULL DEFAULT 'agency' CHECK (visibility IN ('agency', 'owner_only')),
  pinned boolean NOT NULL DEFAULT false,
  author_staff_id uuid NOT NULL REFERENCES staff_members (id),
  family_id uuid REFERENCES families (id),
  enquiry_id uuid REFERENCES enquiries (id),
  candidate_id uuid REFERENCES candidates (id),
  job_order_id uuid REFERENCES job_orders (id),
  job_candidate_id uuid REFERENCES job_candidates (id),
  placement_id uuid REFERENCES placements (id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(family_id, enquiry_id, candidate_id, job_order_id, job_candidate_id, placement_id) >= 1)
);
CREATE INDEX notes_family_idx ON notes (family_id) WHERE deleted_at IS NULL;
CREATE INDEX notes_candidate_idx ON notes (candidate_id) WHERE deleted_at IS NULL;

-- A coordinator's request for missing application items, with a deadline.
CREATE TABLE information_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  -- [{"key":"cpr_certificate","label":"Current CPR certificate","status":"requested"|"received"|"waived"}]
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
  message text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'received', 'cancelled')),
  deadline_on date,
  requested_by uuid REFERENCES staff_members (id),
  resolved_by uuid REFERENCES staff_members (id),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX information_requests_candidate_idx ON information_requests (candidate_id, status);

-- Every outbound message and every manually logged conversation.
CREATE TABLE communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('email', 'phone', 'text', 'in_person', 'video', 'other')),
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  status text NOT NULL CHECK (status IN (
    'draft', 'awaiting_approval', 'queued', 'provider_accepted', 'delivered', 'bounced', 'complained',
    'failed', 'cancelled', 'logged'
  )),
  -- Subject lines avoid sensitive content; bodies of automated email are not stored here.
  subject text,
  summary text,
  is_reply boolean NOT NULL DEFAULT false,
  to_address text,
  from_address text,
  template_key text,
  family_id uuid REFERENCES families (id),
  family_contact_id uuid REFERENCES family_contacts (id),
  enquiry_id uuid REFERENCES enquiries (id),
  candidate_id uuid REFERENCES candidates (id),
  job_order_id uuid REFERENCES job_orders (id),
  reference_id uuid REFERENCES candidate_references (id),
  delivery_id uuid,
  logged_by uuid REFERENCES staff_members (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX communications_family_idx ON communications (family_id, occurred_at DESC);
CREATE INDEX communications_candidate_idx ON communications (candidate_id, occurred_at DESC);
CREATE INDEX communications_enquiry_idx ON communications (enquiry_id, occurred_at DESC);

SELECT attach_updated_at_triggers();
