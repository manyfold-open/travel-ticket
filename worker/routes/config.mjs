// GET /api/config exposes only public configuration and readiness metadata.
// Secret values never leave the Worker.
import { jsonResponse } from '../http.mjs'
import { resolveRoleCredentials } from '../mf/store.mjs'

export async function handleConfig(env) {
  // This route is unauthenticated, so it reports counts and coarse reasons
  // only: never an agent name, a host, or anything token-shaped.
  const readiness = await resolveRoleCredentials(env).catch(() => null)
  const manyfoldReady = Boolean(readiness?.ok)
  return jsonResponse({
    ready: manyfoldReady,
    manyfold: {
      roles_assigned: Object.keys(readiness?.credentials ?? {}).length,
      needs_reconnect: Boolean(readiness && !readiness.ok),
      problems: (readiness?.problems ?? []).map(problem => ({ role: problem.role, reason: problem.reason })),
    },
    services: {
      manyfold: manyfoldReady,
      connectors: false,
    },
  }, 200)
}
