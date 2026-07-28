# Future: Manyfold Agent Authorization

The hosted Travel Ticket flow currently does not expose this connection page or
run the private-context stage. This document preserves the planned A2A boundary
for the later OAuth-based Manyfold agent integration; it is not a current setup
requirement.

The planned flow connects directly to the user's existing Manyfold agent through
the Manyfold External Client credentials. It does not create an agent, start an
OAuth flow, or use an install callback.

```text
Manyfold Agent Detail -> A2A -> Inbound -> Add caller -> External Client
  -> copy RPC URL + Bearer token -> Travel Ticket Connect Agent page
```

## User setup in Manyfold

1. Open the Manyfold agent that should handle Travel Ticket context.
2. Open the agent detail page and enable `A2A`.
3. Under `Inbound · who can call this agent`, choose `Add caller`.
4. Create or reveal an `External Client` caller.
5. Copy its `A2A RPC URL` and `Bearer token`.

Copy the complete URL from the field or copy control. The visible endpoint may
be shortened with an ellipsis; the URL must contain the full agent ID and end
with `/rpc`, for example:

```text
https://api-staging.manyfold.ai/api/a2a/agents/<full-agent-id>/rpc
```

For compatibility, Travel Ticket adds `/rpc` when a Manyfold agent URL is
pasted without that suffix. It cannot reconstruct an agent ID that was copied
from shortened display text.

The user pastes those two values into Travel Ticket's `Connect your Manyfold`
page. Travel Ticket sends one authenticated `message/send` request to test the
connection. A successful test stores the credential for that draft trip and
allows printing.

## Credential boundary

The Worker sends the token only as:

```http
Authorization: Bearer <user's external-client-token>
```

The token is stored in the trip's Durable Object state so queued context work
can use it. It is never returned by `/api/trips/:id`, `/api/trips/:id/agent`,
`/api/config`, or the settings API, and it is not written to logs. Production
RPC URLs must use HTTPS. HTTP is accepted only for localhost local testing.

The credential is currently trip-scoped. The user can skip the connection and
print without private context; skipped trips use empty Gmail, Calendar, and
Notion context.

## What Travel Ticket calls

The direct client sends A2A JSON-RPC `message/send` requests to the supplied
RPC URL. If Manyfold returns an asynchronous task, it polls `tasks/get` and
extracts only the final text response.

The supplied agent is used only for the `context` step. Travel Ticket's five
backend role agents remain deployment configuration: brief, discovery,
context fallback, composer, and theme. The user's Manyfold context agent owns
Gmail, Google Calendar, Notion, and any Composio connections.
