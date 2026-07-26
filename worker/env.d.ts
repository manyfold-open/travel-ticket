export interface Env {
  ASSETS: Fetcher
  TRIPS_KV: KVNamespace
  TRIPS_SITES: KVNamespace
  TRIP_JOBS: DurableObjectNamespace<import('./trip-job').TripJob>
  TRIP_TASK_QUEUE: Queue<import('./trip-job').TripQueueMessage>
  ADMIN_SETTINGS_PASSWORD?: string
  ACCESS_PASSCODE?: string

  // Manyfold A2A role peers.
  MF_API_URL: string
  MF_AGENT_ID: string
  AGENT_BRIEF?: string
  AGENT_DISCOVERY?: string
  AGENT_CONTEXT_EXTRACTOR?: string
  AGENT_COMPOSER?: string
  AGENT_THEME_DESIGNER?: string
  // Supplied through /settings or retained as a Worker secret fallback.
  MF_API_TOKEN?: string

  // Optional Composio connector configuration; see docs/operations.md.
  COMPOSIO_API_KEY?: string
  COMPOSIO_GMAIL_AUTH_CONFIG_ID?: string
  COMPOSIO_CALENDAR_AUTH_CONFIG_ID?: string
  COMPOSIO_NOTION_AUTH_CONFIG_ID?: string

  // Cloudflare native Workers Rate Limiting binding (GA) — per-IP gate on
  // POST /api/trips (worker/routes/create-trip.mjs). Optional so local/test
  // envs without the binding degrade to "not rate limited" rather than crash.
  TRIPS_RATE_LIMITER?: RateLimit
}

export interface TripJobParams {
  tripId: string
  sentence: string
  todayIso: string
  visitorId: string
  design?: { kind: 'preset'; name: string } | { kind: 'custom'; style: string }
}
