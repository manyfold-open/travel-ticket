// Portable language contract shared by the Worker, local Studio and renderer.
// OpenCC is a pure ESM implementation with bundled dictionaries, so this
// module remains compatible with the Cloudflare Worker bundle.
import OpenCC from 'opencc-js/t2cn'

export const SUPPORTED_LANGUAGES = ['en-GB', 'zh-CN']
export const DEFAULT_LANGUAGE = 'en-GB'

const ALIASES = new Map([
  ['en', 'en-GB'], ['en-gb', 'en-GB'], ['en-us', 'en-GB'],
  ['zh', 'zh-CN'], ['zh-cn', 'zh-CN'], ['zh-hans', 'zh-CN'],
])

export function isSupportedLanguage(value) {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.includes(value)
}

export function normalizeLanguage(value) {
  if (isSupportedLanguage(value)) return value
  if (typeof value === 'string') return ALIASES.get(value.trim().toLowerCase()) ?? DEFAULT_LANGUAGE
  return DEFAULT_LANGUAGE
}

export function languagePromptInstructions(value) {
  const language = normalizeLanguage(value)
  if (language === 'zh-CN') {
    return 'Write every user-facing field in Simplified Chinese (简体中文). Do not use Traditional Chinese characters. Keep proper nouns, URLs, transport/operator names and source labels in their established safe form. Use clear, natural mainland Simplified Chinese.'
  }
  return 'Write every user-facing field in British English (en-GB). Use British spelling and phrasing. Never output Chinese, Japanese, Korean or any other CJK characters. Keep proper nouns, URLs, transport/operator names and source labels in their established safe Latin-script form.'
}

export function languageLabel(value) {
  return normalizeLanguage(value) === 'zh-CN' ? '简体中文' : 'English'
}

const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' })
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u

function isProtectedPath(path) {
  return path[0] === 'request'
    || path[0] === 'sources'
    || path.includes('sources')
    || path.at(-1) === 'url'
    || path.at(-1) === 'source'
    || path.at(-1) === 'source_label'
}

function mapChinese(value, path = []) {
  if (isProtectedPath(path)) return value
  if (typeof value === 'string') return toSimplified(value)
  if (Array.isArray(value)) return value.map((child, index) => mapChinese(child, [...path, index]))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapChinese(child, [...path, key])]))
}

export function normalizeLanguageOutput(value, language) {
  return normalizeLanguage(language) === 'zh-CN' ? mapChinese(value) : value
}

function visit(value, path, matches) {
  if (isProtectedPath(path)) return
  if (typeof value === 'string') {
    if (toSimplified(value) !== value) matches.push(path.join('.') || '<root>')
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) visit(child, [...path, key], matches)
}

export function findTraditionalChinesePaths(value) {
  const matches = []
  visit(value, [], matches)
  return matches
}

export function assertSimplifiedChinese(value) {
  const matches = findTraditionalChinesePaths(value)
  if (matches.length) {
    throw new Error(`Simplified Chinese output check failed at: ${matches.slice(0, 8).join(', ')}`)
  }
  return value
}

export function assertEnglishOnly(value) {
  const matches = []
  const visitEnglish = (child, path) => {
    if (isProtectedPath(path)) return
    if (typeof child === 'string') {
      if (CJK_RE.test(child)) matches.push(path.join('.') || '<root>')
      return
    }
    if (!child || typeof child !== 'object') return
    for (const [key, value] of Object.entries(child)) visitEnglish(value, [...path, key])
  }
  visitEnglish(value, [])
  if (matches.length) throw new Error(`British English output check failed at: ${matches.slice(0, 8).join(', ')}`)
  return value
}

export function assertLanguageOutput(value, language) {
  const normal = normalizeLanguage(language)
  if (normal === 'zh-CN') return assertSimplifiedChinese(value)
  return assertEnglishOnly(value)
}

