// Live credential/account smoke. It performs no LLM call and reads no messages,
// events, or pages; it only verifies per-user connector status.
// Usage: COMPOSIO_API_KEY=... COMPOSIO_USER_ID=visitor_... npm run composio:smoke
import { connectorNames, connectorStatus } from '../pipeline/composio.mjs'

const visitorId = process.env.COMPOSIO_USER_ID
if (!process.env.COMPOSIO_API_KEY || !visitorId) {
  console.error('COMPOSIO_API_KEY and COMPOSIO_USER_ID are required.')
  process.exit(1)
}

for (const connector of connectorNames()) {
  const result = await connectorStatus({ visitorId, connector })
  console.log(`${connector}: ${result.status} (${result.accounts.length} active account(s))`)
}
