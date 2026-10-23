-- System reference data. Keys are permanent identifiers; labels, order and activation are
-- owner-editable. Business policy (screening requirements, legal wording) is seeded as DRAFT and
-- must be reviewed and published by the owner before it takes effect.

INSERT INTO service_types (key, label, description, sort_order) VALUES
  ('nanny', 'Nanny placement', 'Full- or part-time professional nanny', 10),
  ('newborn_care', 'Newborn care specialist', 'Newborn and early-infant support, including overnight', 20),
  ('family_assistant', 'Family assistant', 'Childcare combined with household coordination', 30),
  ('household_professional', 'Household professional', 'Household manager and other private-service roles', 40),
  ('temporary_care', 'Temporary or backup care', 'Short-term, travel or backup coverage', 50);

INSERT INTO qualification_types (key, label, category, has_expiry, requires_review, sort_order) VALUES
  ('cpr', 'CPR certification', 'certification', true, true, 10),
  ('first_aid', 'First Aid certification', 'certification', true, true, 20),
  ('pediatric_cpr_first_aid', 'Pediatric CPR and First Aid', 'certification', true, true, 25),
  ('newborn_care_training', 'Newborn care training', 'training', false, true, 30),
  ('safe_sleep_training', 'Safe sleep training', 'training', false, true, 40),
  ('sleep_consulting', 'Infant sleep consulting', 'training', false, true, 45),
  ('special_needs_training', 'Special-needs care training', 'training', false, true, 50),
  ('early_childhood_education', 'Early childhood education credential', 'education', false, true, 60),
  ('drivers_license', 'Driver''s license', 'license', true, true, 70),
  ('water_safety', 'Water safety / lifeguard', 'certification', true, true, 80);

INSERT INTO skills (key, label, category, sort_order) VALUES
  ('meal_preparation', 'Child meal preparation', 'household', 10),
  ('family_cooking', 'Family cooking', 'household', 20),
  ('light_housekeeping', 'Light housekeeping', 'household', 30),
  ('laundry', 'Children''s laundry', 'household', 40),
  ('homework_support', 'Homework support', 'education', 50),
  ('tutoring', 'Tutoring', 'education', 60),
  ('montessori', 'Montessori approach', 'education', 70),
  ('swimming', 'Swimming', 'activities', 80),
  ('travel_support', 'Travel with family', 'travel', 90),
  ('pet_care', 'Pet care', 'household', 100),
  ('schedule_management', 'Family schedule management', 'household', 110),
  ('multiples', 'Twins / multiples', 'childcare', 120),
  ('sign_language', 'Sign language', 'language', 130);

INSERT INTO screening_check_types (key, label, description, requires_authorization, validity_months, sort_order) VALUES
  ('background_check', 'Background check', 'Criminal background screening through the agency''s chosen provider', true, 24, 10),
  ('motor_vehicle_record', 'Motor vehicle record', 'Driving record review for roles that include driving', true, 12, 20),
  ('identity_verification', 'Identity verification', 'Identity confirmation performed by the agency or provider', true, NULL, 30);

-- ---------------------------------------------------------------------------------------------
-- Status dimensions
-- ---------------------------------------------------------------------------------------------

