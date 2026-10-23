-- Family CRM and candidate profiles.
-- Nullable booleans and numbers mean "not recorded"; search treats them as unknown, never as a match.

-- ---------------------------------------------------------------------------------------------
-- Families
-- ---------------------------------------------------------------------------------------------

CREATE TABLE families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  relationship_status text NOT NULL DEFAULT 'prospect',
  assigned_staff_id uuid REFERENCES staff_members (id),
  city text,
  state text,
  postal_code text,
  service_area text,
  household_summary text,
  first_source text,
  first_source_detail jsonb NOT NULL DEFAULT '{}',
  merged_into_family_id uuid REFERENCES families (id),
  merged_at timestamptz,
  is_test boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (relationship_status IN ('prospect', 'consultation', 'active_client', 'past_client', 'inactive')),
  CHECK (merged_into_family_id IS NULL OR merged_into_family_id <> id)
);
CREATE INDEX families_assigned_idx ON families (assigned_staff_id) WHERE merged_into_family_id IS NULL;
CREATE INDEX families_status_idx ON families (relationship_status, updated_at DESC) WHERE merged_into_family_id IS NULL;

CREATE TABLE family_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families (id),
  first_name text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 80),
  last_name text,
  email text CHECK (email = lower(email)),
  phone text,
  phone_normalized text,
  relationship text NOT NULL DEFAULT 'parent'
    CHECK (relationship IN ('parent', 'guardian', 'household_manager', 'family_office', 'assistant', 'other')),
  is_primary boolean NOT NULL DEFAULT false,
  -- Only authorized recipients can be sent candidate presentations.
  authorized_recipient boolean NOT NULL DEFAULT false,
  preferred_contact_method text CHECK (preferred_contact_method IN ('email', 'phone', 'text', 'any')),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX family_contacts_one_primary_idx ON family_contacts (family_id) WHERE is_primary AND archived_at IS NULL;
CREATE INDEX family_contacts_family_idx ON family_contacts (family_id);
CREATE INDEX family_contacts_email_idx ON family_contacts (email) WHERE email IS NOT NULL;
CREATE INDEX family_contacts_phone_idx ON family_contacts (phone_normalized) WHERE phone_normalized IS NOT NULL;

CREATE TABLE enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  family_id uuid NOT NULL REFERENCES families (id),
  contact_id uuid REFERENCES family_contacts (id),
  form_version_id uuid REFERENCES form_versions (id),
  channel text NOT NULL CHECK (channel IN ('website', 'phone', 'email', 'referral', 'staff_entry', 'other')),
  stage text NOT NULL DEFAULT 'new',
  service_type_key text REFERENCES service_types (key),
  schedule_types text[] NOT NULL DEFAULT '{}',
  arrangement text CHECK (arrangement IN ('live_in', 'live_out', 'either', 'unsure')),
  start_timing text CHECK (start_timing IN ('asap', 'within_1_month', 'within_3_months', 'flexible', 'specific_date')),
  start_date date,
  children_count smallint CHECK (children_count BETWEEN 0 AND 20),
  children_age_bands text[] NOT NULL DEFAULT '{}'
    CHECK (children_age_bands <@ ARRAY['expecting', 'newborn', 'infant', 'toddler', 'preschool', 'school_age', 'teen']),
  location_city text,
  location_state text,
  postal_code text,
  budget_notes text,
  details text,
  source text,
  utm jsonb NOT NULL DEFAULT '{}',
  -- The original submission exactly as received; never edited (see trigger below).
  submission_snapshot jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  closed_reason text,
  closed_at timestamptz,
  assigned_staff_id uuid REFERENCES staff_members (id),
  is_test boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stage IN ('new', 'contacted', 'consultation_scheduled', 'consultation_completed', 'converted', 'closed')),
  CHECK (start_timing IS DISTINCT FROM 'specific_date' OR start_date IS NOT NULL)
);
CREATE INDEX enquiries_family_idx ON enquiries (family_id, submitted_at DESC);
CREATE INDEX enquiries_stage_idx ON enquiries (stage, submitted_at DESC);
CREATE INDEX enquiries_assigned_idx ON enquiries (assigned_staff_id);

CREATE FUNCTION enquiry_snapshot_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.submission_snapshot IS NOT NULL AND NEW.submission_snapshot IS DISTINCT FROM OLD.submission_snapshot THEN
    RAISE EXCEPTION 'The original enquiry submission is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.form_version_id IS DISTINCT FROM OLD.form_version_id THEN
    RAISE EXCEPTION 'Enquiry submission metadata is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enquiries_snapshot_freeze BEFORE UPDATE ON enquiries FOR EACH ROW EXECUTE FUNCTION enquiry_snapshot_freeze();

CREATE TABLE enquiry_custom_answers (
  enquiry_id uuid NOT NULL REFERENCES enquiries (id),
  question_key text NOT NULL REFERENCES question_definitions (key),
  form_version_id uuid NOT NULL REFERENCES form_versions (id),
  value jsonb NOT NULL,
  PRIMARY KEY (enquiry_id, question_key)
);

