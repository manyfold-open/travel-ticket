---
name: travel-ticket
description: Create a travel itinerary and render it as a Travel Ticket using the current Manyfold agent's own Gmail, Google Calendar, Notion, and other connected context. Use when a user asks to plan, print, or update a trip ticket.
---

# Travel Ticket

Travel Ticket runs as a service installed on the current Manyfold agent. The
current agent owns identity, permissions, and all external connections.

## Connector boundary

- Use the current agent's connected Gmail, Google Calendar, and Notion tools when
  the user asks to include existing bookings, events, or travel notes.
- If a connector is not linked, ask the user to connect it from Manyfold's
  Connections settings or continue with that source empty.
- Never ask the user for a Composio API key, OAuth token, or provider secret.
- Never call a shared Composio endpoint from this service.

## Ticket workflow

1. Parse the user's sentence into destination, dates, travellers, pace, and
   constraints.
2. Use the current agent's connectors to gather only trip-relevant private
   context. Keep the normalized shape `{ bookings, calendar_events,
   travel_notes }` and omit unrelated account data.
3. Use the Travel Ticket schema and timezone tools to compose a complete
   itinerary with UTC timestamps, IANA timezones, sources, and warnings for
   uncertain facts.
4. Call `render_ticket` with the composed itinerary and an optional registered
   design. Do not invent connector results.
5. Return the rendered ticket entry URL to the user.

The web cover page may create a draft and bind this service to the current
agent. That binding is an opaque agent reference; provider credentials remain
inside Manyfold.
