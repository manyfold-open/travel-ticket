import { runStructuredJson } from './runtime.mjs'

export const CONNECTOR_NAMES = ['gmail', 'calendar', 'notion']

const PROVIDER_STATUS = ['connected', 'authorization_required', 'not_connected', 'configuration_required', 'error']

const PROVIDER_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: PROVIDER_STATUS },
    message: { type: 'string' },
    authorization_url: { type: 'string' },
  },
  required: ['status', 'message', 'authorization_url'],
  additionalProperties: false,
}

const BOOKINGS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      vendor: { type: 'string' },
      confirmation_no: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      location: { type: 'string' },
      pax: { type: 'integer' },
    },
    required: ['type', 'vendor', 'confirmation_no', 'start', 'end', 'location', 'pax'],
    additionalProperties: false,
  },
}

const CALENDAR_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      all_day: { type: 'boolean' },
      location: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['title', 'start', 'end', 'all_day', 'location', 'description'],
    additionalProperties: false,
  },
}

const NOTES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      note: { type: 'string' },
      location: { type: 'string' },
      url: { type: 'string' },
      category: { type: 'string' },
    },
    required: ['title', 'note', 'location', 'url', 'category'],
    additionalProperties: false,
  },
}

export const CONNECTOR_AGENT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'skipped', 'error'] },
    message: { type: 'string' },
    providers: {
      type: 'object',
      properties: Object.fromEntries(CONNECTOR_NAMES.map(name => [name, PROVIDER_SCHEMA])),
      required: CONNECTOR_NAMES,
      additionalProperties: false,
    },
    bookings: BOOKINGS_SCHEMA,
    calendar_events: CALENDAR_SCHEMA,
    travel_notes: NOTES_SCHEMA,
  },
  required: ['status', 'message', 'providers', 'bookings', 'calendar_events', 'travel_notes'],
  additionalProperties: false,
}

const SYSTEM = [
  'You are the Connector Context Agent for Travel Ticket.',
  'You own the user\'s Gmail, Google Calendar, and Notion connections through the Manyfold Connector layer.',
  'The Travel Ticket service does not have Composio credentials and must never be asked to provide them.',
  'Use your own configured connector tools when the requested operation needs private data.',
  'For link, create or return the provider authorization URL through your own connector layer.',
  'For fetch_context, return only data from the user\'s connected accounts. Never invent bookings, events, notes, or credentials.',
  'If a provider is not connected, return its status and empty output for that provider.',
  'Always return one JSON object that validates against the supplied schema. Use empty strings for unavailable optional text fields.',
].join(' ')

const emptyProvider = () => ({ status: 'not_connected', message: '', authorization_url: '' })

function normalizeProvider(value) {
  if (!value || typeof value !== 'object') return emptyProvider()
  return {
    status: PROVIDER_STATUS.includes(value.status) ? value.status : 'error',
    message: typeof value.message === 'string' ? value.message : '',
    authorization_url: typeof value.authorization_url === 'string' ? value.authorization_url : '',
  }
}

function normalizeResult(value) {
  const providers = Object.fromEntries(CONNECTOR_NAMES.map(name => [name, normalizeProvider(value?.providers?.[name])]))
  return {
    status: value?.status === 'ok' || value?.status === 'skipped' || value?.status === 'error' ? value.status : 'error',
    message: typeof value?.message === 'string' ? value.message : '',
    providers,
    bookings: Array.isArray(value?.bookings) ? value.bookings : [],
    calendar_events: Array.isArray(value?.calendar_events) ? value.calendar_events : [],
    travel_notes: Array.isArray(value?.travel_notes) ? value.travel_notes : [],
  }
}

function requestText({ action, provider, visitorId, tripId, brief, providers, agentBinding }) {
  const subject = `travel-ticket:${visitorId}`
  return [
    `Operation: ${action}`,
    `External user subject: ${subject}`,
    `Trip id: ${tripId || ''}`,
    `Host Manyfold agent: ${agentBinding?.agentId || 'not-bound'}`,
    `Host Manyfold agent name: ${agentBinding?.agentName || ''}`,
    `Provider: ${provider || 'all'}`,
    `Requested providers: ${(providers ?? CONNECTOR_NAMES).join(', ')}`,
    `Trip brief: ${JSON.stringify(brief ?? {})}`,
    'Use the host Manyfold agent as the owner of connector access. Treat the external user subject only as a legacy correlation value. Do not expose provider credentials or raw secrets in the response.',
  ].join('\n')
}

export async function runConnectorAgent(ctx, request) {
  if (!ctx) throw new Error('Manyfold context agent is not configured')
  const result = await runStructuredJson(ctx, {
    system: SYSTEM,
    prompt: requestText(request),
    schema: CONNECTOR_AGENT_SCHEMA,
  })
  return normalizeResult(result)
}

export function providerResult(result, provider) {
  const item = result?.providers?.[provider] ?? emptyProvider()
  return {
    connected: item.status === 'connected',
    status: item.status,
    message: item.message,
    ...(item.authorization_url ? { authorization_url: item.authorization_url } : {}),
  }
}

export function emptyConnectorContext(message = '') {
  return {
    status: 'skipped',
    message,
    providers: Object.fromEntries(CONNECTOR_NAMES.map(name => [name, emptyProvider()])),
    bookings: [],
    calendar_events: [],
    travel_notes: [],
  }
}
