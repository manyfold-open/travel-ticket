export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    destination: { type: 'string', description: 'Human-readable destination, e.g. "Switzerland: Lucerne, Interlaken"' },
    destination_timezone: { type: 'string', description: 'IANA timezone of the destination' },
    home_city: { type: 'string' },
    home_timezone: { type: 'string', description: 'IANA timezone the traveller starts from. Default Asia/Taipei if unclear.' },
    start_date: { type: 'string', description: 'YYYY-MM-DD. If the request has no dates, pick a sensible future window and record the assumption in notes.' },
    end_date: { type: 'string', description: 'YYYY-MM-DD inclusive' },
    travellers: { type: 'integer' },
    pace: { type: 'string', enum: ['relaxed', 'balanced', 'full'] },
    no_car: { type: 'boolean' },
    bases: {
      type: 'array',
      description: 'Ordered overnight bases with nights per base; must cover the whole trip',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, nights: { type: 'integer' } },
        required: ['name', 'nights'],
        additionalProperties: false,
      },
    },
    interests: { type: 'array', items: { type: 'string' } },
    language: { type: 'string', description: 'Language the request was written in, e.g. zh-Hant' },
    notes: { type: 'string', description: 'Assumptions made while interpreting the request' },
  },
  required: ['destination', 'destination_timezone', 'home_city', 'home_timezone', 'start_date', 'end_date', 'travellers', 'pace', 'no_car', 'bases', 'interests', 'language', 'notes'],
  additionalProperties: false,
}

export const DISCOVERY_SCHEMA = {
  type: 'object',
  properties: {
    pois: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          base: { type: 'string', description: 'Which overnight base this is closest to' },
          kind: { type: 'string', enum: ['sight', 'meal', 'rest'] },
          duration_minutes: { type: 'integer' },
          best_time: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'] },
          notes: { type: 'string' },
          source_label: { type: 'string', description: 'Label of a source in sources[] backing this, or empty' },
        },
        required: ['title', 'base', 'kind', 'duration_minutes', 'best_time', 'notes', 'source_label'],
        additionalProperties: false,
      },
    },
    transports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          mode: { type: 'string' },
          minutes: { type: 'integer' },
          notes: { type: 'string' },
          source_label: { type: 'string' },
        },
        required: ['from', 'to', 'mode', 'minutes', 'notes', 'source_label'],
        additionalProperties: false,
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        required: ['label', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['pois', 'transports', 'sources'],
  additionalProperties: false,
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    variant: { type: 'string', enum: ['both', 'relaxed', 'full'] },
    type: { type: 'string', enum: ['travel', 'sight', 'meal', 'rest'] },
    title: { type: 'string' },
    start_local: { type: 'string', description: 'HH:MM destination local time' },
    end_local: { type: 'string', description: 'HH:MM destination local time' },
    location: { type: 'string' },
    transport_minutes: { type: 'integer' },
    notes: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['variant', 'type', 'title', 'start_local', 'end_local', 'location', 'transport_minutes', 'notes', 'sources'],
  additionalProperties: false,
}

export const COMPOSER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          title: { type: 'string', description: 'Short day title; use "A → B" for transfer days' },
          base: { type: 'string' },
          handwritten_note: { type: 'string', description: 'Optional. One colloquial reminder (≤22 chars, request language) a travel companion would pencil on the ticket stub. Must paraphrase an existing warning/note for this day — never introduce new facts. Omit when nothing is worth writing.' },
          items: { type: 'array', items: ITEM_SCHEMA },
        },
        required: ['date', 'title', 'base', 'items'],
        additionalProperties: false,
      },
    },
    alternatives: {
      type: 'object',
      properties: {
        relaxed: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false },
        full: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false },
      },
      required: ['relaxed', 'full'],
      additionalProperties: false,
    },
    actions_suggested: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          requires_approval: { type: 'boolean' },
        },
        required: ['type', 'title', 'description', 'requires_approval'],
        additionalProperties: false,
      },
    },
    cover: {
      type: 'object',
      description: 'Cover-page copy for the ticket-style site',
      properties: {
        title_top: { type: 'string', description: 'Big headline line 1, e.g. destination name' },
        title_accent: { type: 'string', description: 'Big headline line 2, e.g. "by Rail"' },
        eyebrow: { type: 'string' },
        handwritten_note: { type: 'string', description: 'Optional. One trip-level colloquial reminder (≤22 chars) pencilled on the cover stub; paraphrase the most human warning, no new facts.' },
      },
      required: ['title_top', 'title_accent', 'eyebrow'],
      additionalProperties: false,
    },
  },
  required: ['summary', 'warnings', 'days', 'alternatives', 'actions_suggested', 'cover'],
  additionalProperties: false,
}
