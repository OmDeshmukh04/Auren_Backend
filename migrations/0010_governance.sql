-- Governance: duplicate detection and merges, exports, retention policies, requests and holds.

-- A matching email or phone suggests a duplicate; it never authorizes an automatic merge.
CREATE TABLE duplicate_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('family', 'candidate')),
  record_a_id uuid NOT NULL,
  record_b_id uuid NOT NULL,
  match_reasons text[] NOT NULL CHECK (cardinality(match_reasons) > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'merged')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES staff_members (id),
  resolution_note text,
  CHECK (record_a_id < record_b_id)
);
CREATE UNIQUE INDEX duplicate_cases_pair_idx ON duplicate_cases (entity_type, record_a_id, record_b_id);
CREATE INDEX duplicate_cases_open_idx ON duplicate_cases (entity_type, detected_at DESC) WHERE status = 'open';

CREATE TABLE merge_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('family', 'candidate')),
  survivor_id uuid NOT NULL,
  merged_id uuid NOT NULL,
  duplicate_case_id uuid REFERENCES duplicate_cases (id),
  -- Which record's value was kept for each field, and the merged record as it was before merge.
  field_choices jsonb NOT NULL,
  merged_record_snapshot jsonb NOT NULL,
  reparented jsonb NOT NULL,
  actor_staff_id uuid NOT NULL REFERENCES staff_members (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (survivor_id <> merged_id)
);
CREATE TRIGGER merge_records_immutable BEFORE UPDATE OR DELETE ON merge_records
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('candidates', 'families', 'enquiries', 'job_orders', 'placements', 'invoices', 'report', 'subject_access')),
  params jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired', 'cancelled')),
  requested_by uuid NOT NULL REFERENCES staff_members (id),
  document_id uuid REFERENCES documents (id),
  row_count integer,
  error text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exports_status_idx ON exports (status, created_at);

CREATE TABLE retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type text NOT NULL UNIQUE CHECK (record_type IN (
    'application_draft', 'unsuccessful_candidate', 'closed_enquiry', 'delivery_content', 'export_file',
    'audit_event', 'rate_limit_bucket', 'idempotency_key'
  )),
  retention_days integer NOT NULL CHECK (retention_days > 0),
  action text NOT NULL CHECK (action IN ('delete', 'review_for_deletion', 'clear_content')),
  -- A policy only runs automatically once the owner has approved it.
  approved_by uuid REFERENCES staff_members (id),
  approved_at timestamptz,
  active boolean NOT NULL DEFAULT false,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT active OR approved_at IS NOT NULL)
);

CREATE TABLE retention_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('correction', 'access_export', 'deletion', 'restriction')),
  subject_type text NOT NULL CHECK (subject_type IN ('candidate', 'family', 'family_contact')),
  subject_id uuid NOT NULL,
  received_via text NOT NULL CHECK (received_via IN ('email', 'phone', 'letter', 'in_person', 'other')),
  received_at timestamptz NOT NULL DEFAULT now(),
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'approved', 'rejected', 'completed', 'on_hold')),
  decision_note text,
  decided_by uuid REFERENCES staff_members (id),
  decided_at timestamptz,
  completed_at timestamptz,
  export_id uuid REFERENCES exports (id),
  created_by uuid NOT NULL REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('candidate', 'family', 'placement')),
  subject_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) >= 10),
  created_by uuid NOT NULL REFERENCES staff_members (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid REFERENCES staff_members (id)
);
CREATE INDEX legal_holds_active_idx ON legal_holds (subject_type, subject_id) WHERE released_at IS NULL;

SELECT attach_updated_at_triggers();
