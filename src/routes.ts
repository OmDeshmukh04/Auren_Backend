import type { AnyRoute } from './http/route.js';
import { authRoutes } from './modules/auth/routes.js';
import { staffRoutes } from './modules/staff/routes.js';
import { systemRoutes } from './modules/system/routes.js';
import { familyRoutes } from './modules/families/routes.js';
import { candidateRoutes } from './modules/candidates/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { placementRoutes } from './modules/placements/routes.js';
import { applicationRoutes } from './modules/applications/routes.js';
import { documentRoutes } from './modules/documents/routes.js';
import { operationsRoutes } from './modules/operations/routes.js';
import { screeningRoutes } from './modules/screening/routes.js';
import { presentationRoutes } from './modules/presentations/routes.js';
import { automationRoutes } from './modules/automation/routes.js';
import { contentRoutes } from './modules/content/routes.js';
import { formRoutes } from './modules/forms/routes.js';
import { financeRoutes } from './modules/finance/routes.js';
import { governanceRoutes } from './modules/governance/routes.js';
import { workspaceRoutes } from './modules/workspace/routes.js';
// Codex-owned reporting contribution (src/codex/). Registered here; not edited by Claude.
import { reportRoutes } from './codex/report-routes.js';

/** Every /api/v1 route. The OpenAPI contract and permission matrix are generated from this list. */
export function allRoutes(): AnyRoute[] {
  return [...systemRoutes, ...authRoutes, ...staffRoutes, ...familyRoutes, ...candidateRoutes, ...jobRoutes, ...placementRoutes, ...applicationRoutes, ...documentRoutes, ...operationsRoutes, ...screeningRoutes, ...presentationRoutes, ...automationRoutes, ...contentRoutes, ...formRoutes, ...financeRoutes, ...governanceRoutes, ...workspaceRoutes, ...reportRoutes];
}
