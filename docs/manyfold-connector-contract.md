# Manyfold Connector Contract (Disabled)

Private context is currently disabled in the hosted Travel Ticket flow. The
contract below is retained as a disabled integration reference and is not called
by the current Worker.


> Transport note: this document describes the *prompt* contract for the
> disabled `context` role, which is orthogonal to transport. Transport is now
> the connect handshake plus `message/stream`; see
> [Manyfold connect](./manyfold-connect.md).
The disabled Travel Ticket flow calls the user's Manyfold context agent over A2A. The user
provided an `A2A RPC URL` and `Bearer token` on the Travel
Ticket connect page. Manyfold owns all provider integrations.

## Request

The authenticated A2A message contains these prompt fields:

```text
Operation: fetch_context
External user subject: travel-ticket:<visitor_id>
Trip id: <trip id>
Host Manyfold agent name: <name when known>
Provider: all
Requested providers: gmail, calendar, notion
Trip brief: <JSON brief>
```

The external client token authenticates the request. It is not a Composio key
and must not be copied into a provider credential field.

## Response

The agent returns one JSON object with normalized private context:

```json
{
  "status": "ok",
  "message": "",
  "providers": {
    "gmail": { "status": "connected", "message": "", "authorization_url": "" },
    "calendar": { "status": "not_connected", "message": "", "authorization_url": "" },
    "notion": { "status": "not_connected", "message": "", "authorization_url": "" }
  },
  "bookings": [],
  "calendar_events": [],
  "travel_notes": []
}
```

Provider setup happens inside Manyfold. Travel Ticket does not expose a
Gmail/Calendar/Notion setup page and does not call Composio directly. If a
provider is unavailable, the agent returns its status and an empty array for
that source. The workflow can still print.

Responses must contain only trip-relevant normalized context. They must not
contain provider tokens, API keys, or unrelated account data.
