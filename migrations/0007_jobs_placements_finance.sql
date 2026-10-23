-- Job orders, candidate/job associations, offers, placements, agreements and financial records.

CREATE TABLE job_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  family_id uuid NOT NULL REFERENCES families (id),
  enquiry_id uuid REFERENCES enquiries (id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  service_type_key text REFERENCES service_types (key),
  status text NOT NULL DEFAULT 'draft',
  arrangement text CHECK (arrangement IN ('live_in', 'live_out', 'either')),
  schedule_types text[] NOT NULL DEFAULT '{}' CHECK (schedule_types <@ ARRAY[
    'full_time', 'part_time', 'temporary', 'overnight', 'weekend', 'evening', 'date_night', 'travel', 'rotational'
  ]),
  schedule_notes text,
  hours_per_week smallint CHECK (hours_per_week BETWEEN 1 AND 168),
  start_date date,
  start_flexibility text,
  compensation_min_minor integer CHECK (compensation_min_minor >= 0),
  compensation_max_minor integer CHECK (compensation_max_minor >= 0),
  compensation_currency char(3) CHECK (compensation_currency ~ '^[A-Z]{3}$'),
  compensation_period text CHECK (compensation_period IN ('hour', 'day', 'week', 'month', 'year')),
  travel_required boolean,
  travel_notes text,
  responsibilities text,
  children_count smallint CHECK (children_count BETWEEN 0 AND 20),
  children_age_bands text[] NOT NULL DEFAULT '{}'
    CHECK (children_age_bands <@ ARRAY['expecting', 'newborn', 'infant', 'toddler', 'preschool', 'school_age', 'teen']),
  location_city text,
  location_state text,
  postal_code text,
  assigned_staff_id uuid REFERENCES staff_members (id),
  replacement_for_placement_id uuid,
  opened_at timestamptz,
  filled_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  is_test boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id),
  CHECK (status IN ('draft', 'open', 'on_hold', 'filled', 'cancelled', 'closed')),
  CHECK (compensation_max_minor IS NULL OR compensation_min_minor IS NULL OR compensation_max_minor >= compensation_min_minor),
  CHECK ((compensation_min_minor IS NULL AND compensation_max_minor IS NULL)
         OR (compensation_currency IS NOT NULL AND compensation_period IS NOT NULL))
);
CREATE INDEX job_orders_family_idx ON job_orders (family_id);
CREATE INDEX job_orders_status_idx ON job_orders (status, updated_at DESC);

CREATE TABLE job_order_schedule_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_order_id uuid NOT NULL REFERENCES job_orders (id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (end_minute > start_minute)
);
CREATE INDEX job_order_schedule_windows_idx ON job_order_schedule_windows (job_order_id);

CREATE TABLE job_order_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_order_id uuid NOT NULL REFERENCES job_orders (id) ON DELETE CASCADE,
  importance text NOT NULL CHECK (importance IN ('required', 'preferred')),
  criterion text NOT NULL CHECK (criterion IN (
    'min_professional_nanny_years', 'min_childcare_years', 'age_group_experience', 'qualification_current',
    'language', 'skill', 'driving_eligible', 'has_vehicle', 'live_in', 'travel', 'schedule_availability',
    'education_level', 'service_area', 'special_needs_experience', 'staffed_household_experience',
    'max_children', 'compensation_within_budget'
  )),
  params jsonb NOT NULL DEFAULT '{}',
  note text,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_order_criteria_job_idx ON job_order_criteria (job_order_id);

-- A candidate's progress on one job. Unique per pair; independent of other jobs and of the
-- candidate's global recruitment stage.
CREATE TABLE job_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_order_id uuid NOT NULL REFERENCES job_orders (id),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  stage text NOT NULL DEFAULT 'shortlisted',
  rationale text,
  added_by uuid REFERENCES staff_members (id),
  closed_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_order_id, candidate_id),
  UNIQUE (id, job_order_id, candidate_id),
  CHECK (stage IN (
    'shortlisted', 'presentation_approved', 'presented', 'family_interview', 'trial', 'offer',
    'accepted', 'declined', 'withdrawn', 'placed'
  ))
);
CREATE INDEX job_candidates_candidate_idx ON job_candidates (candidate_id);

CREATE TABLE family_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_candidate_id uuid NOT NULL REFERENCES job_candidates (id),
  family_contact_id uuid REFERENCES family_contacts (id),
  sentiment text CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  summary text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES staff_members (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX family_feedback_job_candidate_idx ON family_feedback (job_candidate_id);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_candidate_id uuid NOT NULL REFERENCES job_candidates (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'extended', 'accepted', 'declined', 'withdrawn', 'superseded')),
  compensation_amount_minor integer CHECK (compensation_amount_minor >= 0),
  compensation_currency char(3) CHECK (compensation_currency ~ '^[A-Z]{3}$'),
  compensation_period text CHECK (compensation_period IN ('hour', 'day', 'week', 'month', 'year')),
  proposed_start_date date,
  review_date date,
  terms_summary text,
  extended_at timestamptz,
  responded_at timestamptz,
  superseded_by_offer_id uuid REFERENCES offers (id),
  recorded_by uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((compensation_amount_minor IS NULL) = (compensation_currency IS NULL))
);
CREATE UNIQUE INDEX offers_one_open_idx ON offers (job_candidate_id) WHERE status IN ('draft', 'extended');

