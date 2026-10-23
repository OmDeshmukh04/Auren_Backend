-- Screening: references, interviews, check records, eligibility policy and overrides.
-- A provider's "completed" result is never an agency approval; review is recorded separately.

CREATE TABLE candidate_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  application_id uuid REFERENCES applications (id),
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 160),
  relationship text NOT NULL CHECK (relationship IN (
    'employer_family', 'agency_supervisor', 'workplace_supervisor', 'colleague', 'teacher', 'other'
  )),
  relationship_detail text,
  organization_description text,
  email text CHECK (email = lower(email)),
  phone text,
  employment_start date,
  employment_end date,
  permission_to_contact boolean NOT NULL DEFAULT false,
  permission_recorded_at timestamptz,
  permission_source text CHECK (permission_source IN ('application', 'staff_recorded')),
  permission_consent_id uuid REFERENCES consents (id),
  permission_revoked_at timestamptz,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'in_progress', 'completed', 'unable_to_reach', 'declined', 'cancelled'
  )),
  assigned_staff_id uuid REFERENCES staff_members (id),
  completed_at timestamptz,
  reviewed_by uuid REFERENCES staff_members (id),
  reviewed_at timestamptz,
  review_outcome text CHECK (review_outcome IN ('satisfactory', 'concerns', 'unsatisfactory')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CHECK (NOT permission_to_contact OR permission_recorded_at IS NOT NULL),
  CHECK (employment_end IS NULL OR employment_start IS NULL OR employment_end >= employment_start),
  CHECK (review_outcome IS NULL OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE INDEX candidate_references_candidate_idx ON candidate_references (candidate_id);

CREATE TABLE reference_contact_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES candidate_references (id),
  method text NOT NULL CHECK (method IN ('email', 'phone', 'text', 'other')),
  outcome text NOT NULL CHECK (outcome IN (
    'no_answer', 'left_message', 'spoke', 'email_sent', 'bounced', 'declined', 'callback_scheduled', 'wrong_contact'
  )),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  delivery_id uuid,
  actor_staff_id uuid REFERENCES staff_members (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reference_contact_attempts_reference_idx ON reference_contact_attempts (reference_id, occurred_at);

-- Internal and confidential. Never included in presentations or exports to families.
CREATE TABLE reference_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL UNIQUE REFERENCES candidate_references (id),
  answers jsonb NOT NULL DEFAULT '{}',
  verified_dates boolean,
  verified_role boolean,
  strengths text,
  concerns text,
  would_rehire boolean,
  recommendation text NOT NULL CHECK (recommendation IN ('positive', 'mixed', 'negative', 'inconclusive')),
  evaluator_staff_id uuid NOT NULL REFERENCES staff_members (id),
  completed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interview_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('general', 'job_fit')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interview_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES interview_templates (id),
  version_number integer NOT NULL CHECK (version_number > 0),
  -- [{"key":"childcare_philosophy","prompt":"...","type":"long_text"|"rating"}]
  questions jsonb NOT NULL,
  published_by uuid REFERENCES staff_members (id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_number),
  UNIQUE (template_id, id)
);
CREATE TRIGGER interview_template_versions_immutable BEFORE UPDATE OR DELETE ON interview_template_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
ALTER TABLE interview_templates
  ADD CONSTRAINT interview_templates_current_fk FOREIGN KEY (id, current_version_id)
  REFERENCES interview_template_versions (template_id, id);

CREATE TABLE interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  job_order_id uuid,
  kind text NOT NULL CHECK (kind IN ('general', 'job_fit')),
  template_version_id uuid REFERENCES interview_template_versions (id),
  appointment_id uuid,
  interviewer_staff_id uuid REFERENCES staff_members (id),
  method text NOT NULL CHECK (method IN ('in_person', 'video', 'phone')),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  scheduled_start timestamptz,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'job_fit' OR job_order_id IS NOT NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX interviews_candidate_idx ON interviews (candidate_id, created_at DESC);

CREATE TABLE interview_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL UNIQUE REFERENCES interviews (id),
  answers jsonb NOT NULL DEFAULT '{}',
  general_assessment text,
  job_fit_assessment text,
  strengths text,
  concerns text,
  follow_up text,
  recommendation text NOT NULL CHECK (recommendation IN ('advance', 'hold', 'do_not_advance')),
  evaluator_staff_id uuid NOT NULL REFERENCES staff_members (id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE screening_check_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  label text NOT NULL,
  description text,
  requires_authorization boolean NOT NULL DEFAULT true,
  -- Months a reviewed result stays current; null = does not expire.
  validity_months smallint CHECK (validity_months BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE screening_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  check_type_key text NOT NULL REFERENCES screening_check_types (key),
  status text NOT NULL DEFAULT 'not_requested' CHECK (status IN (
    'not_requested', 'authorization_pending', 'requested', 'pending', 'completed', 'reviewed', 'follow_up_required', 'expired'
  )),
  provider text,
  -- A link or id in the provider's system; full sensitive reports are not stored by default.
  provider_reference text,
  authorization_consent_id uuid REFERENCES consents (id),
  authorization_reference text,
  authorization_recorded_at timestamptz,
  requested_at timestamptz,
  completed_at timestamptz,
  result_category text CHECK (result_category IN ('clear', 'consider', 'adverse', 'inconclusive', 'not_applicable')),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES staff_members (id),
  review_outcome text CHECK (review_outcome IN ('acceptable', 'not_acceptable', 'needs_follow_up')),
  review_note text,
  valid_until date,
  assigned_staff_id uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'reviewed' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_outcome IS NOT NULL)),
  CHECK (status NOT IN ('completed', 'reviewed') OR completed_at IS NOT NULL),
  CHECK (status NOT IN ('requested', 'pending', 'completed', 'reviewed') OR requested_at IS NOT NULL)
);
CREATE INDEX screening_checks_candidate_idx ON screening_checks (candidate_id, check_type_key);

-- Versioned policy. Requirements are typed items evaluated server-side (see eligibility service).
CREATE TABLE screening_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_number integer NOT NULL UNIQUE CHECK (version_number > 0),
  requirements jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  notes text,
  created_by uuid REFERENCES staff_members (id),
  published_by uuid REFERENCES staff_members (id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX screening_policies_one_active_idx ON screening_policies ((true)) WHERE status = 'active';
CREATE FUNCTION screening_policy_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.requirements IS DISTINCT FROM OLD.requirements THEN
    RAISE EXCEPTION 'A published screening policy is immutable; create a new version' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER screening_policies_freeze BEFORE UPDATE ON screening_policies FOR EACH ROW EXECUTE FUNCTION screening_policy_freeze();

-- An owner's documented decision to treat one requirement as met, optionally for one job only.
CREATE TABLE eligibility_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  requirement_key text NOT NULL,
  job_order_id uuid,
  reason text NOT NULL CHECK (length(reason) >= 10),
  actor_staff_id uuid NOT NULL REFERENCES staff_members (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES staff_members (id),
  revoke_reason text,
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_by IS NOT NULL)
);
CREATE INDEX eligibility_overrides_candidate_idx ON eligibility_overrides (candidate_id) WHERE revoked_at IS NULL;

SELECT attach_updated_at_triggers();
