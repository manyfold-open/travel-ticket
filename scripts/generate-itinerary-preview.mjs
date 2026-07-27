// Switzerland 2026 demo itinerary. The HTML/CSS/animation rendering lives in
// pipeline/render.mjs (shared with the orchestrator pipeline); this file only
// holds the demo trip data and cover copy.
import fs from 'node:fs'
import path from 'node:path'
import { renderItinerary } from '../pipeline/render-local.mjs'

const tripId = 'trip_20260702T142412Z_470b657c'
const root = process.cwd()

const toUtc = (localIsoZurich) => {
  const d = new Date(localIsoZurich)
  return d.toISOString().replace('.000Z', 'Z')
}

const item = (date, start, end, type, title, opts = {}) => ({
  variant: opts.variant ?? 'both',
  type,
  title,
  start_utc: toUtc(`${date}T${start}:00+02:00`),
  end_utc: toUtc(`${date}T${end}:00+02:00`),
  timezone: 'Europe/Zurich',
  location: opts.location ?? '',
  transport_minutes: opts.transport_minutes ?? 0,
  notes: opts.notes ?? '',
  sources: opts.sources ?? [],
})

const itinerary = {
  artifact_type: 'final_itinerary',
  trip_id: tripId,
  status: 'partial',
  language: 'en-GB',
  destination: 'Switzerland: Lucerne, Interlaken, Lauterbrunnen',
  slug: 'switzerland-lucerne-interlaken-lauterbrunnen-2026',
  home_timezone: 'Europe/London',
  destination_timezone: 'Europe/Zurich',
  utc_timezone: 'UTC',
  travellers: 2,
  body_clock: {
    label: 'Body Clock',
    based_on_timezone: 'Europe/London',
    rule: 'Switzerland is 1 hour ahead of London in this period. Subtract 1 hour from local Swiss time.',
  },
  summary: 'Two travellers take the train from London to Switzerland from 16 to 20 July, using no car and keeping the pace relaxed: two nights in Lucerne, then Interlaken as a Jungfrau base, a Lauterbrunnen day and a final train journey back to London. This is a demo planning preview: Gmail had no expected confirmations and Google Calendar had no fixed events in the date range.',
  agent_statuses: [
    { agent: 'Travel Context Agent', status: 'partial', confidence: 0.75, notes: 'Demo mode: Composio Gmail was searched and no booking confirmations were expected/found.' },
    { agent: 'Calendar Agent', status: 'completed', confidence: 0.95, notes: 'Composio Google Calendar connected and read successfully; no events found in the trip window.' },
    { agent: 'Timezone Agent', status: 'completed', confidence: 0.99, notes: 'London BST UTC+1, Switzerland CEST UTC+2; no DST change during trip.' },
    { agent: 'Local Discovery Agent', status: 'failed', confidence: 0, notes: 'Task orphaned before terminal output. Orchestrator supplied official-source local discovery.' },
    { agent: 'Itinerary Composer Agent', status: 'timeout', confidence: 0, notes: 'Composer did not return in time; Orchestrator composed the final JSON and HTML locally.' },
  ],
  warnings: [
    'Demo mode: Gmail contains no confirmed flight, train, hotel, or reservation email for this Switzerland trip.',
    'Google Calendar was read successfully and returned no fixed events for 2026-07-16 to 2026-07-20.',
    'Long-distance train times are planning placeholders. Verify Eurostar, TGV Lyria, and SBB schedules before booking.',
    'Mountain lifts, lake cruises, and scenic railways are weather/season dependent; check operating status the day before.',
    'Evenings are kept light because Switzerland 22:00 equals London body clock 21:00.',
  ],
  sources: [
    { label: 'Eurostar official', url: 'https://www.eurostar.com/us-en', agent: 'local_discovery_orchestrator', confidence: 0.72 },
    { label: 'TGV Lyria Paris-Basel', url: 'https://www.tgv-lyria.com/fr/en/destination/train-route/paris-basel', agent: 'local_discovery_orchestrator', confidence: 0.72 },
    { label: 'TGV Lyria Paris-Zurich', url: 'https://www.tgv-lyria.com/fr/en/destination/train-route/paris-zurich', agent: 'local_discovery_orchestrator', confidence: 0.72 },
    { label: 'SBB timetable', url: 'https://www.sbb.ch/en', agent: 'local_discovery_orchestrator', confidence: 0.72 },
    { label: 'Lake Lucerne timetable', url: 'https://www.lakelucerne.ch/en/information/timetable/', agent: 'local_discovery_orchestrator', confidence: 0.72 },
    { label: 'Jungfrau Harder Kulm', url: 'https://www.jungfrau.ch/en-gb/harder-kulm/', agent: 'local_discovery_orchestrator', confidence: 0.72 },
    { label: 'Jungfrau operating info', url: 'https://www.jungfrau.ch/en-gb/live/operating-info/', agent: 'local_discovery_orchestrator', confidence: 0.72 },
  ],
  days: [
    {
      date: '2026-07-16',
      title: 'London → Lucerne',
      base: 'Lucerne',
      items: [
        item('2026-07-16', '07:00', '17:30', 'travel', 'London to Lucerne by rail', { location: 'London St Pancras → Paris → Basel/Zurich → Lucerne', transport_minutes: 510, notes: 'Planning placeholder: Eurostar + TGV Lyria + SBB. Keep a Paris connection buffer and verify the actual services.', sources: ['Eurostar official', 'TGV Lyria', 'SBB'] }),
        item('2026-07-16', '18:00', '19:00', 'rest', 'Check-in and rest', { location: 'Lucerne accommodation TBD', notes: 'No accommodation confirmation was found in Gmail; verify the address and check-in details.' }),
        item('2026-07-16', '19:15', '21:00', 'meal', 'Easy dinner and lakeside walk', { location: 'Lucerne Old Town / Lake Lucerne', notes: 'Keep the arrival day light and leave the evening free after 22:00.' }),
      ],
    },
    {
      date: '2026-07-17',
      title: 'Lucerne at leisure',
      base: 'Lucerne',
      items: [
        item('2026-07-17', '09:30', '11:30', 'sight', 'Chapel Bridge, Old Town and Lion Monument', { location: 'Lucerne', notes: 'Walkable and suitable for the first full day.' }),
        item('2026-07-17', '11:45', '13:00', 'meal', 'Lunch by the lake', { location: 'Lucerne lakefront', notes: 'Leave a buffer before the afternoon.' }),
        item('2026-07-17', '13:00', '14:30', 'rest', 'Coffee and a slow break', { location: 'Lucerne', notes: 'Avoid filling every hour.' }),
        item('2026-07-17', '14:45', '17:15', 'sight', 'Short Lake Lucerne cruise', { location: 'Lake Lucerne', notes: 'The relaxed version keeps to a short cruise; check the timetable for the day.', sources: ['Lake Lucerne timetable'] }),
        item('2026-07-17', '14:30', '18:30', 'sight', 'Full version: Rigi or Pilatus', { variant: 'full', location: 'Lucerne region', transport_minutes: 90, notes: 'Add a mountain view only in good weather and keep dinner simple.' }),
        item('2026-07-17', '19:00', '20:45', 'meal', 'Dinner in Lucerne', { location: 'Lucerne', notes: 'Booking is recommended, but this tool does not book for you.' }),
      ],
    },
    {
      date: '2026-07-18',
      title: 'Lucerne → Interlaken',
      base: 'Interlaken',
      items: [
        item('2026-07-18', '09:00', '11:15', 'travel', 'Luzern-Interlaken Express', { location: 'Lucerne → Interlaken Ost', transport_minutes: 135, notes: 'Planning placeholder; verify the service with SBB.', sources: ['SBB timetable'] }),
        item('2026-07-18', '11:30', '13:00', 'meal', 'Lunch on arrival', { location: 'Interlaken', notes: 'Leave bags or check in first.' }),
        item('2026-07-18', '13:00', '15:00', 'rest', 'Check-in and afternoon break', { location: 'Interlaken accommodation TBD', notes: 'Accommodation is not yet confirmed.' }),
        item('2026-07-18', '15:15', '17:30', 'sight', 'Hohematte and the Aare riverside', { variant: 'relaxed', location: 'Interlaken', notes: 'The relaxed version avoids forcing a mountain summit.' }),
        item('2026-07-18', '15:00', '18:00', 'sight', 'Full version: Harder Kulm at sunset', { variant: 'full', location: 'Harder Kulm', transport_minutes: 30, notes: 'Check lift operations and the weather before travelling.', sources: ['Jungfrau Harder Kulm'] }),
        item('2026-07-18', '19:00', '20:45', 'meal', 'Dinner in Interlaken', { location: 'Interlaken', notes: 'Keep the evening early.' }),
      ],
    },
    {
      date: '2026-07-19',
      title: 'Lauterbrunnen Valley',
      base: 'Interlaken',
      items: [
        item('2026-07-19', '09:00', '09:30', 'travel', 'Interlaken Ost → Lauterbrunnen', { location: 'Interlaken Ost → Lauterbrunnen', transport_minutes: 30, notes: 'Short regional train; verify the service with SBB.', sources: ['SBB timetable'] }),
        item('2026-07-19', '09:45', '12:00', 'sight', 'Lauterbrunnen village and Staubbach Falls', { location: 'Lauterbrunnen', notes: 'Walk through the valley at an easy pace.' }),
        item('2026-07-19', '12:15', '13:30', 'meal', 'Valley lunch or picnic', { location: 'Lauterbrunnen', notes: 'A picnic works in good weather.' }),
        item('2026-07-19', '13:30', '15:30', 'rest', 'Relaxed version: coffee and valley walk', { variant: 'relaxed', location: 'Lauterbrunnen', notes: 'Take it slowly and return to Interlaken in the afternoon.' }),
        item('2026-07-19', '13:30', '17:00', 'sight', 'Full version: Trummelbach Falls or Murren', { variant: 'full', location: 'Lauterbrunnen / Murren', transport_minutes: 60, notes: 'Choose one to avoid overloading the valley day; check operating status.', sources: ['Jungfrau operating info'] }),
        item('2026-07-19', '16:00', '16:30', 'travel', 'Return to Interlaken', { variant: 'relaxed', location: 'Lauterbrunnen → Interlaken Ost', transport_minutes: 30, notes: 'The relaxed version returns early for a break.' }),
        item('2026-07-19', '17:30', '18:00', 'travel', 'Return to Interlaken', { variant: 'full', location: 'Lauterbrunnen → Interlaken Ost', transport_minutes: 30, notes: 'The full version returns a little later.' }),
        item('2026-07-19', '19:00', '20:45', 'meal', 'Dinner in Interlaken', { location: 'Interlaken', notes: 'Keep the final evening early.' }),
      ],
    },
    {
      date: '2026-07-20',
      title: 'Interlaken → London',
      base: 'London',
      items: [
        item('2026-07-20', '08:30', '18:30', 'travel', 'Switzerland to London by rail', { location: 'Interlaken → Basel/Zurich → Paris → London', transport_minutes: 600, notes: 'Planning placeholder: SBB + TGV Lyria + Eurostar. Avoid a morning attraction and keep a cross-border connection buffer.', sources: ['SBB timetable', 'TGV Lyria', 'Eurostar official'] }),
        item('2026-07-20', '19:00', '20:00', 'rest', 'Buffer after returning to London', { location: 'London', notes: 'Do not schedule evening work.' }),
      ],
    },
  ],
  alternatives: {
    relaxed: { notes: 'Keep the Lake Lucerne cruise, a slow Interlaken walk and valley coffee in Lauterbrunnen. Suitable for travellers who do not want to chase timetables.' },
    full: { notes: 'In good weather, add one of Rigi or Pilatus, Harder Kulm, Trummelbach or Murren, with only one major upgrade per day.' },
  },
  actions_suggested: [
    { type: 'booking_check', title: 'Verify international rail tickets', description: 'Check Eurostar, TGV Lyria and SBB services and seat requirements.', requires_approval: true },
    { type: 'booking_check', title: 'Confirm accommodation bases', description: 'Suggested bases: Lucerne from 16 to 18 July, then Interlaken or Lauterbrunnen until 20 July.', requires_approval: true },
    { type: 'calendar', title: 'Add the itinerary to Calendar', description: 'Create transport, accommodation, main activity and rest blocks after approval.', requires_approval: true },
    { type: 'gmail_draft', title: 'Draft a booking checklist email', description: 'Draft a checklist email for ticket and accommodation confirmations after approval.', requires_approval: true },
  ],
  cover: {
    title_top: 'Switzerland',
    title_accent: 'by Rail',
    eyebrow: 'Swiss rail ticket stack · UTC-first preview',
    route_label: 'No-car route',
    route_pills: ['Lucerne', 'Interlaken', 'Lauterbrunnen'],
    travellers: 2,
    stats: [
      { b: '5 days', s: '7/16-7/20' },
      { b: '3 bases', s: 'Lucerne · Interlaken · Lauterbrunnen' },
      { b: '+1 hour', s: 'Swiss time vs London' },
    ],
    route_stops: [
      { name: 'London', label: 'Start', day_index: 0 },
      { name: 'Paris transfer', label: 'Buffer', day_index: 1 },
      { name: 'Lucerne', label: 'Lake base', day_index: 2 },
      { name: 'Interlaken', label: 'Jungfrau base', day_index: 3 },
      { name: 'Lauterbrunnen', label: 'Valley day', day_index: 4 },
    ],
  },
}