CREATE TABLE placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  job_order_id uuid NOT NULL,
  family_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  job_candidate_id uuid NOT NULL UNIQUE,
  offer_id uuid REFERENCES offers (id),
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'started', 'ended', 'cancelled')),
  agreed_start_date date NOT NULL,
  actual_start_date date,
  end_date date,
  end_reason text,
  fee_amount_minor integer CHECK (fee_amount_minor >= 0),
  fee_currency char(3) CHECK (fee_currency ~ '^[A-Z]{3}$'),
  compensation_amount_minor integer CHECK (compensation_amount_minor >= 0),
  compensation_currency char(3) CHECK (compensation_currency ~ '^[A-Z]{3}$'),
  compensation_period text CHECK (compensation_period IN ('hour', 'day', 'week', 'month', 'year')),
  -- Terms are recorded as agreed; nothing is inferred.
  guarantee_terms text,
  guarantee_ends_on date,
  replacement_obligation text,
  replacement_job_order_id uuid REFERENCES job_orders (id),
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_order_id, family_id) REFERENCES job_orders (id, family_id),
  FOREIGN KEY (job_candidate_id, job_order_id, candidate_id) REFERENCES job_candidates (id, job_order_id, candidate_id),
  CHECK ((fee_amount_minor IS NULL) = (fee_currency IS NULL)),
  CHECK ((compensation_amount_minor IS NULL) = (compensation_currency IS NULL)),
  CHECK (status <> 'started' OR actual_start_date IS NOT NULL),
  CHECK (status <> 'ended' OR end_date IS NOT NULL),
  CHECK (end_date IS NULL OR end_date >= coalesce(actual_start_date, agreed_start_date))
);
CREATE INDEX placements_family_idx ON placements (family_id);
CREATE INDEX placements_candidate_idx ON placements (candidate_id);
CREATE INDEX placements_status_idx ON placements (status, agreed_start_date);

ALTER TABLE job_orders
  ADD CONSTRAINT job_orders_replacement_fk FOREIGN KEY (replacement_for_placement_id) REFERENCES placements (id);
ALTER TABLE interviews
  ADD CONSTRAINT interviews_job_order_fk FOREIGN KEY (job_order_id) REFERENCES job_orders (id);
ALTER TABLE eligibility_overrides
  ADD CONSTRAINT eligibility_overrides_job_order_fk FOREIGN KEY (job_order_id) REFERENCES job_orders (id);

CREATE TABLE placement_check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id uuid NOT NULL REFERENCES placements (id),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'skipped', 'cancelled')),
  outcome text CHECK (outcome IN ('going_well', 'minor_concern', 'escalated')),
  notes text,
  completed_at timestamptz,
  completed_by uuid REFERENCES staff_members (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX placement_check_ins_due_idx ON placement_check_ins (due_on) WHERE status = 'scheduled';

CREATE TABLE agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families (id),
  job_order_id uuid REFERENCES job_orders (id),
  kind text NOT NULL CHECK (kind IN ('service_agreement', 'fee_agreement', 'other')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'signed', 'void')),
  fee_terms text,
  guarantee_terms text,
  sent_at timestamptz,
  signed_at timestamptz,
  voided_at timestamptz,
  document_id uuid REFERENCES documents (id),
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'signed' OR signed_at IS NOT NULL)
);
CREATE INDEX agreements_family_idx ON agreements (family_id);

-- Operational invoice records (not accounting software). Amounts are integer minor units.
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  family_id uuid NOT NULL REFERENCES families (id),
  placement_id uuid REFERENCES placements (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor integer NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  issued_on date,
  due_on date,
  voided_at timestamptz,
  void_reason text,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR issued_on IS NOT NULL),
  CHECK (status <> 'void' OR voided_at IS NOT NULL)
);
CREATE INDEX invoices_family_idx ON invoices (family_id);
CREATE INDEX invoices_status_idx ON invoices (status, issued_on);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  amount_minor integer NOT NULL CHECK (amount_minor >= 0),
  sort_order smallint NOT NULL DEFAULT 0
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices (id),
  kind text NOT NULL CHECK (kind IN ('payment', 'credit', 'refund')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  received_on date NOT NULL,
  method text CHECK (method IN ('bank_transfer', 'check', 'card', 'cash', 'other')),
  external_reference text,
  notes text,
  recorded_by uuid REFERENCES staff_members (id),
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

CREATE FUNCTION payment_currency_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id AND i.currency = NEW.currency) THEN
    RAISE EXCEPTION 'Payment currency must match the invoice currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_currency_check BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payment_currency_matches();

SELECT attach_updated_at_triggers();