INSERT INTO stage_definitions (dimension, key, label, sort_order, required, is_terminal, manual_entry) VALUES
  ('candidate_recruitment', 'received', 'Application received', 10, true, false, true),
  ('candidate_recruitment', 'review', 'In review', 20, false, false, true),
  ('candidate_recruitment', 'screening', 'Screening', 30, false, false, true),
  ('candidate_recruitment', 'interview', 'Interview', 40, false, false, true),
  ('candidate_recruitment', 'information_requested', 'Information requested', 50, false, false, true),
  ('candidate_recruitment', 'references', 'References', 60, false, false, true),
  ('candidate_recruitment', 'background_review', 'Background review', 70, false, false, true),
  ('candidate_recruitment', 'eligible', 'Eligible for presentation', 80, true, false, true),
  ('candidate_recruitment', 'hold', 'On hold', 90, false, false, true),
  ('candidate_recruitment', 'not_selected', 'Not selected', 100, false, true, true),
  ('candidate_recruitment', 'archived', 'Archived', 110, true, true, true),

  ('candidate_availability', 'available', 'Available', 10, true, false, true),
  ('candidate_availability', 'future_date', 'Available from a future date', 20, true, false, true),
  ('candidate_availability', 'unavailable', 'Unavailable', 30, true, false, true),
  ('candidate_availability', 'unknown', 'Not confirmed', 40, true, false, true),

  ('candidate_job', 'shortlisted', 'Shortlisted', 10, true, false, true),
  ('candidate_job', 'presentation_approved', 'Presentation approved', 20, true, false, false),
  ('candidate_job', 'presented', 'Presented to family', 30, true, false, false),
  ('candidate_job', 'family_interview', 'Family interview', 40, false, false, true),
  ('candidate_job', 'trial', 'Trial', 50, false, false, true),
  ('candidate_job', 'offer', 'Offer', 60, true, false, false),
  ('candidate_job', 'accepted', 'Offer accepted', 70, true, false, false),
  ('candidate_job', 'declined', 'Declined', 80, true, true, true),
  ('candidate_job', 'withdrawn', 'Withdrawn', 90, true, true, true),
  ('candidate_job', 'placed', 'Placed', 100, true, true, false),

  ('screening_check', 'not_requested', 'Not requested', 10, true, false, false),
  ('screening_check', 'authorization_pending', 'Authorization pending', 20, true, false, false),
  ('screening_check', 'requested', 'Requested', 30, true, false, false),
  ('screening_check', 'pending', 'Pending with provider', 40, true, false, false),
  ('screening_check', 'completed', 'Completed (awaiting review)', 50, true, false, false),
  ('screening_check', 'reviewed', 'Reviewed', 60, true, false, false),
  ('screening_check', 'follow_up_required', 'Follow-up required', 70, true, false, false),
  ('screening_check', 'expired', 'Expired', 80, true, true, false),

  ('enquiry', 'new', 'New enquiry', 10, true, false, true),
  ('enquiry', 'contacted', 'Contacted', 20, true, false, true),
  ('enquiry', 'consultation_scheduled', 'Consultation scheduled', 30, true, false, false),
  ('enquiry', 'consultation_completed', 'Consultation completed', 40, true, false, false),
  ('enquiry', 'converted', 'Converted to search', 50, true, false, true),
  ('enquiry', 'closed', 'Closed', 60, true, true, true),

  ('family_relationship', 'prospect', 'Prospect', 10, true, false, true),
  ('family_relationship', 'consultation', 'In consultation', 20, false, false, true),
  ('family_relationship', 'active_client', 'Active client', 30, true, false, true),
  ('family_relationship', 'past_client', 'Past client', 40, false, false, true),
  ('family_relationship', 'inactive', 'Inactive', 50, false, true, true),

  ('job_order', 'draft', 'Draft', 10, true, false, true),
  ('job_order', 'open', 'Open search', 20, true, false, true),
  ('job_order', 'on_hold', 'On hold', 30, false, false, true),
  ('job_order', 'filled', 'Filled', 40, true, false, false),
  ('job_order', 'cancelled', 'Cancelled', 50, true, true, true),
  ('job_order', 'closed', 'Closed', 60, true, true, true),

  ('placement', 'booked', 'Booked', 10, true, false, true),
  ('placement', 'started', 'Started', 20, true, false, true),
  ('placement', 'ended', 'Ended', 30, true, true, true),
  ('placement', 'cancelled', 'Cancelled before start', 40, true, true, true);

-- Candidate recruitment: open movement between working stages; terminal stages can be reopened
-- into review. Entering "eligible" is additionally gated by the screening policy in code.
INSERT INTO stage_transition_rules (dimension, from_key, to_key)
SELECT 'candidate_recruitment', a.key, b.key
FROM stage_definitions a CROSS JOIN stage_definitions b
WHERE a.dimension = 'candidate_recruitment' AND b.dimension = 'candidate_recruitment' AND a.key <> b.key
  AND a.key NOT IN ('not_selected', 'archived') AND b.key <> 'received';
INSERT INTO stage_transition_rules (dimension, from_key, to_key) VALUES
  ('candidate_recruitment', 'not_selected', 'review'),
  ('candidate_recruitment', 'not_selected', 'archived'),
  ('candidate_recruitment', 'archived', 'review');

