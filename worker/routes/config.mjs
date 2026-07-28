// GET /api/config exposes only public configuration and readiness metadata.
// Secret values never leave the Worker.
import { jsonResponse } from '../http.mjs'

export async function handleConfig(env) {
  const pipelineReady = Boolean(
    env.MF_API_URL
    && env.MF_AGENT_ID
    && env.MF_API_TOKEN
    && env.AGENT_BRIEF
    && env.AGENT_DISCOVERY
    && env.AGENT_COMPOSER
    && env.AGENT_THEME_DESIGNER,
  )
  const manyfoldReady = pipelineReady
  return jsonResponse({
    ready: manyfoldReady,
    services: {
      manyfold: manyfoldReady,
      connectors: false,
    },
  }, 200)
}
