/**
 * Agent sessions: their state and items on disk (DRAWER_DATA/sessions), the routes people use, and
 * the routes an agent runner uses. docs/SPEC.md → Agent sessions.
 */
import { SessionManager } from "./manager.ts";
import type { Sessions, SessionsOptions } from "./types.ts";

export { registerSessionRoutes } from "./routes.ts";
export type { RunnerQuery, Sessions, SessionsOptions } from "./types.ts";

export function createSessions(opts: SessionsOptions): Sessions {
  return new SessionManager(opts);
}