-- ---------------------------------------------------------------------------------------------
-- Candidates. Canonical, filterable fields are typed columns or child tables.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  -- A. Contact and work location
  first_name text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 80),
  last_name text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  preferred_name text,
  email text NOT NULL CHECK (email = lower(email)),
  phone text,
  phone_normalized text,
  contact_methods text[] NOT NULL DEFAULT '{}' CHECK (contact_methods <@ ARRAY['email', 'phone', 'text']),
  city text,
  state text,
  postal_code text,
  preferred_areas text[] NOT NULL DEFAULT '{}',
  latitude numeric(8, 5),
  longitude numeric(8, 5),
  geocoded_at timestamptz,
  max_commute_miles smallint CHECK (max_commute_miles BETWEEN 0 AND 500),
  open_to_relocation boolean,
  open_to_travel boolean,
  -- Status dimensions (independent of each other and of any job association)
  recruitment_stage text NOT NULL DEFAULT 'received',
  availability_status text NOT NULL DEFAULT 'unknown'
    CHECK (availability_status IN ('available', 'future_date', 'unavailable', 'unknown')),
  available_from date,
  availability_confirmed_at timestamptz,
  -- B. Experience
  childcare_years numeric(4, 1) CHECK (childcare_years BETWEEN 0 AND 70),
  professional_nanny_years numeric(4, 1) CHECK (professional_nanny_years BETWEEN 0 AND 70),
  age_groups text[] NOT NULL DEFAULT '{}'
    CHECK (age_groups <@ ARRAY['newborn', 'infant', 'toddler', 'preschool', 'school_age', 'teen']),
  max_children_cared smallint CHECK (max_children_cared BETWEEN 1 AND 20),
  private_household_experience boolean,
  staffed_household_experience boolean,
  live_in_experience boolean,
  live_out_experience boolean,
  schedule_experience text[] NOT NULL DEFAULT '{}',
  household_management_experience boolean,
  special_needs_experience boolean,
  developmental_support_experience boolean,
  -- C. Qualifications (certificates and trainings live in candidate_qualifications)
  education_level text CHECK (education_level IN (
    'none', 'high_school', 'some_college', 'associate', 'bachelor', 'master', 'doctorate', 'other'
  )),
  education_details text,
  driving_eligible boolean,
  has_vehicle boolean,
  travel_ready boolean,
  -- D. Preferences
  desired_service_types text[] NOT NULL DEFAULT '{}',
  desired_arrangement text CHECK (desired_arrangement IN ('live_in', 'live_out', 'either')),
  desired_schedule_types text[] NOT NULL DEFAULT '{}' CHECK (desired_schedule_types <@ ARRAY[
    'full_time', 'part_time', 'temporary', 'overnight', 'weekend', 'evening', 'date_night', 'travel', 'rotational'
  ]),
  earliest_start_date date,
  compensation_min_minor integer CHECK (compensation_min_minor >= 0),
  compensation_max_minor integer CHECK (compensation_max_minor >= 0),
  compensation_currency char(3) CHECK (compensation_currency ~ '^[A-Z]{3}$'),
  compensation_period text CHECK (compensation_period IN ('hour', 'day', 'week', 'month', 'year')),
  willing_to_travel boolean,
  preference_notes text,
  introduction text,
  -- Internal
  assigned_staff_id uuid REFERENCES staff_members (id),
  source text,
  utm jsonb NOT NULL DEFAULT '{}',
  presentation_photo_document_id uuid,
  merged_into_candidate_id uuid REFERENCES candidates (id),
  merged_at timestamptz,
  is_test boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recruitment_stage IN (
    'received', 'review', 'screening', 'interview', 'information_requested', 'references',
    'background_review', 'eligible', 'hold', 'not_selected', 'archived'
  )),
  CHECK (compensation_max_minor IS NULL OR compensation_min_minor IS NULL OR compensation_max_minor >= compensation_min_minor),
  CHECK ((compensation_min_minor IS NULL AND compensation_max_minor IS NULL)
         OR (compensation_currency IS NOT NULL AND compensation_period IS NOT NULL)),
  CHECK (availability_status <> 'future_date' OR available_from IS NOT NULL),
  CHECK (merged_into_candidate_id IS NULL OR merged_into_candidate_id <> id)
);
CREATE INDEX candidates_stage_idx ON candidates (recruitment_stage, updated_at DESC) WHERE merged_into_candidate_id IS NULL;
CREATE INDEX candidates_availability_idx ON candidates (availability_status, available_from);
CREATE INDEX candidates_email_idx ON candidates (email);
CREATE INDEX candidates_phone_idx ON candidates (phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX candidates_age_groups_idx ON candidates USING gin (age_groups);
CREATE INDEX candidates_areas_idx ON candidates USING gin (preferred_areas);
CREATE INDEX candidates_schedule_idx ON candidates USING gin (desired_schedule_types);
CREATE INDEX candidates_services_idx ON candidates USING gin (desired_service_types);
CREATE INDEX candidates_assigned_idx ON candidates (assigned_staff_id);

CREATE TABLE candidate_availability_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  -- ISO weekday: 1 = Monday ... 7 = Sunday. Overnight availability is split at midnight.
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (end_minute > start_minute)
);
CREATE INDEX candidate_availability_windows_idx ON candidate_availability_windows (candidate_id, day_of_week);

