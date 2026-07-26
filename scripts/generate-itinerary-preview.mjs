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
  summary: '兩人從倫敦搭火車前往瑞士，7/16-7/20 以不租車、不要太趕為原則：先住 Lucerne，再移動到 Interlaken 作為 Jungfrau 區域基地，安排 Lauterbrunnen 一日，最後搭火車回倫敦。此版本是 demo planning preview：Gmail 預期沒有確認信；Google Calendar 已讀取，該日期範圍沒有固定事件。',
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
        item('2026-07-16', '07:00', '17:30', 'travel', '倫敦到 Lucerne 長途火車日', { location: 'London St Pancras → Paris → Basel/Zurich → Lucerne', transport_minutes: 510, notes: '規劃 placeholder：Eurostar + TGV Lyria + SBB。建議保留 Paris 轉乘 buffer，實際班次需確認。', sources: ['Eurostar official', 'TGV Lyria', 'SBB'] }),
        item('2026-07-16', '18:00', '19:00', 'rest', '入住與休息', { location: 'Lucerne accommodation TBD', notes: '住宿未在 Gmail 找到，需確認地址與 check-in。' }),
        item('2026-07-16', '19:15', '21:00', 'meal', 'Old Town 輕鬆晚餐與湖邊散步', { location: 'Lucerne Old Town / Lake Lucerne', notes: '抵達日不排滿；22:00 後保留休息。' }),
      ],
    },
    {
      date: '2026-07-17',
      title: 'Lucerne 慢遊',
      base: 'Lucerne',
      items: [
        item('2026-07-17', '09:30', '11:30', 'sight', 'Chapel Bridge、Old Town、Lion Monument', { location: 'Lucerne', notes: '步行為主，適合第一個完整日。' }),
        item('2026-07-17', '11:45', '13:00', 'meal', '湖邊午餐', { location: 'Lucerne lakefront', notes: '保留午休前緩衝。' }),
        item('2026-07-17', '13:00', '14:30', 'rest', '午休 / 咖啡時間', { location: 'Lucerne', notes: '避免每天太滿。' }),
        item('2026-07-17', '14:45', '17:15', 'sight', 'Lake Lucerne 短程遊船', { location: 'Lake Lucerne', notes: 'Relaxed 版建議只做短程遊船；查當日 timetable。', sources: ['Lake Lucerne timetable'] }),
        item('2026-07-17', '14:30', '18:30', 'sight', 'Full 版：Rigi 或 Pilatus 半日山景', { variant: 'full', location: 'Lucerne region', transport_minutes: 90, notes: '天氣好再升級；若加山景，晚餐保持簡單。' }),
        item('2026-07-17', '19:00', '20:45', 'meal', 'Lucerne 晚餐', { location: 'Lucerne', notes: '建議預約，但目前不代訂。' }),
      ],
    },
    {
      date: '2026-07-18',
      title: 'Lucerne → Interlaken',
      base: 'Interlaken',
      items: [
        item('2026-07-18', '09:00', '11:15', 'travel', 'Luzern-Interlaken Express 景觀線', { location: 'Lucerne → Interlaken Ost', transport_minutes: 135, notes: '規劃 placeholder；實際使用 SBB 查班次。', sources: ['SBB timetable'] }),
        item('2026-07-18', '11:30', '13:00', 'meal', 'Interlaken 抵達午餐', { location: 'Interlaken', notes: '先寄放行李或入住。' }),
        item('2026-07-18', '13:00', '15:00', 'rest', '入住 / 午休', { location: 'Interlaken accommodation TBD', notes: '住宿未確認。' }),
        item('2026-07-18', '15:15', '17:30', 'sight', 'Hohematte / Aare 河邊輕鬆散步', { variant: 'relaxed', location: 'Interlaken', notes: 'Relaxed 版不強塞山頂。' }),
        item('2026-07-18', '15:00', '18:00', 'sight', 'Full 版：Harder Kulm 傍晚景觀', { variant: 'full', location: 'Harder Kulm', transport_minutes: 30, notes: '搭纜車前確認營運與天氣。', sources: ['Jungfrau Harder Kulm'] }),
        item('2026-07-18', '19:00', '20:45', 'meal', 'Interlaken 晚餐', { location: 'Interlaken', notes: '保持早點結束。' }),
      ],
    },
    {
      date: '2026-07-19',
      title: 'Lauterbrunnen Valley',
      base: 'Interlaken',
      items: [
        item('2026-07-19', '09:00', '09:30', 'travel', 'Interlaken Ost → Lauterbrunnen', { location: 'Interlaken Ost → Lauterbrunnen', transport_minutes: 30, notes: '短程區域列車，實際班次查 SBB。', sources: ['SBB timetable'] }),
        item('2026-07-19', '09:45', '12:00', 'sight', 'Lauterbrunnen 村與 Staubbach Falls', { location: 'Lauterbrunnen', notes: '山谷步行，節奏放慢。' }),
        item('2026-07-19', '12:15', '13:30', 'meal', '山谷午餐 / 野餐', { location: 'Lauterbrunnen', notes: '天氣好可野餐。' }),
        item('2026-07-19', '13:30', '15:30', 'rest', 'Relaxed 版：咖啡與山谷慢走', { variant: 'relaxed', location: 'Lauterbrunnen', notes: '不趕景點，下午回 Interlaken。' }),
        item('2026-07-19', '13:30', '17:00', 'sight', 'Full 版：Trummelbach Falls 或 Murren 加碼', { variant: 'full', location: 'Lauterbrunnen / Murren', transport_minutes: 60, notes: '二選一即可，避免把山谷日排太滿；查營運狀態。', sources: ['Jungfrau operating info'] }),
        item('2026-07-19', '16:00', '16:30', 'travel', '回 Interlaken', { variant: 'relaxed', location: 'Lauterbrunnen → Interlaken Ost', transport_minutes: 30, notes: 'Relaxed 版早回休息。' }),
        item('2026-07-19', '17:30', '18:00', 'travel', '回 Interlaken', { variant: 'full', location: 'Lauterbrunnen → Interlaken Ost', transport_minutes: 30, notes: 'Full 版晚一點回。' }),
        item('2026-07-19', '19:00', '20:45', 'meal', 'Interlaken 晚餐', { location: 'Interlaken', notes: '最後一晚，仍避免太晚。' }),
      ],
    },
    {
      date: '2026-07-20',
      title: 'Interlaken → London',
      base: 'London',
      items: [
        item('2026-07-20', '08:30', '18:30', 'travel', '瑞士回倫敦長途火車日', { location: 'Interlaken → Basel/Zurich → Paris → London', transport_minutes: 600, notes: '規劃 placeholder：SBB + TGV Lyria + Eurostar。建議不要排早晨景點，並保留跨國轉乘 buffer。', sources: ['SBB timetable', 'TGV Lyria', 'Eurostar official'] }),
        item('2026-07-20', '19:00', '20:00', 'rest', '回倫敦後緩衝', { location: 'London', notes: '不要安排晚間工作。' }),
      ],
    },
  ],
  alternatives: {
    relaxed: { notes: '保留 Lucerne 湖船、Interlaken 慢走、Lauterbrunnen 山谷咖啡時間。適合不想每天追班次。' },
    full: { notes: '在天氣好時加入 Rigi/Pilatus、Harder Kulm、Trummelbach 或 Murren，但每天只升級一個重點。' },
  },
  actions_suggested: [
    { type: 'booking_check', title: '確認跨國火車票', description: '查 Eurostar、TGV Lyria、SBB 實際班次與座位需求。', requires_approval: true },
    { type: 'booking_check', title: '確認住宿基地', description: '建議 7/16-7/18 Lucerne，7/18-7/20 Interlaken 或 Lauterbrunnen。', requires_approval: true },
    { type: 'calendar', title: '寫入行程到 Calendar', description: '可建立交通、住宿、每日主要活動與休息 block。', requires_approval: true },
    { type: 'gmail_draft', title: '建立訂票/住宿確認清單草稿', description: '可草擬一封 checklist email，但需你批准後才建立。', requires_approval: true },
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