itinerary.timeline_json = {
  timezones: [
    { id: 'Europe/Zurich', label: 'Destination', offset: '+02:00' },
    { id: 'Europe/London', label: 'Home Timezone', offset: '+01:00' },
    { id: 'UTC', label: 'UTC', offset: '+00:00' },
    { id: 'body_clock', label: 'Body Clock', based_on: 'Europe/London' },
  ],
  events: itinerary.days.flatMap((day) => day.items.map((it) => ({
    date: day.date,
    title: it.title,
    type: it.type,
    variant: it.variant,
    start_utc: it.start_utc,
    end_utc: it.end_utc,
    location: it.location,
    transport_minutes: it.transport_minutes,
  }))),
}

// Demo 走正規產出流程：成為最新一份（dist 根）＋收進票夾（data/trips + dist/trips）。
const tripDir = `${itinerary.slug}-${tripId.split('_').at(-1).slice(0, 4)}`
fs.mkdirSync(path.join(root, '.trip_work'), { recursive: true })
fs.mkdirSync(path.join(root, 'data', 'trips'), { recursive: true })
fs.writeFileSync(path.join(root, '.trip_work', 'final_itinerary.json'), JSON.stringify(itinerary, null, 2))
fs.writeFileSync(path.join(root, 'data', 'final_itinerary.json'), JSON.stringify(itinerary, null, 2))
fs.writeFileSync(path.join(root, 'data', 'trips', `${tripDir}.json`), JSON.stringify(itinerary, null, 2))

const manifest = await renderItinerary(itinerary, { outDir: path.join(root, 'dist') })
await renderItinerary(itinerary, { outDir: path.join(root, 'dist', 'trips', tripDir) })

console.log(JSON.stringify({
  ...manifest,
  trip_dir: tripDir,
}, null, 2))
