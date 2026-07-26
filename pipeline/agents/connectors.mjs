import { composioEnabled, mcpSession } from '../composio.mjs'
import { runStructuredJson } from './runtime.mjs'

const BOOKINGS_SCHEMA = {
  type: 'object',
  properties: {
    bookings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['flight', 'hotel', 'train', 'car', 'activity'] },
          vendor: { type: 'string' },
          confirmation_no: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          location: { type: 'string' },
          pax: { type: 'integer' },
        },
        required: ['type', 'vendor'],
      },
    },
  },
  required: ['bookings'],
}

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    travel_notes: {
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
        required: ['title'],
      },
    },
  },
  required: ['travel_notes'],
}

const BOOKING_EXTRACTION_SYSTEM = 'You extract travel bookings from emails. Only extract fields literally present in the text; leave missing fields as empty string / omit. NEVER invent vendors, confirmation numbers or dates. If no real bookings, return {"bookings":[]}.'

export async function runTravelContextAgent(ctx, brief, deps = {}) {
  if (!composioEnabled(deps.composioApiKey)) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; booking emails were not checked.', bookings: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession({ apiKey: deps.composioApiKey }))
    const destination = String(brief?.destination || '').split(/[:,&，、]/)[0].trim()
    const query = `(booking OR reservation OR confirmation OR itinerary OR e-ticket OR 訂位 OR 訂房 OR 確認) ${destination} newer_than:180d`
    const list = await session.execToolkitTool('GMAIL_FETCH_EMAILS', {
      query,
      max_results: 20,
      verbose: false,
      include_payload: false,
    })
    const messages = (list?.messages ?? []).filter(message => message?.messageId)
    if (!messages.length) {
      return { status: 'ok', confidence: 0.6, notes: 'No booking-looking emails found in the last 180 days.', bookings: [] }
    }

    const bodies = []
    for (const message of messages.slice(0, 10)) {
      try {
        const full = await session.execToolkitTool('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', {
          message_id: message.messageId,
          format: 'full',
        })
        const text = full?.messageText ?? full?.snippet ?? JSON.stringify(full).slice(0, 2000)
        bodies.push(`--- EMAIL (subject: ${full?.subject ?? message.subject ?? ''}) ---\n${String(text).slice(0, 4000)}`)
      } catch {
        // One unreadable message should not discard the remaining context.
      }
    }
    if (!bodies.length) {
      return { status: 'ok', confidence: 0.5, notes: 'Emails found but none could be fetched in full.', bookings: [] }
    }

    const llm = deps.llm ?? (request => runStructuredJson(ctx, request))
    const request = {
      system: BOOKING_EXTRACTION_SYSTEM,
      prompt: `Trip: ${brief.destination}, ${brief.start_date}→${brief.end_date}.\n\n${bodies.join('\n\n')}`,
      schema: BOOKINGS_SCHEMA,
    }
    const extracted = await retryStructuredCall(llm, request)
    const bookings = Array.isArray(extracted?.bookings) ? extracted.bookings : []
    return {
      status: 'ok',
      confidence: bookings.length ? 0.75 : 0.6,
      notes: `Checked ${bodies.length} emails; extracted ${bookings.length} booking(s).`,
      bookings,
    }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Gmail check skipped: ${error.message}`, bookings: [] }
  }
}

export async function runCalendarAgent(_ctx, brief, deps = {}) {
  if (!composioEnabled(deps.composioApiKey)) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; fixed events were not checked.', events: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession({ apiKey: deps.composioApiKey }))
    const data = await session.execToolkitTool('GOOGLECALENDAR_EVENTS_LIST', {
      calendarId: 'primary',
      timeMin: `${brief.start_date}T00:00:00Z`,
      timeMax: `${brief.end_date}T23:59:59Z`,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    })
    const items = data?.items ?? data?.events ?? []
    const events = items.map(event => ({
      title: event.summary ?? '(untitled)',
      start: event.start?.dateTime ?? event.start?.date ?? '',
      end: event.end?.dateTime ?? event.end?.date ?? '',
      all_day: Boolean(event.start?.date && !event.start?.dateTime),
    }))
    return {
      status: 'ok',
      confidence: 0.9,
      notes: `Found ${events.length} calendar event(s) inside the trip window.`,
      events,
    }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Calendar check skipped: ${error.message}`, events: [] }
  }
}

export async function runNotionAgent(ctx, brief, deps = {}) {
  if (!composioEnabled(deps.composioApiKey)) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; Notion notes were not checked.', travel_notes: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession({ apiKey: deps.composioApiKey }))
    const destination = String(brief?.destination || '').split(/[:,&，、]/)[0].trim()
    const found = await session.execToolkitTool('NOTION_SEARCH_NOTION_PAGE', {
      query: destination,
      page_size: 5,
      filter_value: 'page',
    })
    const pages = (found?.results ?? []).filter(page => page?.id)
    if (!pages.length) {
      return { status: 'ok', confidence: 0.6, notes: 'No Notion pages matched the destination.', travel_notes: [] }
    }

    const markdownPages = []
    for (const page of pages.slice(0, 3)) {
      try {
        const markdown = await session.execToolkitTool('NOTION_GET_PAGE_MARKDOWN', { page_id: page.id })
        markdownPages.push(`--- PAGE: ${page.title ?? page.id} ---\n${String(markdown?.markdown ?? '').slice(0, 6000)}`)
      } catch {
        // One unreadable page should not discard the remaining context.
      }
    }
    if (!markdownPages.length) {
      return { status: 'ok', confidence: 0.5, notes: 'Notion pages found but none readable.', travel_notes: [] }
    }

    const llm = deps.llm ?? (request => runStructuredJson(ctx, request))
    const request = {
      system: 'You extract travel-relevant notes (POIs, restaurants, bookings, checklists) from the user\'s own Notion pages. Only extract what is literally present; never invent. Empty array if nothing relevant.',
      prompt: `Trip: ${brief.destination}, ${brief.start_date}→${brief.end_date}.\n\n${markdownPages.join('\n\n')}`,
      schema: NOTES_SCHEMA,
    }
    const extracted = await retryStructuredCall(llm, request)
    const travelNotes = Array.isArray(extracted?.travel_notes) ? extracted.travel_notes : []
    return {
      status: 'ok',
      confidence: travelNotes.length ? 0.7 : 0.6,
      notes: `Read ${markdownPages.length} Notion page(s); extracted ${travelNotes.length} note(s).`,
      travel_notes: travelNotes,
    }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Notion check skipped: ${error.message}`, travel_notes: [] }
  }
}

async function retryStructuredCall(llm, request) {
  try {
    return await llm(request)
  } catch {
    try {
      return await llm(request)
    } catch {
      return null
    }
  }
}
