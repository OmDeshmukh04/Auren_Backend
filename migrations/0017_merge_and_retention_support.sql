-- Duplicate merges re-point a job order and its placements/presentations together, which needs the
-- composite keys to be checked at commit rather than per statement. Integrity is unchanged: the
-- constraints still hold for every committed transaction.
ALTER TABLE placements ALTER CONSTRAINT placements_job_order_id_family_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE placements ALTER CONSTRAINT placements_job_candidate_id_job_order_id_candidate_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE presentations ALTER CONSTRAINT presentations_job_order_id_family_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE presentation_candidates ALTER CONSTRAINT presentation_candidates_job_candidate_id_job_order_id_cand_fkey DEFERRABLE INITIALLY IMMEDIATE;

-- System-generated exports (CSV/JSON) are stored as documents too; only staff can download them.
ALTER TABLE documents DROP CONSTRAINT documents_detected_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_detected_type_check CHECK (detected_type IN ('pdf', 'docx', 'jpg', 'png', 'csv', 'json'));

-- An approved deletion request may clear an enquiry's original submission.
CREATE OR REPLACE FUNCTION enquiry_snapshot_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('auren.retention_override', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.submission_snapshot IS NOT NULL AND NEW.submission_snapshot IS DISTINCT FROM OLD.submission_snapshot THEN
    RAISE EXCEPTION 'The original enquiry submission is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.form_version_id IS DISTINCT FROM OLD.form_version_id THEN
    RAISE EXCEPTION 'Enquiry submission metadata is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