const LOCALE = {
  'en-GB': {
    appTitle: 'Trip Ticket',
    homeEyebrow: 'Trip Ticket · Multi-Agent Pipeline',
    homeTitleTop: 'One sentence', homeTitleAccent: 'One ticket stack',
    homeHint: 'Describe your trip in one sentence: destination, dates, travellers and preferred pace. The agents handle the time zones, local research and day-by-day plan, then print it as a ticket-style handbook.',
    homePlaceholder: 'Example: Plan a relaxed four-day trip from London to Kyoto in mid-October, with autumn colours, good food and public transport.',
    print: 'Print ticket · Punch it', printing: 'Printing · Punching...',
    connectTitle: 'Connect', connectAccent: 'Existing data',
    connectEyebrow: 'Trip Ticket · Connect Accounts',
    connectHint: 'Connect Gmail, Calendar or Notion so Composer can reference your existing booking confirmations, calendar events and travel notes. This step is optional and skipping it will not affect your ticket.',
    progressEyebrow: 'Trip Ticket · Printing In Progress', progressTop: 'Printing', progressAccent: 'In progress',
    progressHint: 'Agents are working. This page checks progress every 1.5 seconds and opens your handbook when it is ready.',
    board: 'Boarding Info', connect: 'Connect', connected: 'Connected', unavailable: 'Unavailable',
    start: 'Start printing · Continue', skip: 'Skip and print · Skip',
    language: 'Language', english: 'EN', chinese: '简中',
    cover: 'Cover', previous: 'Previous', next: 'Next', relaxed: 'Relaxed', full: 'Full',
    route: 'Route', travellers: 'Travellers', tripId: 'Trip ID', status: 'Status', startDay: 'Start Day',
    planningPreview: 'Planning Preview', ticketConditions: 'Ticket conditions', date: 'Date', base: 'Base', stampMark: 'VISITED',
    stops: 'Stops', stamped: 'Stamped', verify: 'Verify before booking', stamp: 'Stamp', stampedButton: 'Stamped',
    from: 'From', window: 'Window', clock: 'Clock', mode: 'Mode', destination: 'Destination', home: 'Home',
    homeTimezone: 'Home Timezone', bodyClock: 'Body Clock', bookingAnchor: 'booking anchor', feels: 'how it feels',
    destinationTime: 'time', sameTime: 'Same time', sameAsHome: 'Same as home', hour: 'hour', hours: 'hours',
    transfer: 'min transfer', day: 'Day', ticket: 'ticket', itineraryVersion: 'Itinerary version',
    worldClock: 'World clock rail board', stampAria: 'Stamp', stampNote: 'Stamping records a visit and time on this device only.',
    keepsake: 'Keepsake Ticket', posterAlt: 'commemorative poster', trip: 'Trip',
    unavailableServer: 'The server is temporarily unavailable. Retrying...', queued: 'Queued and starting soon',
    working: (done, total) => `Agents working: ${done} / ${total} complete`, complete: 'Handbook complete. Opening now.',
    failed: 'Printing failed', failedHint: 'This ticket could not be completed. The final status of each agent is shown below. Return home to try again.',
    tripNotFound: 'Trip ID not found. Return home and start again.',
    connectionFailed: 'Could not reach the server. Please try again later.',
    configNotice: 'The service is not fully configured yet, so ticket printing is unavailable. Please try again later.',
    noTrip: 'No itinerary has been generated yet. Return to the home page to print one.',
    source: 'Source', verifyBooking: 'Verify before booking',
    fallbackSummary: (destination, days, pace, notes) => `${destination} — ${days}-day plan composed locally by the orchestrator (Composer agent unavailable). Pace: ${pace}. ${notes}`,
    fallbackWarning: 'Composed by the orchestrator fallback — schedules are placeholders, verify everything before booking.',
    fallbackNoBookings: 'No bookings or calendar events were checked.',
    fallbackRelaxed: 'Keep only the shared items and the slow-afternoon blocks.',
    fallbackFull: 'Add the full-variant sights when energy and weather allow.',
    fallbackTransportTitle: 'Verify transport schedules', fallbackTransportDescription: 'All transport legs are placeholders.',
    fallbackAccommodationTitle: 'Confirm accommodation',
    fallbackArrivalRest: 'Check-in and rest', fallbackDinner: 'Easy dinner near the hotel', fallbackHomeBuffer: 'Home buffer',
    fallbackLunch: 'Lunch', fallbackCoffee: 'Coffee / slow afternoon', fallbackDinnerShort: 'Dinner',
    fallbackArrivalNote: 'Planning placeholder — verify schedules before booking.', fallbackAccommodationNote: 'Accommodation not confirmed.',
    fallbackArrivalDay: 'Arrival day stays light.', fallbackDepartureNote: 'Planning placeholder — keep the morning free.',
    fallbackNoEvening: 'No evening plans after a travel day.', fallbackRelaxedNote: 'Relaxed variant keeps the afternoon open.', fallbackEvening: 'Keep evenings light.',
  },
  'zh-CN': {
    appTitle: '旅行票据', homeEyebrow: '旅行票据 · 多智能体行程规划', homeTitleTop: '一句话', homeTitleAccent: '一叠车票',
    homeHint: '用一句话描述行程：目的地、日期、旅客和节奏偏好。智能体会处理时区、本地调研和每日计划，最后生成车票风格的旅行手册。',
    homePlaceholder: '例如：计划十月中旬从伦敦前往京都的四天轻松行程，想看秋色、品尝美食并使用公共交通。',
    print: '生成车票 · 开始', printing: '生成中 · 请稍候...', connectTitle: '连接', connectAccent: '已有数据',
    connectEyebrow: '旅行票据 · 连接账户', connectHint: '连接 Gmail、Calendar 或 Notion，让行程编排器参考已有的预订确认、日历事件和旅行笔记。连接是可选的，跳过不会影响车票生成。',
    progressEyebrow: '旅行票据 · 正在生成', progressTop: '正在生成', progressAccent: '请稍候', progressHint: '智能体正在工作。本页面每 1.5 秒检查一次进度，完成后会自动打开旅行手册。',
    board: '登车信息', connect: '连接', connected: '已连接', unavailable: '不可用', start: '开始生成 · 继续', skip: '跳过连接 · 生成',
    language: '语言', english: 'EN', chinese: '简中', cover: '封面', previous: '上一天', next: '下一天', relaxed: '轻松', full: '充实',
    route: '路线', travellers: '旅客', tripId: '行程编号', status: '状态', startDay: '开始第 1 天', planningPreview: '规划预览',
    ticketConditions: '车票信息', date: '日期', base: '驻地', stampMark: '已到访', stops: '站点', stamped: '已盖章', verify: '预订前请确认', stamp: '盖章', stampedButton: '已盖章',
    from: '出发地', window: '时间段', clock: '时钟', mode: '模式', destination: '目的地', home: '出发地', homeTimezone: '出发地时区', bodyClock: '身体时钟',
    bookingAnchor: '预订基准', feels: '体感时间', destinationTime: '时间', sameTime: '时间相同', sameAsHome: '与出发地相同', hour: '小时', hours: '小时', transfer: '分钟交通',
    day: '第', ticket: '天车票', itineraryVersion: '行程版本', worldClock: '世界时钟轨道', stampAria: '盖章', stampNote: '盖章只会在本设备记录到访时间。',
    keepsake: '纪念车票', posterAlt: '纪念海报', trip: '行程', unavailableServer: '服务器暂时不可用，正在重试……', queued: '已排队，即将开始',
    working: (done, total) => `智能体工作中：已完成 ${done} / ${total}`, complete: '手册已完成，正在打开。', failed: '生成失败',
    failedHint: '这张车票未能完成。下方显示每个智能体的最终状态。返回首页后可以重新尝试。', tripNotFound: '找不到行程编号。请返回首页重新开始。',
    connectionFailed: '无法连接服务器，请稍后再试。', configNotice: '服务尚未完全配置，暂时无法生成车票。请稍后再试。', noTrip: '还没有生成行程。请返回首页生成车票。', source: '来源', verifyBooking: '预订前请确认',
    fallbackSummary: (destination, days, pace, notes) => `${destination} · ${days} 天行程由本地编排器生成（编排智能体不可用）。节奏：${pace}。${notes}`,
    fallbackWarning: '本地备用编排生成，时间安排仅供规划，请在预订前确认。', fallbackNoBookings: '未检查预订或日历事件。', fallbackRelaxed: '只保留共同项目和悠闲的下午安排。', fallbackFull: '精力和天气合适时，可以加入充实模式的景点。',
    fallbackTransportTitle: '确认交通时刻', fallbackTransportDescription: '所有交通安排都是规划占位。', fallbackAccommodationTitle: '确认住宿',
    fallbackArrivalRest: '入住并休息', fallbackDinner: '酒店附近的简便晚餐', fallbackHomeBuffer: '回程缓冲', fallbackLunch: '午餐', fallbackCoffee: '咖啡 / 悠闲下午', fallbackDinnerShort: '晚餐',
    fallbackArrivalNote: '规划占位，请在预订前确认时刻。', fallbackAccommodationNote: '住宿尚未确认。', fallbackArrivalDay: '到达日安排保持轻松。', fallbackDepartureNote: '规划占位，上午请留出余量。', fallbackNoEvening: '旅行日后不安排晚间活动。', fallbackRelaxedNote: '轻松模式让下午保持开放。', fallbackEvening: '晚间安排保持轻松。',
  },
}

export function locale(value) {
  return LOCALE[normalizeLanguage(value)]
}
