/**
 * AES-GCM sealing for Manyfold agent credentials.
 *
 * Deliberately a separate module from worker/admin/settings.mjs, and
 * deliberately keyed on its own secret rather than derived from
 * ADMIN_SETTINGS_PASSWORD. Settings values are things an operator can retype;
 * an agent bearer is not, and rotating the admin password should not silently
 * cost every agent authorization.
 *
 * Key resolution: MF_CONNECT_KEY if set and long enough, otherwise a key
 * generated into KV on first use.
 *
 * KNOWN RACE, and it is genuinely unsolvable in KV. The generated-key path
 * writes then re-reads so concurrent cold requests converge on one winner, but
 * KV has no put-if-absent, so there is a sub-second window in which two
 * requests can seal under different keys and one record becomes unreadable.
 * Set MF_CONNECT_KEY in any deployment you care about; the generated path is a
 * local-development convenience.
 */

const PROJECT_ID = 'travel-ticket'
const KEY_RECORD = 'mf:connect-key:v1'
const MIN_KEY_LENGTH = 32

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

let generatedMaterial = null
const keyCache = new Map()

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
}

async function keyMaterial(env) {
  const supplied = env?.MF_CONNECT_KEY
  if (typeof supplied === 'string' && supplied.trim().length >= MIN_KEY_LENGTH) return supplied.trim()
  if (generatedMaterial) return generatedMaterial

  const existing = await env.TRIPS_KV.get(KEY_RECORD)
  if (existing) {
    generatedMaterial = existing
    return existing
  }
  const fresh = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  await env.TRIPS_KV.put(KEY_RECORD, fresh)
  // Re-read so concurrent first requests converge on whichever write landed.
  generatedMaterial = (await env.TRIPS_KV.get(KEY_RECORD)) || fresh
  return generatedMaterial
}

async function cryptoKey(env) {
  const material = await keyMaterial(env)
  const cached = keyCache.get(material)
  if (cached) return cached
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(`${PROJECT_ID}:connect:${material}`))
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
  keyCache.set(material, key)
  return key
}

export async function seal(env, plaintext) {
  const key = await cryptoKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(String(plaintext)))
  return { ciphertext: bytesToBase64Url(new Uint8Array(encrypted)), iv: bytesToBase64Url(iv) }
}

export async function unseal(env, ciphertext, iv) {
  if (!ciphertext || !iv) throw new ConfigError('The stored credential is incomplete. Connect the agent again.')
  const key = await cryptoKey(env)
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(iv) },
      key,
      base64UrlToBytes(ciphertext),
    )
    return textDecoder.decode(decrypted)
  } catch {
    throw new ConfigError('Stored agent credentials could not be read: the encryption key changed. Connect the agents again.')
  }
}
