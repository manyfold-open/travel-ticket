// GET /api/config exposes only public configuration and readiness metadata.
// Secret values never leave the Worker.
import { jsonResponse } from '../http.mjs'

export async function handleConfig(env) {
  const manyfoldReady = Boolean(
    env.MF_API_URL
    && env.MF_AGENT_ID
    && env.MF_API_TOKEN
    && env.AGENT_BRIEF
    && env.AGENT_DISCOVERY
    && env.AGENT_CONTEXT_EXTRACTOR
    && env.AGENT_COMPOSER
    && env.AGENT_THEME_DESIGNER,
  )
  const turnstileReady = Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY)
  return jsonResponse({
    turnstile_site_key: env.TURNSTILE_SITE_KEY ?? null,
    ready: manyfoldReady && turnstileReady,
    services: {
      manyfold: manyfoldReady,
      turnstile: turnstileReady,
      connectors: Boolean(env.COMPOSIO_API_KEY),
    },
  }, 200)
}