INSERT INTO stage_transition_rules (dimension, from_key, to_key) VALUES
  ('candidate_job', 'shortlisted', 'presentation_approved'),
  ('candidate_job', 'shortlisted', 'declined'),
  ('candidate_job', 'shortlisted', 'withdrawn'),
  ('candidate_job', 'presentation_approved', 'presented'),
  ('candidate_job', 'presentation_approved', 'shortlisted'),
  ('candidate_job', 'presentation_approved', 'withdrawn'),
  ('candidate_job', 'presented', 'family_interview'),
  ('candidate_job', 'presented', 'offer'),
  ('candidate_job', 'presented', 'declined'),
  ('candidate_job', 'presented', 'withdrawn'),
  ('candidate_job', 'family_interview', 'trial'),
  ('candidate_job', 'family_interview', 'offer'),
  ('candidate_job', 'family_interview', 'declined'),
  ('candidate_job', 'family_interview', 'withdrawn'),
  ('candidate_job', 'trial', 'offer'),
  ('candidate_job', 'trial', 'declined'),
  ('candidate_job', 'trial', 'withdrawn'),
  ('candidate_job', 'offer', 'accepted'),
  ('candidate_job', 'offer', 'declined'),
  ('candidate_job', 'offer', 'withdrawn'),
  ('candidate_job', 'offer', 'family_interview'),
  ('candidate_job', 'accepted', 'placed'),
  ('candidate_job', 'accepted', 'withdrawn'),
  ('candidate_job', 'declined', 'shortlisted'),
  ('candidate_job', 'withdrawn', 'shortlisted');

INSERT INTO stage_transition_rules (dimension, from_key, to_key) VALUES
  ('enquiry', 'new', 'contacted'),
  ('enquiry', 'new', 'consultation_scheduled'),
  ('enquiry', 'new', 'closed'),
  ('enquiry', 'contacted', 'consultation_scheduled'),
  ('enquiry', 'contacted', 'converted'),
  ('enquiry', 'contacted', 'closed'),
  ('enquiry', 'consultation_scheduled', 'consultation_completed'),
  ('enquiry', 'consultation_scheduled', 'contacted'),
  ('enquiry', 'consultation_scheduled', 'closed'),
  ('enquiry', 'consultation_completed', 'converted'),
  ('enquiry', 'consultation_completed', 'contacted'),
  ('enquiry', 'consultation_completed', 'closed'),
  ('enquiry', 'converted', 'closed'),
  ('enquiry', 'closed', 'contacted');

INSERT INTO stage_transition_rules (dimension, from_key, to_key) VALUES
  ('family_relationship', 'prospect', 'consultation'),
  ('family_relationship', 'prospect', 'active_client'),
  ('family_relationship', 'prospect', 'inactive'),
  ('family_relationship', 'consultation', 'prospect'),
  ('family_relationship', 'consultation', 'active_client'),
  ('family_relationship', 'consultation', 'inactive'),
  ('family_relationship', 'active_client', 'past_client'),
  ('family_relationship', 'active_client', 'inactive'),
  ('family_relationship', 'past_client', 'active_client'),
  ('family_relationship', 'past_client', 'inactive'),
  ('family_relationship', 'inactive', 'prospect'),
  ('family_relationship', 'inactive', 'active_client');

INSERT INTO stage_transition_rules (dimension, from_key, to_key) VALUES
  ('job_order', 'draft', 'open'),
  ('job_order', 'draft', 'cancelled'),
  ('job_order', 'open', 'on_hold'),
  ('job_order', 'open', 'filled'),
  ('job_order', 'open', 'cancelled'),
  ('job_order', 'open', 'closed'),
  ('job_order', 'on_hold', 'open'),
  ('job_order', 'on_hold', 'cancelled'),
  ('job_order', 'on_hold', 'closed'),
  ('job_order', 'filled', 'open'),
  ('job_order', 'filled', 'closed'),
  ('job_order', 'closed', 'open');

INSERT INTO stage_transition_rules (dimension, from_key, to_key) VALUES
  ('placement', 'booked', 'started'),
  ('placement', 'booked', 'cancelled'),
  ('placement', 'started', 'ended');

-- ---------------------------------------------------------------------------------------------
-- Forms: version 1 of each form with the core sections and no owner-defined questions yet.
-- ---------------------------------------------------------------------------------------------

INSERT INTO form_definitions (key, name) VALUES
  ('family_enquiry', 'Family enquiry'),
  ('candidate_application', 'Candidate application');

