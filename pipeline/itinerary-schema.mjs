// Contract shared by MCP clients and the renderer. Planning belongs to the
// connected client model; this server only validates and prints the result.
import crypto from 'node:crypto'
import { DEFAULT_LANGUAGE, normalizeLanguage } from './language.mjs'

export const ITINERARY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['destination', 'destination_timezone', 'home_timezone', 'days'],
  properties: {
    artifact_type: { const: 'final_itinerary' },
    trip_id: { type: 'string', description: 'Optional. The server creates a stable id when omitted.' },
    slug: { type: 'string', description: 'Optional URL-safe label. The server derives one when omitted.' },
    destination: { type: 'string' },
    destination_timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Tokyo.' },
    home_timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/London.' },
    travellers: { type: ['number', 'string'] },
    language: { enum: ['en-GB', 'zh-CN'], description: 'Language used for all user-facing itinerary copy.' },
    summary: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    cover: { type: 'object' },
    days: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['date', 'title', 'base', 'items'],
        properties: {
          date: { type: 'string', description: 'Local calendar date, YYYY-MM-DD.' },
          title: { type: 'string' }, base: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object', required: ['variant', 'type', 'title', 'start_utc', 'end_utc', 'location'],
              properties: {
                variant: { enum: ['both', 'relaxed', 'full'] },
                type: { type: 'string', description: 'travel, sight, meal, rest, or another display label.' },
                title: { type: 'string' }, start_utc: { type: 'string', format: 'date-time' }, end_utc: { type: 'string', format: 'date-time' },
                timezone: { type: 'string' }, location: { type: 'string' }, transport_minutes: { type: 'number' },
                notes: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
}

export const ITINERARY_EXAMPLE = {
  artifact_type: 'final_itinerary',
  destination: 'Japan: Kyoto', destination_timezone: 'Asia/Tokyo', home_timezone: 'Europe/London',
  travellers: 2, summary: 'A relaxed three-day Kyoto itinerary.', warnings: ['Verify opening hours and transport before booking.'], language: DEFAULT_LANGUAGE,
  cover: { title_top: 'Kyoto', title_accent: 'Autumn', eyebrow: 'Maple leaves and slow meals' },
  days: [{
    date: '2026-11-10', title: 'Arrival and Gion', base: 'Kyoto',
    items: [{
      variant: 'both', type: 'sight', title: 'Gion evening walk', start_utc: '2026-11-10T08:00:00Z', end_utc: '2026-11-10T09:30:00Z',
      timezone: 'Asia/Tokyo', location: 'Gion, Kyoto', transport_minutes: 20, notes: 'Keep the first evening light.', sources: ['Kyoto City Tourism'],
    }],
  }],
}

const slugify = (value) => String(value || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trip'
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function normalizeItinerary(input) {
  if (!isObject(input)) throw new Error('itinerary must be an object')
  const itinerary = structuredClone(input)
  for (const key of ['destination', 'destination_timezone', 'home_timezone']) {
    if (typeof itinerary[key] !== 'string' || !itinerary[key].trim()) throw new Error(`itinerary.${key} must be a non-empty string`)
  }
  if (!Array.isArray(itinerary.days) || !itinerary.days.length) throw new Error('itinerary.days must contain at least one day')
  for (const [dayIndex, day] of itinerary.days.entries()) {
    if (!isObject(day) || !/^\d{4}-\d{2}-\d{2}$/.test(day.date || '')) throw new Error(`itinerary.days[${dayIndex}].date must be YYYY-MM-DD`)
    if (typeof day.title !== 'string' || typeof day.base !== 'string' || !Array.isArray(day.items)) throw new Error(`itinerary.days[${dayIndex}] must include title, base, and items`)
    for (const [itemIndex, item] of day.items.entries()) {
      const prefix = `itinerary.days[${dayIndex}].items[${itemIndex}]`
      if (!isObject(item) || !['both', 'relaxed', 'full'].includes(item.variant)) throw new Error(`${prefix}.variant must be both, relaxed, or full`)
      for (const key of ['type', 'title', 'start_utc', 'end_utc', 'location']) if (typeof item[key] !== 'string' || !item[key]) throw new Error(`${prefix}.${key} must be a non-empty string`)
      if (Number.isNaN(Date.parse(item.start_utc)) || Number.isNaN(Date.parse(item.end_utc))) throw new Error(`${prefix} start_utc/end_utc must be ISO date-times`)
    }
  }
  itinerary.artifact_type = 'final_itinerary'
  itinerary.language = normalizeLanguage(itinerary.language)
  itinerary.trip_id = typeof itinerary.trip_id === 'string' && itinerary.trip_id ? itinerary.trip_id : `mcp_${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${crypto.randomUUID().slice(0, 8)}`
  itinerary.slug = typeof itinerary.slug === 'string' && itinerary.slug ? itinerary.slug : `${slugify(itinerary.destination)}-${itinerary.days[0].date.slice(0, 4)}`
  itinerary.status ??= 'draft'
  itinerary.summary ??= ''
  itinerary.warnings ??= []
  itinerary.sources ??= []
  itinerary.actions_suggested ??= []
  itinerary.alternatives ??= {}
  itinerary.context ??= { bookings: [], calendar_events: [], travel_notes: [] }
  return itinerary
}
