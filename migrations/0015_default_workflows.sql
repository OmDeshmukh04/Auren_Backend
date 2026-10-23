-- Default workflow catalogue (version 1 of each, published). Transactional acknowledgements,
-- reminders and staff tasks are enabled. Optional outreach sequences are seeded disabled, and
-- time-based external follow-ups require staff approval, until the owner reviews wording and timing.

CREATE TEMPORARY TABLE seed_workflows (key text, name text, description text, category text, trigger_event text, enabled boolean, definition jsonb) ON COMMIT DROP;

INSERT INTO seed_workflows VALUES
('family.intake', 'Family enquiry received', 'Acknowledge website enquiries, alert staff and create a response task.', 'transactional', 'enquiry.submitted', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "acknowledge", "action": "send_email", "template": "family.enquiry_acknowledgement", "recipient": "enquiry_contact", "respectQuietHours": false,
     "skipIf": [{"field": "enquiry.channel", "op": "not_equals", "value": "website"}]},
    {"key": "notify_staff", "action": "notify_staff", "template": "staff.new_enquiry", "recipients": "notification_inbox"},
    {"key": "response_task", "action": "create_task", "title": "Respond to new family enquiry", "kind": "follow_up", "priority": "high", "dueIn": {"businessDays": 1}, "assignTo": "assignee_or_owner"}
  ]
}'),
('family.response_follow_up', 'Unanswered enquiry follow-up', 'Remind staff about enquiries with no recorded response; optional approved family follow-up.', 'follow_up', 'enquiry.submitted', false, '{
  "conditions": [{"field": "enquiry.channel", "op": "equals", "value": "website"}],
  "steps": [
    {"key": "staff_reminder", "action": "create_task", "delay": {"businessDays": 2}, "title": "Enquiry still waiting for a response", "kind": "follow_up", "priority": "high", "dueIn": {"hours": 4}},
    {"key": "family_follow_up", "action": "send_email", "delay": {"businessDays": 3}, "template": "family.enquiry_follow_up", "recipient": "enquiry_contact", "approval": "required"}
  ],
  "stopOn": ["enquiry.contact_recorded", "family.reply_recorded", "consultation.scheduled", "enquiry.stage_changed:closed", "enquiry.stage_changed:converted"],
  "stopWhen": [{"field": "enquiry.stage", "op": "in", "value": ["closed", "converted", "consultation_scheduled", "consultation_completed"]}, {"field": "enquiry.firstResponseAt", "op": "is_set"}],
  "frequencyCap": {"maxExternalMessages": 2, "perDays": 14}
}'),
('family.consultation', 'Consultation confirmation and reminder', 'Confirm the booking, remind the day before and ask staff to record the outcome.', 'transactional', 'consultation.scheduled', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "confirmation", "action": "send_email", "template": "family.consultation_confirmation", "recipient": "family_primary_contact", "respectQuietHours": false},
    {"key": "reminder", "action": "send_email", "template": "family.consultation_reminder", "recipient": "family_primary_contact", "anchor": "appointment.startsAt", "delay": {"hours": -24}},
    {"key": "outcome_task", "action": "create_task", "anchor": "appointment.startsAt", "delay": {"hours": 2}, "title": "Record the consultation outcome", "kind": "follow_up", "dueIn": {"hours": 4}}
  ],
  "stopOn": ["consultation.rescheduled", "consultation.cancelled"],
  "stopWhen": [{"field": "appointment.status", "op": "in", "value": ["cancelled", "no_show", "completed"]}]
}'),
('family.after_consultation', 'After the consultation', 'Create a next-step task once the outcome is recorded.', 'staff', 'consultation.completed', true, '{
  "enrollment": "per_event",
  "steps": [{"key": "next_step", "action": "create_task", "title": "Agree the next step with the family", "kind": "follow_up", "dueIn": {"businessDays": 1}}]
}'),
('candidate.application_received', 'Candidate application received', 'Confirm receipt, alert staff and create a review task.', 'transactional', 'application.submitted', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "confirmation", "action": "send_email", "template": "candidate.application_confirmation", "recipient": "applicant", "respectQuietHours": false},
    {"key": "notify_staff", "action": "notify_staff", "template": "staff.new_application", "recipients": "notification_inbox"},
    {"key": "review_task", "action": "create_task", "title": "Review new candidate application", "kind": "review", "dueIn": {"businessDays": 2}}
  ]
}'),
('candidate.missing_information', 'Missing information request', 'Send the coordinator''s request and track the deadline.', 'transactional', 'candidate.information_requested', true, '{
  "enrollment": "per_event",
  "steps": [{"key": "request", "action": "request_information", "template": "candidate.information_request", "deadlineIn": {"days": 7}}],
  "stopOn": ["candidate.information_received"],
  "stopWhen": [{"field": "request.status", "op": "in", "value": ["received", "cancelled"]}]
}'),
('candidate.interview', 'Interview confirmation and reminder', 'Confirm, remind the day before and ask for the evaluation.', 'transactional', 'interview.scheduled', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "confirmation", "action": "send_email", "template": "candidate.interview_confirmation", "recipient": "candidate", "respectQuietHours": false},
    {"key": "reminder", "action": "send_email", "template": "candidate.interview_reminder", "recipient": "candidate", "anchor": "appointment.startsAt", "delay": {"hours": -24}},
    {"key": "evaluation_task", "action": "create_task", "anchor": "appointment.startsAt", "delay": {"hours": 2}, "title": "Record the interview evaluation", "kind": "review", "dueIn": {"businessDays": 1}}
  ],
  "stopOn": ["interview.rescheduled", "interview.cancelled"],
  "stopWhen": [{"field": "appointment.status", "op": "in", "value": ["cancelled", "no_show"]}]
}'),
('reference.outreach', 'Reference outreach', 'Email the reference after staff start outreach (permission required) and schedule a follow-up.', 'follow_up', 'reference.outreach_started', true, '{
  "steps": [
    {"key": "request", "action": "send_email", "template": "reference.request", "recipient": "reference", "respectQuietHours": true},
    {"key": "follow_up_task", "action": "create_task", "delay": {"businessDays": 3}, "title": "Follow up with the reference", "kind": "follow_up", "dueIn": {"businessDays": 1}}
  ],
  "stopOn": ["reference.completed", "reference.permission_revoked"],
  "stopWhen": [{"field": "reference.permissionToContact", "op": "equals", "value": false}, {"field": "reference.status", "op": "in", "value": ["completed", "declined", "cancelled", "unable_to_reach"]}],
  "frequencyCap": {"maxExternalMessages": 3, "perDays": 14}
}'),
('screening.background_review', 'Screening result review', 'A provider result needs an agency review; nothing is approved automatically.', 'staff', 'screening.check_completed', true, '{
  "enrollment": "per_event",
  "steps": [{"key": "review_task", "action": "create_task", "title": "Review the completed screening check", "kind": "review", "dueIn": {"businessDays": 1}}]
}'),
('candidate.qualification_expiry', 'Qualification expiring', 'Staff renewal task and an approved notice to the candidate. Sent once per expiry date.', 'transactional', 'qualification.expiring', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "staff_task", "action": "create_task", "title": "Qualification expiring soon", "kind": "renewal", "dueIn": {"businessDays": 2}},
    {"key": "candidate_notice", "action": "send_email", "template": "candidate.qualification_expiring", "recipient": "candidate", "approval": "required"}
  ],
  "stopWhen": [{"field": "candidate.archived", "op": "equals", "value": true}]
}'),
('candidate.availability_refresh', 'Availability check', 'Periodically ask eligible candidates to confirm availability (approval required).', 'follow_up', 'availability.refresh_due', false, '{
  "steps": [{"key": "ask", "action": "send_email", "template": "candidate.availability_refresh", "recipient": "candidate", "approval": "required"}],
  "stopOn": ["candidate.availability_changed", "candidate.reply_recorded"],
  "stopWhen": [{"field": "candidate.availabilityStatus", "op": "equals", "value": "unavailable"}, {"field": "candidate.archived", "op": "equals", "value": true}],
  "frequencyCap": {"maxExternalMessages": 1, "perDays": 30}
}'),
('presentation.feedback', 'Presentation feedback', 'After a release, ask staff to collect the family''s feedback.', 'staff', 'presentation.released', true, '{
  "enrollment": "per_event",
  "steps": [{"key": "feedback_task", "action": "create_task", "delay": {"businessDays": 1}, "title": "Ask the family for feedback on the presentation", "kind": "feedback", "dueIn": {"businessDays": 1}}]
}'),
('family_interview.reminders', 'Family interview reminders', 'Remind the family and the candidate the day before; collect feedback afterwards.', 'transactional', 'family_interview.scheduled', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "family_reminder", "action": "send_email", "template": "family.interview_reminder", "recipient": "family_primary_contact", "anchor": "appointment.startsAt", "delay": {"hours": -24}},
    {"key": "candidate_reminder", "action": "send_email", "template": "candidate.family_interview_reminder", "recipient": "candidate", "anchor": "appointment.startsAt", "delay": {"hours": -24}},
    {"key": "feedback_task", "action": "create_task", "anchor": "appointment.startsAt", "delay": {"hours": 3}, "title": "Record family interview feedback", "kind": "feedback", "dueIn": {"businessDays": 1}}
  ],
  "stopOn": ["family_interview.rescheduled", "family_interview.cancelled"],
  "stopWhen": [{"field": "appointment.status", "op": "in", "value": ["cancelled", "no_show"]}]
}'),
('offer.follow_up', 'Offer follow-up', 'Coordinator task on the review date (or after two business days). No automated negotiation.', 'staff', 'offer.extended', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "review_date_task", "action": "create_task", "anchor": "offer.reviewDate", "title": "Follow up on the offer", "kind": "follow_up", "dueIn": {"hours": 4}},
    {"key": "default_task", "action": "create_task", "delay": {"businessDays": 2}, "skipIf": [{"field": "offer.reviewDate", "op": "is_set"}], "title": "Follow up on the offer", "kind": "follow_up", "dueIn": {"hours": 4}}
  ],
  "stopOn": ["offer.closed"],
  "stopWhen": [{"field": "offer.status", "op": "not_equals", "value": "extended"}]
}'),
('placement.start', 'Placement start', 'Approved confirmations and check-in tasks after the start date.', 'transactional', 'placement.booked', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "family_confirmation", "action": "send_email", "template": "placement.start_confirmation_family", "recipient": "family_primary_contact", "approval": "required"},
    {"key": "candidate_confirmation", "action": "send_email", "template": "placement.start_confirmation_candidate", "recipient": "candidate", "approval": "required"},
    {"key": "first_week_check_in", "action": "create_task", "anchor": "placement.startDate", "delay": {"days": 7}, "title": "First-week placement check-in", "kind": "check_in", "dueIn": {"businessDays": 1}},
    {"key": "first_month_check_in", "action": "create_task", "anchor": "placement.startDate", "delay": {"days": 30}, "title": "One-month placement check-in", "kind": "check_in", "dueIn": {"businessDays": 2}}
  ],
  "stopOn": ["placement.start_changed", "placement.cancelled", "placement.ended"],
  "stopWhen": [{"field": "placement.status", "op": "in", "value": ["cancelled", "ended"]}]
}'),
('placement.start_changed', 'Placement start date changed', 'Re-confirm the new date and recompute check-ins.', 'transactional', 'placement.start_changed', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "family_confirmation", "action": "send_email", "template": "placement.start_confirmation_family", "recipient": "family_primary_contact", "approval": "required"},
    {"key": "candidate_confirmation", "action": "send_email", "template": "placement.start_confirmation_candidate", "recipient": "candidate", "approval": "required"},
    {"key": "first_week_check_in", "action": "create_task", "anchor": "placement.startDate", "delay": {"days": 7}, "title": "First-week placement check-in", "kind": "check_in", "dueIn": {"businessDays": 1}},
    {"key": "first_month_check_in", "action": "create_task", "anchor": "placement.startDate", "delay": {"days": 30}, "title": "One-month placement check-in", "kind": "check_in", "dueIn": {"businessDays": 2}}
  ],
  "stopOn": ["placement.start_changed", "placement.cancelled", "placement.ended"],
  "stopWhen": [{"field": "placement.status", "op": "in", "value": ["cancelled", "ended"]}]
}'),
('placement.guarantee_alert', 'Guarantee period ending', 'Warn staff before a recorded guarantee end date. Coverage is never promised automatically.', 'staff', 'placement.guarantee_ending', true, '{
  "enrollment": "per_event",
  "steps": [
    {"key": "notify", "action": "notify_staff", "template": "staff.guarantee_ending", "recipients": "assignee"},
    {"key": "task", "action": "create_task", "title": "Guarantee period ending: review the placement", "kind": "renewal", "dueIn": {"businessDays": 2}}
  ]
}'),
('placement.check_in_due', 'Scheduled check-in due', 'Task for each scheduled post-placement check-in.', 'staff', 'placement.check_in_due', true, '{
  "enrollment": "per_event",
  "steps": [{"key": "task", "action": "create_task", "title": "Complete the scheduled placement check-in", "kind": "check_in", "dueIn": {"businessDays": 1}}]
}'),
('placement.post_feedback', 'Post-placement feedback request', 'Optional feedback request a month after start (approval required).', 'follow_up', 'placement.started', false, '{
  "steps": [{"key": "feedback_request", "action": "send_email", "delay": {"days": 30}, "template": "family.post_placement_feedback", "recipient": "family_primary_contact", "approval": "required"}],
  "stopOn": ["placement.ended", "placement.cancelled"],
  "stopWhen": [{"field": "placement.status", "op": "in", "value": ["ended", "cancelled"]}],
  "frequencyCap": {"maxExternalMessages": 1, "perDays": 30}
}'),
('staff.daily_digest', 'Daily staff digest', 'One email per staff member on business days listing what is due.', 'staff', 'schedule.daily_digest', true, '{
  "enrollment": "per_event",
  "steps": [{"key": "digest", "action": "notify_staff", "template": "staff.daily_digest", "recipients": "digest_subscribers"}]
}');

INSERT INTO workflow_definitions (key, name, description, category, trigger_event, enabled, system)
SELECT key, name, description, category, trigger_event, false, true FROM seed_workflows;

INSERT INTO workflow_versions (workflow_id, version_number, status, definition, change_note, published_at)
SELECT w.id, 1, 'published', s.definition, 'Initial version', now()
FROM seed_workflows s JOIN workflow_definitions w ON w.key = s.key;

UPDATE workflow_definitions w SET current_version_id = v.id, enabled = s.enabled
FROM workflow_versions v, seed_workflows s
WHERE v.workflow_id = w.id AND v.version_number = 1 AND s.key = w.key;