CREATE TABLE candidate_employments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  employer_description text NOT NULL CHECK (length(employer_description) BETWEEN 1 AND 200),
  role_title text NOT NULL CHECK (length(role_title) BETWEEN 1 AND 120),
  employment_type text NOT NULL DEFAULT 'private_household' CHECK (employment_type IN (
    'private_household', 'agency', 'childcare_center', 'school', 'hospitality', 'other'
  )),
  start_date date NOT NULL,
  end_date date,
  is_current boolean NOT NULL DEFAULT false,
  hours_per_week smallint CHECK (hours_per_week BETWEEN 1 AND 168),
  live_in boolean,
  staffed_household boolean,
  children_count smallint CHECK (children_count BETWEEN 0 AND 20),
  age_groups text[] NOT NULL DEFAULT '{}'
    CHECK (age_groups <@ ARRAY['newborn', 'infant', 'toddler', 'preschool', 'school_age', 'teen']),
  responsibilities text,
  departure_reason text,
  provenance text NOT NULL DEFAULT 'self_reported'
    CHECK (provenance IN ('self_reported', 'document_supplied', 'agency_verified')),
  verified_at timestamptz,
  verified_by uuid REFERENCES staff_members (id),
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (NOT is_current OR end_date IS NULL),
  CHECK (provenance <> 'agency_verified' OR verified_at IS NOT NULL)
);
CREATE INDEX candidate_employments_candidate_idx ON candidate_employments (candidate_id, start_date DESC);

CREATE TABLE candidate_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  qualification_key text NOT NULL REFERENCES qualification_types (key),
  issuer text,
  issued_on date,
  expires_on date,
  document_id uuid,
  review_state text NOT NULL DEFAULT 'pending_review' CHECK (review_state IN ('pending_review', 'verified', 'rejected')),
  provenance text NOT NULL DEFAULT 'self_reported'
    CHECK (provenance IN ('self_reported', 'document_supplied', 'agency_verified')),
  reviewed_by uuid REFERENCES staff_members (id),
  reviewed_at timestamptz,
  review_note text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  CHECK (review_state = 'pending_review' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE INDEX candidate_qualifications_lookup_idx ON candidate_qualifications (qualification_key, review_state, expires_on);
CREATE INDEX candidate_qualifications_candidate_idx ON candidate_qualifications (candidate_id);

CREATE TABLE candidate_languages (
  candidate_id uuid NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  proficiency text NOT NULL CHECK (proficiency IN ('basic', 'conversational', 'fluent', 'native')),
  PRIMARY KEY (candidate_id, language_code)
);
CREATE INDEX candidate_languages_lookup_idx ON candidate_languages (language_code, proficiency);

CREATE TABLE candidate_skills (
  candidate_id uuid NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  skill_key text NOT NULL REFERENCES skills (key),
  provenance text NOT NULL DEFAULT 'self_reported'
    CHECK (provenance IN ('self_reported', 'document_supplied', 'agency_verified')),
  PRIMARY KEY (candidate_id, skill_key)
);
CREATE INDEX candidate_skills_lookup_idx ON candidate_skills (skill_key);

-- Agency verification of individual profile facts (e.g. professional years), with evidence.
CREATE TABLE candidate_field_verifications (
  candidate_id uuid NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  field_key text NOT NULL CHECK (field_key IN (
    'childcare_years', 'professional_nanny_years', 'age_groups', 'max_children_cared', 'education_level',
    'driving_eligible', 'live_in_experience', 'staffed_household_experience', 'special_needs_experience'
  )),
  provenance text NOT NULL CHECK (provenance IN ('self_reported', 'document_supplied', 'agency_verified')),
  verified_by uuid REFERENCES staff_members (id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  evidence_document_id uuid,
  note text,
  PRIMARY KEY (candidate_id, field_key)
);

-- Owner-defined questions. Answers are typed so filterable questions are indexable.
CREATE TABLE candidate_custom_answers (
  candidate_id uuid NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  question_key text NOT NULL REFERENCES question_definitions (key),
  form_version_id uuid REFERENCES form_versions (id),
  value jsonb NOT NULL,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_options text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, question_key)
);
CREATE INDEX candidate_custom_answers_text_idx ON candidate_custom_answers (question_key, lower(value_text));
CREATE INDEX candidate_custom_answers_number_idx ON candidate_custom_answers (question_key, value_number);
CREATE INDEX candidate_custom_answers_boolean_idx ON candidate_custom_answers (question_key, value_boolean);
CREATE INDEX candidate_custom_answers_date_idx ON candidate_custom_answers (question_key, value_date);
CREATE INDEX candidate_custom_answers_options_idx ON candidate_custom_answers USING gin (value_options);

CREATE TABLE saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  owner_staff_id uuid NOT NULL REFERENCES staff_members (id),
  scope text NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'shared')),
  criteria jsonb NOT NULL,
  criteria_schema_version smallint NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_searches_owner_idx ON saved_searches (owner_staff_id);

SELECT attach_updated_at_triggers();
