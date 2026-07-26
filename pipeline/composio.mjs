// Composio adapter for user-scoped, read-only travel context. This deliberately
// uses the current SDK's direct execution API rather than the old shared MCP
// endpoint: every call carries the visitor's stable userId.
//
// Config (API key, auth config ids, CLI user id) is read from process.env by
// default so local Node callers are unaffected, but every value can be passed
// explicitly — there is no `process` global in a Cloudflare Worker, so the
// Worker must pass env.COMPOSIO_API_KEY etc. through explicitly instead of
// relying on the default.
import { Composio } from '@composio/core'

const envVar = (key) => (typeof process !== 'undefined' ? process.env[key] : undefined)

const CONNECTORS = {
  gmail: {
    toolkit: 'gmail', authConfigEnv: 'COMPOSIO_GMAIL_AUTH_CONFIG_ID',
    linkLabel: 'Gmail',
  },
  calendar: {
    toolkit: 'googlecalendar', authConfigEnv: 'COMPOSIO_CALENDAR_AUTH_CONFIG_ID',
    linkLabel: 'Google Calendar',
  },
  notion: {
    toolkit: 'notion', authConfigEnv: 'COMPOSIO_NOTION_AUTH_CONFIG_ID',
    linkLabel: 'Notion',
  },
}

export const composioEnabled = (apiKey = envVar('COMPOSIO_API_KEY')) => Boolean(apiKey)
export const connectorNames = () => Object.keys(CONNECTORS)

const requireVisitorId = (userId) => {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(userId)) {
    throw new Error('visitor_id must be a stable 8-128 character identifier containing only letters, numbers, _ or -')
  }
  return userId
}

const connector = (name) => {
  if (!CONNECTORS[name]) throw new Error(`unknown connector: ${name}`)
  return CONNECTORS[name]
}

function createComposioClient(apiKey = envVar('COMPOSIO_API_KEY')) {
  if (!apiKey) throw new Error('COMPOSIO_API_KEY not set; connector data cannot be read')
  // The SDK sends x-api-key for every backend request, including projects where
  // that header became mandatory in March 2026.
  return new Composio({ apiKey, host: 'trip-ticket-mcp' })
}

const configurationRequired = (visitorId, connectorName) => ({
  visitor_id: visitorId, connector: connectorName, status: 'configuration_required', accounts: [],
  message: 'COMPOSIO_API_KEY is not configured on this MCP server.',
})

export async function connectorStatus({ visitorId, connector: connectorName, client, apiKey = envVar('COMPOSIO_API_KEY') }) {
  const userId = requireVisitorId(visitorId)
  const config = connector(connectorName)
  if (!client && !composioEnabled(apiKey)) return configurationRequired(userId, connectorName)
  client ??= createComposioClient(apiKey)
  const accounts = await client.connectedAccounts.list({
    userIds: [userId], toolkitSlugs: [config.toolkit], statuses: ['ACTIVE'], limit: 10,
  })
  const active = accounts.items ?? []
  return {
    visitor_id: userId,
    connector: connectorName,
    status: active.length ? 'connected' : 'not_connected',
    accounts: active.map((account) => ({ id: account.id, alias: account.alias ?? null, status: account.status })),
  }
}

export async function createConnectorLink({ visitorId, connector: connectorName, client, apiKey = envVar('COMPOSIO_API_KEY'), authConfigId }) {
  const userId = requireVisitorId(visitorId)
  const config = connector(connectorName)
  if (!client && !composioEnabled(apiKey)) return configurationRequired(userId, connectorName)
  client ??= createComposioClient(apiKey)
  authConfigId ??= envVar(config.authConfigEnv)
  if (!authConfigId) {
    return {
      visitor_id: userId, connector: connectorName, status: 'configuration_required',
      message: `${config.authConfigEnv} is not configured on this MCP server; the server owner must create a read-only Composio auth config first.`,
    }
  }
  // Composio-managed OAuth must use link(), not the retired initiate() flow.
  const request = await client.connectedAccounts.link(userId, authConfigId)
  return {
    visitor_id: userId, connector: connectorName, status: 'authorization_required',
    authorization_url: request.redirectUrl, connection_request_id: request.id,
    message: `Open authorization_url and approve ${config.linkLabel}; then call connector_status or a fetch tool with the same visitor_id.`,
  }
}

async function requireConnected({ visitorId, connector: connectorName, client }) {
  const status = await connectorStatus({ visitorId, connector: connectorName, client })
  if (status.status !== 'connected') return { status, account: null }
  return { status, account: status.accounts[0] }
}

