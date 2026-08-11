#!/usr/bin/env node
import { spawn } from 'node:child_process'
import net from 'node:net'

const requestedPort = process.env.TRAVEL_TICKET_PORT || '8788'

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(Number(port), '127.0.0.1', () => {
      probe.close(() => resolve(true))
    })
  })
}

async function chooseWorkerPort() {
  if (process.env.TRAVEL_TICKET_PORT) return requestedPort

  // 8789 belongs to the mock Manyfold peer, so avoid it while looking for a
  // fallback when another local Worker is already using the default port.
  const candidates = ['8788', '8898', '8899', '8900', '8901', '8902']
  for (const port of candidates) {
    if (await portIsAvailable(port)) return port
  }
  throw new Error('No available local Worker port found; set TRAVEL_TICKET_PORT explicitly.')
}

const workerPort = await chooseWorkerPort()
const workerArgs = [
  'wrangler', 'dev', '--port', workerPort, '--persist-to', '.wrangler/local-mock',
  '--var', 'ADMIN_SETTINGS_PASSWORD:local-admin',
  '--var', 'ACCESS_PASSCODE:123456',
  '--var', 'MANYFOLD_API_BASE_URL:http://127.0.0.1:8789',
  // Not 'production', so validateA2AUrl accepts the loopback mock agent.
  '--var', 'ENVIRONMENT:development',
  '--var', 'MF_CONNECT_KEY:local-development-connect-key-not-a-secret',
]

const mock = spawn(process.execPath, ['scripts/mock-manyfold-agent.mjs'], { stdio: 'inherit' })
const worker = spawn('npx', workerArgs, { stdio: 'inherit', shell: process.platform === 'win32' })

console.log(`[local] Travel Ticket: http://localhost:${workerPort}`)
if (workerPort !== requestedPort) console.log(`[local] Port ${requestedPort} was busy; using ${workerPort}`)
console.log('[local] Access code: 123456')
console.log('[local] Admin settings password: local-admin')

function stop() {
  mock.kill('SIGTERM')
  worker.kill('SIGTERM')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
worker.on('exit', (code, signal) => {
  mock.kill('SIGTERM')
  if (signal) process.exit(1)
  process.exit(code ?? 0)
})