INSERT INTO form_versions (form_key, version_number, status, layout, notes, published_at) VALUES
('family_enquiry', 1, 'published', '{
  "sections": [
    {"key": "contact", "title": "Your details", "core": true, "questions": []},
    {"key": "household", "title": "Your household", "core": true, "questions": []},
    {"key": "role", "title": "The support you need", "core": true, "questions": []},
    {"key": "additional", "title": "Anything else", "core": false, "questions": []}
  ],
  "requiredConsents": ["privacy_notice"],
  "optionalConsents": ["marketing_email"]
}', 'Initial version', now()),
('candidate_application', 1, 'published', '{
  "sections": [
    {"key": "contact", "title": "Contact and work location", "core": true, "questions": []},
    {"key": "experience", "title": "Childcare experience", "core": true, "questions": []},
    {"key": "employment", "title": "Employment history", "core": true, "questions": []},
    {"key": "qualifications", "title": "Qualifications and training", "core": true, "questions": []},
    {"key": "preferences", "title": "Availability and preferences", "core": true, "questions": []},
    {"key": "references", "title": "References", "core": true, "questions": []},
    {"key": "documents", "title": "Documents", "core": true, "questions": []},
    {"key": "additional", "title": "Additional questions", "core": false, "questions": []}
  ],
  "requiredConsents": ["accuracy_attestation", "privacy_notice"],
  "optionalConsents": ["reference_contact_authorization", "marketing_email"],
  "documents": {"allowedTypes": ["resume", "certificate", "photo", "introduction", "reference_letter"], "requiredTypes": []},
  "minimumReferences": 2,
  "minimumEmployments": 1
}', 'Initial version', now());

UPDATE form_definitions f SET current_version_id = v.id
FROM form_versions v WHERE v.form_key = f.key AND v.version_number = 1;

-- ---------------------------------------------------------------------------------------------
-- Interview template and screening policy (policy seeded as draft for owner approval).
-- ---------------------------------------------------------------------------------------------

INSERT INTO interview_templates (key, name, kind) VALUES ('general_screening', 'General screening interview', 'general');
INSERT INTO interview_template_versions (template_id, version_number, questions)
SELECT id, 1, '[
    {"key": "experience_overview", "prompt": "Walk through your most relevant childcare roles.", "type": "long_text"},
    {"key": "age_group_approach", "prompt": "How do you adapt care to different age groups?", "type": "long_text"},
    {"key": "safety_practices", "prompt": "Describe your safety and emergency practices.", "type": "long_text"},
    {"key": "communication", "prompt": "How do you communicate with parents day to day?", "type": "long_text"},
    {"key": "professionalism", "prompt": "Professionalism and presentation", "type": "rating"},
    {"key": "role_expectations", "prompt": "Discuss schedule, compensation and role expectations.", "type": "long_text"}
  ]'::jsonb
FROM interview_templates WHERE key = 'general_screening';
UPDATE interview_templates t SET current_version_id = v.id
FROM interview_template_versions v WHERE v.template_id = t.id AND v.version_number = 1;

INSERT INTO screening_policies (version_number, status, notes, requirements) VALUES (1, 'draft',
  'Suggested starting policy. Review with counsel and publish before presenting candidates.', '[
  {"key": "interview_general", "kind": "interview_completed", "label": "General interview completed and recommended", "params": {"interviewKind": "general", "recommendations": ["advance"]}},
  {"key": "references_two", "kind": "references_completed", "label": "Two satisfactory references", "params": {"minimum": 2}},
  {"key": "background_check", "kind": "check_reviewed", "label": "Background check reviewed as acceptable", "params": {"checkType": "background_check"}},
  {"key": "cpr_current", "kind": "qualification_current", "label": "Current verified CPR", "params": {"qualifications": ["cpr", "pediatric_cpr_first_aid"]}},
  {"key": "first_aid_current", "kind": "qualification_current", "label": "Current verified First Aid", "params": {"qualifications": ["first_aid", "pediatric_cpr_first_aid"]}}
]');

-- ---------------------------------------------------------------------------------------------
-- Legal notice placeholders (draft). These are NOT approved wording.
-- ---------------------------------------------------------------------------------------------

INSERT INTO legal_notices (notice_key, version, title, body_markdown) VALUES
  ('privacy_notice', '2026-draft-1', 'Privacy notice', 'DRAFT PLACEHOLDER. Replace with counsel-approved privacy notice before collecting real submissions.'),
  ('application_terms', '2026-draft-1', 'Application accuracy statement', 'DRAFT PLACEHOLDER. I confirm the information I provide is accurate and complete to the best of my knowledge.'),
  ('reference_authorization', '2026-draft-1', 'Reference contact authorization', 'DRAFT PLACEHOLDER. Counsel must approve reference-contact wording.'),
  ('background_authorization', '2026-draft-1', 'Background screening authorization', 'DRAFT PLACEHOLDER. Background authorization must be collected through counsel-approved disclosure and the chosen provider.'),
  ('marketing_consent', '2026-draft-1', 'Email updates', 'DRAFT PLACEHOLDER. I would like to receive occasional updates from Auren Households.'),
  ('presentation_sharing', '2026-draft-1', 'Profile sharing permission', 'DRAFT PLACEHOLDER. I permit Auren Households to share a summary of my profile with prospective families.');
