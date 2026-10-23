/**
 * Collection/action permission matrix. Every staff route declares the permission it needs and
 * the server checks it; hiding a menu item in the UI is never the access control.
 * docs/PERMISSIONS.md is generated from this file and the route table (npm run contract).
 */

export const PERMISSIONS = [
  'content.read', 'content.write', 'content.publish', 'media.write',
  'settings.read', 'settings.write',
  'staff.read', 'staff.manage',
  'forms.read', 'forms.write', 'forms.publish',
  'families.read', 'families.write',
  'enquiries.read', 'enquiries.write',
  'candidates.read', 'candidates.write',
  'screening.read', 'screening.write', 'screening.override',
  'documents.read', 'documents.write',
  'jobs.read', 'jobs.write',
  'presentations.read', 'presentations.write', 'presentations.approve', 'presentations.release',
  'placements.read', 'placements.write',
  'finance.read', 'finance.write',
  'tasks.read', 'tasks.write',
  'communications.read', 'communications.write',
  'automation.read', 'automation.write', 'automation.publish', 'automation.pause_record', 'automation.pause_global',
  'templates.read', 'templates.write', 'templates.publish',
  'reports.operational', 'reports.financial',
  'exports.create',
  'duplicates.read', 'duplicates.merge',
  'governance.read', 'governance.write',
  'audit.read',
  'notes.owner_only'
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type StaffRole = 'owner' | 'coordinator' | 'content_editor' | 'finance_viewer';
export const STAFF_ROLES: StaffRole[] = ['owner', 'coordinator', 'content_editor', 'finance_viewer'];

const COORDINATOR: Permission[] = [
  'settings.read', 'staff.read', 'forms.read',
  'families.read', 'families.write',
  'enquiries.read', 'enquiries.write',
  'candidates.read', 'candidates.write',
  'screening.read', 'screening.write',
  'documents.read', 'documents.write',
  'jobs.read', 'jobs.write',
  'presentations.read', 'presentations.write', 'presentations.approve', 'presentations.release',
  'placements.read', 'placements.write',
  'tasks.read', 'tasks.write',
  'communications.read', 'communications.write',
  'automation.read', 'automation.pause_record',
  'templates.read',
  'reports.operational',
  'duplicates.read'
];

const CONTENT_EDITOR: Permission[] = ['content.read', 'content.write', 'content.publish', 'media.write'];

const FINANCE_VIEWER: Permission[] = ['placements.read', 'finance.read', 'reports.financial'];

export const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  coordinator: new Set(COORDINATOR),
  content_editor: new Set(CONTENT_EDITOR),
  finance_viewer: new Set(FINANCE_VIEWER)
};

export const ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  owner: 'Agency owner: settings, roles, workflow publishing, exports, retention, finance and screening overrides.',
  coordinator: 'Recruiter/coordinator: families, candidates, screening, jobs, presentations and placements. No role management, finance edits or screening overrides.',
  content_editor: 'Website content and public media only. No applicant or family access.',
  finance_viewer: 'Read-only placements, invoices, payments and financial reports. No references, interviews or notes.'
};

export function hasPermission(role: StaffRole, permission: Permission) {
  return ROLE_PERMISSIONS[role].has(permission);
}
