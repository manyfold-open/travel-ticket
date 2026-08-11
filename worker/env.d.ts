export interface Env {
  ASSETS: Fetcher
  TRIPS_KV: KVNamespace
  TRIPS_SITES: KVNamespace
  TRIP_JOBS: DurableObjectNamespace<import('./trip-job').TripJob>
  TRIP_TASK_QUEUE: Queue<import('./trip-job').TripQueueMessage>
  ADMIN_SETTINGS_PASSWORD?: string
  ACCESS_PASSCODE?: string

  // Manyfold connect. Agents are authorized through the device-code handshake
  // (worker/mf/connect.mjs); there are no agent ids or API tokens here any more.
  /** Origin only: the connect routes append /api/connect/a2a/... themselves. */
  MANYFOLD_API_BASE_URL?: string
  /** 'production' turns on the https-only and private-address URL checks. */
  ENVIRONMENT?: string
  /** Seals stored agent credentials. Deliberately separate from the admin password. */
  MF_CONNECT_KEY?: string

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
  language: 'en-GB' | 'zh-CN'
  design?: { kind: 'preset'; name: string } | { kind: 'custom'; style: string }
  agentBinding?: { agentName?: string; mode?: 'direct' }
}

export interface TripAgentBinding {
  status: 'connected'
  mode: 'direct'
  agentName?: string
  connectedAt?: string
}

/** One role's stored credential. The bearer stays sealed. */
export interface SealedCredential {
  rpcUrl: string
  tokenCt: string
  tokenIv: string
  name?: string
  expiresAt?: string | null
}

export type MfRole = 'brief' | 'discovery' | 'composer' | 'theme'

export type TripAgentCredentials = Partial<Record<MfRole, SealedCredential>>