async function execute({ client, visitorId, connectedAccountId, tool, arguments: args }) {
  const result = await client.tools.execute(tool, {
    userId: visitorId, ...(connectedAccountId ? { connectedAccountId } : {}), arguments: args,
    // Composio requires pinned toolkit versions for direct execution. The
    // server deliberately opts into its documented latest-version mode until
    // owners choose to pin COMPOSIO_TOOLKIT_VERSION_* values.
    dangerouslySkipVersionCheck: true,
  })
  if (result.successful === false) throw new Error(result.error || `${tool} failed`)
  return result.data ?? result
}

export async function fetchGmailContext({ visitorId, destination, startDate, endDate, client }) {
  const connected = await requireConnected({ visitorId, connector: 'gmail', client })
  if (!connected.account) return { ...connected.status, messages: [], message: 'Gmail is not connected. Call create_connector_link first.' }
  client ??= createComposioClient()
  const destWord = String(destination || '').split(/[:,&，、]/)[0].trim()
  const query = `(booking OR reservation OR confirmation OR itinerary OR e-ticket OR 訂位 OR 訂房 OR 確認) ${destWord} newer_than:180d`
  const listed = await execute({ client, visitorId, connectedAccountId: connected.account.id, tool: 'GMAIL_FETCH_EMAILS', arguments: { query, max_results: 20, verbose: false, include_payload: false } })
  const messages = (listed?.messages ?? []).filter((message) => message?.messageId).slice(0, 10)
  const details = []
  for (const message of messages) {
    try {
      const full = await execute({ client, visitorId, connectedAccountId: connected.account.id, tool: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', arguments: { message_id: message.messageId, format: 'full' } })
      details.push({
        id: message.messageId, subject: full?.subject ?? message.subject ?? '', from: full?.from ?? '', date: full?.date ?? '',
        text: String(full?.messageText ?? full?.snippet ?? '').slice(0, 4000),
      })
    } catch (error) {
      details.push({ id: message.messageId, error: `Could not fetch this message: ${error.message}` })
    }
  }
  return { ...connected.status, query, trip_window: startDate && endDate ? `${startDate} to ${endDate}` : null, message_count: details.length, messages: details }
}

export async function fetchCalendarContext({ visitorId, startDate, endDate, client }) {
  const connected = await requireConnected({ visitorId, connector: 'calendar', client })
  if (!connected.account) return { ...connected.status, events: [], message: 'Google Calendar is not connected. Call create_connector_link first.' }
  client ??= createComposioClient()
  const data = await execute({ client, visitorId, connectedAccountId: connected.account.id, tool: 'GOOGLECALENDAR_EVENTS_LIST', arguments: {
    calendarId: 'primary', timeMin: `${startDate}T00:00:00Z`, timeMax: `${endDate}T23:59:59Z`, singleEvents: true, orderBy: 'startTime', maxResults: 50,
  } })
  const events = (data?.items ?? data?.events ?? []).map((event) => ({
    title: event.summary ?? '(untitled)', start: event.start?.dateTime ?? event.start?.date ?? '', end: event.end?.dateTime ?? event.end?.date ?? '',
    all_day: Boolean(event.start?.date && !event.start?.dateTime), location: event.location ?? '', description: event.description ?? '',
  }))
  return { ...connected.status, events }
}

export async function fetchNotionContext({ visitorId, destination, client }) {
  const connected = await requireConnected({ visitorId, connector: 'notion', client })
  if (!connected.account) return { ...connected.status, pages: [], message: 'Notion is not connected. Call create_connector_link first.' }
  client ??= createComposioClient()
  const query = String(destination || '').split(/[:,&，、]/)[0].trim()
  const found = await execute({ client, visitorId, connectedAccountId: connected.account.id, tool: 'NOTION_SEARCH_NOTION_PAGE', arguments: { query, page_size: 5, filter_value: 'page' } })
  const pages = []
  for (const page of (found?.results ?? []).filter((item) => item?.id).slice(0, 3)) {
    try {
      const detail = await execute({ client, visitorId, connectedAccountId: connected.account.id, tool: 'NOTION_GET_PAGE_MARKDOWN', arguments: { page_id: page.id } })
      pages.push({ id: page.id, title: page.title ?? page.id, markdown: String(detail?.markdown ?? '').slice(0, 6000) })
    } catch (error) {
      pages.push({ id: page.id, title: page.title ?? page.id, error: `Could not read this page: ${error.message}` })
    }
  }
  return { ...connected.status, query, pages }
}

// Adapter for the local CLI pipeline. It deliberately requires
// COMPOSIO_USER_ID: no implicit or shared account is ever selected.
export async function mcpSession({ userId = envVar('COMPOSIO_USER_ID'), client, apiKey = envVar('COMPOSIO_API_KEY') } = {}) {
  const visitorId = requireVisitorId(userId)
  client ??= createComposioClient(apiKey)
  return {
    execToolkitTool: (tool, args) => execute({ client, visitorId, tool, arguments: args }),
  }
}
