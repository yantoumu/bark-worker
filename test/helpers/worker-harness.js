import { FakeD1Database } from './fake-d1.js'
import { FakeRateLimiter } from './fake-rate-limiter.js'
import { invokeWorker, readJson } from './worker-context.js'

export const TEST_AUTH = 'admin:correct horse battery staple'
export const TEST_DEVICE_KEY = 'test-device-key'
export const TEST_DEVICE_TOKEN = 'a'.repeat(64)

let credentialsPromise

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
    return {
        database: new FakeD1Database(),
        ROOT_PATH: '/',
        SECURITY_MODE: 'strict',
        BASIC_AUTH: TEST_AUTH,
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
        ...(await testAPNsCredentials()),
        ...overrides,
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
                return async () => {
                    state.calls += 1
                    return bytes.buffer.slice(0)
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
