# Manyfold connect (operator guide)

Travel Ticket calls Manyfold agents over A2A. Agents are authorized through
Manyfold's device-code **connect** handshake, not by pasting an RPC URL and a
bearer token. This document is for whoever operates the deployment; visitors
never see any of it.

## Connect

1. Open `/settings` and sign in with `ADMIN_SETTINGS_PASSWORD`.
2. Click **Connect Manyfold agents**. Manyfold's authorization page opens and
   the settings page shows a confirmation code.
3. **Check that Manyfold displays the same confirmation code.** That comparison
   is the only anti-phishing check in a device-code flow: it is what stops an
   attacker-initiated handshake from being approved by the wrong person.
4. Tick the agents to share and choose how many days the grant lasts. Prefer a
   generous window: there is no refresh, and a grant that expires blocks new
   trips outright.
5. Approve. The settings page picks up the credentials within a couple of
   seconds and assigns the four roles.

Each approved agent gets its own single-target External client token. Manyfold
releases those credentials exactly once, so the poll that redeems them cannot be
replayed.

## Roles

| Role | Task |
|---|---|
| `brief` | Turn one sentence into a structured trip brief |
| `discovery` | Research the destination and cite sources |
| `composer` | Merge everything into a day-by-day itinerary |
| `theme` | Generate custom visual tokens |

One agent may serve several roles. Assignment is automatic (one agent takes all
four; several are matched by name) until you set a role by hand, after which
your choices are never overwritten.

`POST /api/trips/:id/start` refuses with 409 `manyfold_reconnect_required` until
every role resolves to a credential good for the next 45 minutes, which covers
the roughly 24-minute critical path plus retries. Refusing up front is
deliberate: a grant that lapses mid-run fails four tasks in, with three billed
sessions already spent and nothing to show the visitor.

## Storage and keys

Agent bearers are AES-GCM sealed into `TRIPS_KV` and never reach the browser.
They are sealed with `MF_CONNECT_KEY`, which is deliberately a separate secret
from `ADMIN_SETTINGS_PASSWORD`: a settings value is something you can retype, an
agent bearer is not, and rotating the admin password should not cost every
authorization.

Set `MF_CONNECT_KEY` in every real deployment. Without it the Worker generates a
key into KV, and KV has no put-if-absent, so two concurrent cold requests can
seal under different keys and leave one record unreadable. The CI workflow
requires the secret and fails the deploy if it is missing.

## Reconnecting

An authorization that expired, was revoked on Manyfold, or is rejected by the
agent cannot be refreshed from this side. `/settings` marks the agent
unverified, `/api/config` reports `needs_reconnect`, and new trips are refused.
Re-running the connect flow and approving the same agent rotates its token in
place.

If a trip is already running when a token is rejected, it gets exactly one
re-read of the connection record inside the same invocation: if you reconnected
while it was running the fresh credential is used, otherwise the trip fails
terminally rather than burning its remaining attempts on a dead credential.

## Security notes

- Every `rpcUrl` Manyfold returns is validated before anything is stored: https
  only, no credentials in the URL, and no private or link-local hosts, which is
  what stops a spoofed response pointing a bearer at the cloud metadata endpoint.
- Every outbound A2A request sets `redirect: 'manual'`, so a 3xx cannot replay
  the bearer against a host that was never validated.
- Connectivity is checked with a `tasks/get` probe for an id that cannot exist,
  never a real message. Connecting five agents does not bill five turns.
- Error text is redacted before it can reach a log or the browser.

## Local development

`npm run dev:local` starts a mock Manyfold on `127.0.0.1:8789` that implements
the whole handshake, including a stand-in consent page, and answers agent calls
with a real SSE stream. `ENVIRONMENT` is set to `development` there so the
loopback agent passes the URL check.
