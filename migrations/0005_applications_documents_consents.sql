-- Candidate application drafts (save/resume), immutable submissions, private documents and consents.

CREATE TABLE application_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_version_id uuid NOT NULL REFERENCES form_versions (id),
  email text NOT NULL CHECK (email = lower(email)),
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'submitted', 'expired', 'withdrawn')),
  data jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  completed_sections text[] NOT NULL DEFAULT '{}',
  last_saved_at timestamptz,
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  verification_code_hash text,
  verification_code_expires_at timestamptz,
  verification_attempts smallint NOT NULL DEFAULT 0,
  source text,
  utm jsonb NOT NULL DEFAULT '{}',
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'submitted' OR submitted_at IS NOT NULL)
);
CREATE INDEX application_drafts_email_idx ON application_drafts (email) WHERE status = 'active';
CREATE INDEX application_drafts_expiry_idx ON application_drafts (expires_at) WHERE status = 'active';

-- Random tokens are stored only as SHA-256 hashes. A resume link is single-use and is exchanged
-- for a short-lived draft session (an HttpOnly cookie); neither grants anything beyond one draft.
CREATE TABLE draft_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES application_drafts (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('resume_link', 'session')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX draft_access_tokens_draft_idx ON draft_access_tokens (draft_id, kind);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  draft_id uuid NOT NULL UNIQUE REFERENCES application_drafts (id),
  candidate_id uuid NOT NULL REFERENCES candidates (id),
  form_version_id uuid NOT NULL REFERENCES form_versions (id),
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  is_test boolean NOT NULL DEFAULT false
);
CREATE INDEX applications_candidate_idx ON applications (candidate_id, submitted_at DESC);
CREATE INDEX applications_submitted_idx ON applications (submitted_at) WHERE NOT is_test;
CREATE FUNCTION application_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('auren.retention_override', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Submitted applications are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Only re-pointing to a surviving candidate after an audited merge is allowed.
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.form_version_id IS DISTINCT FROM OLD.form_version_id
     OR NEW.draft_id IS DISTINCT FROM OLD.draft_id OR NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'Submitted applications are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER applications_freeze BEFORE UPDATE OR DELETE ON applications FOR EACH ROW EXECUTE FUNCTION application_freeze();

-- ---------------------------------------------------------------------------------------------
-- Private documents. Bytes live in the private bucket under a random key; metadata lives here.
-- Files stay quarantined until a malware scan returns clean. Nothing here is ever public.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL CHECK (document_type IN (
    'resume', 'certificate', 'photo', 'introduction', 'reference_letter', 'agreement',
    'presentation_pdf', 'export', 'other'
  )),
  candidate_id uuid REFERENCES candidates (id),
  application_draft_id uuid REFERENCES application_drafts (id),
  family_id uuid REFERENCES families (id),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  declared_content_type text NOT NULL,
  detected_type text CHECK (detected_type IN ('pdf', 'docx', 'jpg', 'png')),
  size_bytes integer CHECK (size_bytes > 0),
  storage_key text NOT NULL UNIQUE,
  sha256 text,
  scan_status text NOT NULL DEFAULT 'awaiting_upload' CHECK (scan_status IN (
    'awaiting_upload', 'quarantined', 'clean', 'rejected', 'scan_failed'
  )),
  scan_detail text,
  scanned_at timestamptz,
  upload_expires_at timestamptz,
  expires_on date,
  uploaded_by_type text NOT NULL CHECK (uploaded_by_type IN ('applicant', 'staff', 'system')),
  uploaded_by_staff_id uuid REFERENCES staff_members (id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scan_status <> 'clean' OR (sha256 IS NOT NULL AND detected_type IS NOT NULL AND size_bytes IS NOT NULL))
);
CREATE INDEX documents_candidate_idx ON documents (candidate_id) WHERE deleted_at IS NULL;
CREATE INDEX documents_draft_idx ON documents (application_draft_id) WHERE deleted_at IS NULL;
CREATE INDEX documents_family_idx ON documents (family_id) WHERE deleted_at IS NULL;
CREATE INDEX documents_scan_backlog_idx ON documents (created_at) WHERE scan_status = 'quarantined';

ALTER TABLE candidates
  ADD CONSTRAINT candidates_photo_fk FOREIGN KEY (presentation_photo_document_id) REFERENCES documents (id);
ALTER TABLE candidate_qualifications
  ADD CONSTRAINT candidate_qualifications_document_fk FOREIGN KEY (document_id) REFERENCES documents (id);
ALTER TABLE candidate_field_verifications
  ADD CONSTRAINT candidate_field_verifications_document_fk FOREIGN KEY (evidence_document_id) REFERENCES documents (id);

-- ---------------------------------------------------------------------------------------------
-- Consents and acknowledgements, each recorded against a versioned notice.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_type text NOT NULL CHECK (consent_type IN (
    'accuracy_attestation', 'privacy_notice', 'reference_contact_authorization',
    'background_check_authorization', 'marketing_email', 'presentation_sharing', 'family_terms'
  )),
  candidate_id uuid REFERENCES candidates (id),
  application_draft_id uuid REFERENCES application_drafts (id),
  family_contact_id uuid REFERENCES family_contacts (id),
  legal_notice_id uuid REFERENCES legal_notices (id),
  notice_version text,
  granted boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_reason text,
  recorded_by_type text NOT NULL CHECK (recorded_by_type IN ('applicant', 'family', 'staff')),
  recorded_by_staff_id uuid REFERENCES staff_members (id),
  -- Evidence: form version, method ("web form", "signed paper form", "verbal on call"), etc.
  evidence jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(candidate_id, application_draft_id, family_contact_id) >= 1),
  CHECK (recorded_by_type <> 'staff' OR recorded_by_staff_id IS NOT NULL)
);
CREATE INDEX consents_candidate_idx ON consents (candidate_id, consent_type);
CREATE INDEX consents_contact_idx ON consents (family_contact_id, consent_type);

-- Consents are append-only except for recording a withdrawal.
CREATE FUNCTION consent_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('auren.retention_override', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Consent records cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.consent_type IS DISTINCT FROM OLD.consent_type OR NEW.granted IS DISTINCT FROM OLD.granted
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.notice_version IS DISTINCT FROM OLD.notice_version
     OR NEW.legal_notice_id IS DISTINCT FROM OLD.legal_notice_id OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'Consent records are append-only; only a withdrawal can be added' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consents_freeze BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION consent_freeze();

SELECT attach_updated_at_triggers();
