import { FakeD1Database } from './fake-d1.js'
import { FakeRateLimiter } from './fake-rate-limiter.js'
import { invokeWorker, readJson } from './worker-context.js'

export const TEST_AUTH = 'admin:correct horse battery staple'
export const TEST_DEVICE_KEY = 'test-device-key'
export const TEST_DEVICE_TOKEN = 'a'.repeat(64)
export const TEST_MASTER_KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64')
export const TEST_BOOTSTRAP_TOKEN = 'test-bootstrap-token-with-at-least-32-bytes'

const TEST_PASSWORD_SALT = Uint8Array.from({ length: 16 }, (_, index) => 240 - index)
const PASSWORD_ITERATIONS = 100000
const PASSWORD_ALGORITHM = 'pbkdf2-sha256+pepper-v1'
const APNS_AAD = new TextEncoder().encode('bark-worker:apns-credentials:v1')

let credentialsPromise
let passwordRecordPromise
let encryptedCredentialsPromise

async function deriveKey(masterKey, purpose, algorithm, usages) {
    const source = await crypto.subtle.importKey('raw', Buffer.from(masterKey, 'base64'), 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('bark-worker:v1'),
        info: new TextEncoder().encode(purpose),
    }, source, algorithm, false, usages)
}

async function testPasswordRecord() {
    passwordRecordPromise ??= (async () => {
        const [, password] = TEST_AUTH.split(':', 2)
        const pepperKey = await deriveKey(
            TEST_MASTER_KEY,
            'password-pepper',
            { name: 'HMAC', hash: 'SHA-256', length: 256 },
            ['sign'],
        )
        const peppered = await crypto.subtle.sign('HMAC', pepperKey, new TextEncoder().encode(password))
        const material = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits'])
        const hash = await crypto.subtle.deriveBits({
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt: TEST_PASSWORD_SALT,
            iterations: PASSWORD_ITERATIONS,
        }, material, 256)
        const now = Math.floor(Date.now() / 1000)
        return {
            username: 'admin',
            password_hash: Buffer.from(hash).toString('base64'),
            password_salt: Buffer.from(TEST_PASSWORD_SALT).toString('base64'),
            password_iterations: PASSWORD_ITERATIONS,
            password_algorithm: PASSWORD_ALGORITHM,
            role: 'admin',
            disabled: 0,
            created_at: now,
            updated_at: now,
        }
    })()
    return passwordRecordPromise
}

async function encryptedTestAPNsCredentials() {
    encryptedCredentialsPromise ??= (async () => {
        const credentials = await testAPNsCredentials()
        const payload = JSON.stringify({
            private_key: credentials.APNS_PRIVATE_KEY,
            team_id: credentials.APNS_TEAM_ID,
            key_id: credentials.APNS_KEY_ID,
            topic: credentials.APNS_TOPIC,
        })
        const key = await deriveKey(TEST_MASTER_KEY, 'apns-vault', { name: 'AES-GCM', length: 256 }, ['encrypt'])
        const iv = Uint8Array.from({ length: 12 }, (_, index) => 32 + index)
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: APNS_AAD, tagLength: 128 },
            key,
            new TextEncoder().encode(payload),
        )
        return {
            id: 1,
            ciphertext: Buffer.from(ciphertext).toString('base64'),
            iv: Buffer.from(iv).toString('base64'),
            key_version: 1,
            updated_by: 'admin',
            updated_at: Math.floor(Date.now() / 1000),
        }
    })()
    return encryptedCredentialsPromise
}

async function createTestAPNsCredentials() {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
    )
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))
    const encoded = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n')
    const label = ['PRIVATE', 'KEY'].join(' ')

    return {
        APNS_PRIVATE_KEY: `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`,
        APNS_TEAM_ID: 'TESTTEAM1',
        APNS_KEY_ID: 'TESTKEY001',
        APNS_TOPIC: 'example.test.bark',
    }
}

export async function testAPNsCredentials() {
    credentialsPromise ??= createTestAPNsCredentials()
    return credentialsPromise
}

