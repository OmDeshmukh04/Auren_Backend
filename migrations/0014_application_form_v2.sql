-- Candidate application form version 2: offers the profile-sharing permission that presentations
-- require. Version 1 is retired (drafts already on it keep working under the agency's policy).
UPDATE form_versions SET status = 'retired', retired_at = now()
WHERE form_key = 'candidate_application' AND version_number = 1;

INSERT INTO form_versions (form_key, version_number, status, layout, notes, published_at)
SELECT 'candidate_application', 2, 'published',
       jsonb_set(layout, '{optionalConsents}', '["reference_contact_authorization", "presentation_sharing", "marketing_email"]'::jsonb),
       'Adds the presentation sharing permission', now()
FROM form_versions WHERE form_key = 'candidate_application' AND version_number = 1;

UPDATE form_definitions f SET current_version_id = v.id
FROM form_versions v WHERE v.form_key = f.key AND f.key = 'candidate_application' AND v.version_number = 2;