export async function createTestEnv(overrides = {}) {
    const {
        TEST_SKIP_D1_AUTH_SEED = false,
        TEST_SKIP_D1_APNS_SEED = false,
        ...environmentOverrides
    } = overrides
    const database = environmentOverrides.database ?? new FakeD1Database()
    if (database instanceof FakeD1Database && !TEST_SKIP_D1_AUTH_SEED && database.users.size === 0) {
        const record = await testPasswordRecord()
        database.users.set(record.username, structuredClone(record))
    }
    if (database instanceof FakeD1Database && !TEST_SKIP_D1_APNS_SEED && database.apnsCredentials === null) {
        database.apnsCredentials = structuredClone(await encryptedTestAPNsCredentials())
    }
    return {
        database,
        ROOT_PATH: '/',
        SECURITY_MODE: 'strict',
        BASIC_AUTH: TEST_AUTH,
        APP_MASTER_KEY: TEST_MASTER_KEY,
        ADMIN_BOOTSTRAP_TOKEN: TEST_BOOTSTRAP_TOKEN,
        ALLOW_NEW_DEVICE: 'false',
        ALLOW_QUERY_NUMS: 'false',
        ALLOW_LEGACY_GET_REGISTER: 'false',
        LEGACY_GET_REGISTER_SUNSET: 'Fri, 31 Dec 2027 23:59:59 GMT',
        ALLOW_INSECURE_DEVICE_REBIND: 'false',
        MAX_REQUEST_BYTES: '32768',
        MAX_BATCH_SIZE: '20',
        BATCH_CONCURRENCY: '5',
        APNS_TIMEOUT_MS: '10000',
        MCP_ALLOWED_ORIGINS: 'https://client.example',
        REGISTER_RATE_LIMITER: new FakeRateLimiter(),
        PUSH_RATE_LIMITER: new FakeRateLimiter(),
        BATCH_RATE_LIMITER: new FakeRateLimiter(),
        MCP_RATE_LIMITER: new FakeRateLimiter(),
        AUTH_RATE_LIMITER: new FakeRateLimiter(),
        ...(await testAPNsCredentials()),
        ...environmentOverrides,
    }
}

export function basicAuthorization(value = TEST_AUTH) {
    return `Basic ${Buffer.from(value).toString('base64')}`
}

export function authenticatedHeaders(headers = {}, value = TEST_AUTH) {
    return {
        authorization: basicAuthorization(value),
        ...headers,
    }
}

export async function jsonRequest(worker, path, payload, options = {}) {
    const headers = options.auth === false
        ? { 'content-type': 'application/json', ...options.headers }
        : authenticatedHeaders({ 'content-type': 'application/json', ...options.headers }, options.auth)
    const env = options.env ?? await createTestEnv()
    const result = await invokeWorker(worker, path, {
        env,
        runtime: options.runtime,
        settle: options.settle,
        request: {
            method: options.method ?? 'POST',
            headers,
            body: typeof payload === 'string' ? payload : JSON.stringify(payload),
        },
    })
    return { ...result, body: await readJson(result.response.clone()) }
}

export function jsonTextOfByteLength(targetBytes, base = { device_key: TEST_DEVICE_KEY, body: 'ok' }) {
    const encoder = new TextEncoder()
    const empty = JSON.stringify({ ...base, padding: '' })
    const overhead = encoder.encode(empty).byteLength
    if (overhead > targetBytes) throw new RangeError('Target is smaller than the JSON envelope')

    const text = JSON.stringify({ ...base, padding: 'x'.repeat(targetBytes - overhead) })
    if (encoder.encode(text).byteLength !== targetBytes) throw new Error('Failed to construct exact-size JSON')
    return text
}

export function installDeterministicSignature(t, bytes = new Uint8Array([
    251, 255, 191, 251, 255, 191, 251, 255, 191,
    251, 255, 191, 251, 255, 191, 251, 255, 191,
])) {
    const state = { calls: 0 }
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    const originalCrypto = globalThis.crypto
    const subtle = new Proxy(originalCrypto.subtle, {
        get(target, property) {
            if (property === 'sign') {
                return async (...args) => {
                    const algorithm = typeof args[0] === 'string' ? args[0] : args[0]?.name
                    if (algorithm === 'ECDSA') {
                        state.calls += 1
                        return bytes.buffer.slice(0)
                    }
                    return target.sign(...args)
                }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
    const replacement = new Proxy(originalCrypto, {
        get(target, property) {
            if (property === 'subtle') return subtle
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })

    Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        enumerable: originalDescriptor?.enumerable ?? true,
        value: replacement,
    })
    t.after(() => {
        if (originalDescriptor) Object.defineProperty(globalThis, 'crypto', originalDescriptor)
        else delete globalThis.crypto
    })

    return state
}
