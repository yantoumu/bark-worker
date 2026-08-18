import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../main.js'
import { apnsScenario, createAPNsStub } from './helpers/apns.js'
import { FakeD1Database } from './helpers/fake-d1.js'
import {
    TEST_DEVICE_KEY,
    TEST_DEVICE_TOKEN,
    authenticatedHeaders,
    createTestEnv,
    jsonTextOfByteLength,
} from './helpers/worker-harness.js'
import { installFetchStub, invokeWorker, readJson } from './helpers/worker-context.js'

function deviceEntries(count) {
    return Array.from({ length: count }, (_, index) => [
        `device${index}`,
        index.toString(16).padStart(64, '0'),
    ])
}

async function post(path, body, env, headers = {}) {
    return invokeWorker(worker, path, {
        env,
        request: {
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/json', ...headers }),
            body: typeof body === 'string' ? body : JSON.stringify(body),
        },
    })
}

test('request body accepts exactly 32 KiB when the APNs payload remains small', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv()
    const body = jsonTextOfByteLength(32 * 1024)

    const { response } = await post('/push', body, env)

    assert.equal(new TextEncoder().encode(body).byteLength, 32 * 1024)
    assert.equal(response.status, 200)
    assert.equal(apns.requests.length, 1)
})

test('request body rejects 32 KiB plus one byte even with a forged Content-Length', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv()
    const body = jsonTextOfByteLength(32 * 1024 + 1)

    const { response } = await post('/push', body, env, { 'content-length': '1' })

    assert.equal(response.status, 413)
    assert.equal(apns.requests.length, 0)
})

test('declared oversized Content-Length is rejected before parsing the body', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv()

    const { response } = await post('/push', { device_key: TEST_DEVICE_KEY }, env, {
        'content-length': String(32 * 1024 + 1),
    })

    assert.equal(response.status, 413)
    assert.equal(apns.requests.length, 0)
})

test('POST /push rejects unsupported media types', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv()

    const { response } = await invokeWorker(worker, '/push', {
        env,
        request: {
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'text/plain' }),
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY }),
        },
    })

    assert.equal(response.status, 415)
    assert.equal(apns.requests.length, 0)
})

test('malformed JSON returns a stable client error', async () => {
    const env = await createTestEnv()
    const { response } = await post('/push', '{not-json', env)
    const body = await readJson(response)

    assert.equal(response.status, 400)
    assert.equal(body.code, 400)
    assert.doesNotMatch(body.message, /SyntaxError|stack|at handleRequest/)
})

test('form values are decoded exactly once by the platform', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv()

    const { response } = await invokeWorker(worker, '/push', {
        env,
        request: {
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/x-www-form-urlencoded' }),
            body: `device_key=${TEST_DEVICE_KEY}&body=%2520`,
        },
    })

    assert.equal(response.status, 200)
    assert.equal(apns.payload().aps.alert.body, '%20')
})

test('malformed percent escapes in path push return 400 rather than 500', async () => {
    const env = await createTestEnv()
    const { response } = await invokeWorker(worker, `/${TEST_DEVICE_KEY}/%E0%A4%A`, {
        env,
        request: { headers: authenticatedHeaders() },
    })
    const body = await readJson(response)

    assert.equal(response.status, 400)
    assert.equal(body.code, 400)
    assert.doesNotMatch(body.message, /URIError|stack/)
})

test('push rejects non-string values for string fields', async (t) => {
    const invalidFields = [
        ['title object', { title: { nested: true } }],
        ['body array', { body: ['not', 'text'] }],
        ['sound number', { sound: 7 }],
        ['markdown object', { markdown: {} }],
        ['ciphertext array', { ciphertext: [] }],
    ]

    for (const [name, invalid] of invalidFields) {
        await t.test(name, async (t) => {
            const apns = createAPNsStub()
            installFetchStub(t, apns.fetch)
            const env = await createTestEnv()
            const { response } = await post('/push', {
                device_key: TEST_DEVICE_KEY,
                ...invalid,
            }, env)

            assert.equal(response.status, 400)
            assert.equal(apns.requests.length, 0)
        })
    }
})

test('push validates enums and numeric bounds', async (t) => {
    const invalidPayloads = [
        ['level', { level: 'urgent' }],
        ['negative badge', { badge: -1 }],
        ['fractional badge', { badge: 1.5 }],
        ['negative ttl', { ttl: -1 }],
        ['volume below range', { volume: -0.1 }],
        ['volume above range', { volume: 10.1 }],
    ]

    for (const [name, invalid] of invalidPayloads) {
        await t.test(name, async (t) => {
            const apns = createAPNsStub()
            installFetchStub(t, apns.fetch)
            const env = await createTestEnv()
            const { response } = await post('/push', {
                device_key: TEST_DEVICE_KEY,
                body: 'validation',
                ...invalid,
            }, env)

            assert.equal(response.status, 400)
            assert.equal(apns.requests.length, 0)
        })
    }
})

test('push only accepts bounded HTTP(S) URLs', async (t) => {
    const invalidUrls = [
        'javascript:alert(1)',
        'file:///etc/passwd',
        `https://example.com/${'x'.repeat(2049)}`,
    ]

    for (const url of invalidUrls) {
        await t.test(url.slice(0, 40), async (t) => {
            const apns = createAPNsStub()
            installFetchStub(t, apns.fetch)
            const env = await createTestEnv()
            const { response } = await post('/push', {
                device_key: TEST_DEVICE_KEY,
                body: 'validation',
                url,
            }, env)

            assert.equal(response.status, 400)
            assert.equal(apns.requests.length, 0)
        })
    }
})

test('final APNs payload larger than 4096 UTF-8 bytes is rejected locally', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv()

    const { response } = await post('/push', {
        device_key: TEST_DEVICE_KEY,
        body: '🙂'.repeat(1100),
    }, env)

    assert.equal(response.status, 413)
    assert.equal(apns.requests.length, 0)
})

test('batch accepts 20 unique devices and preserves outer HTTP 200', async (t) => {
    const entries = deviceEntries(20)
    const database = new FakeD1Database({ devices: entries })
    const env = await createTestEnv({ database })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await post('/push', {
        device_keys: entries.map(([key]) => key),
        body: 'batch boundary',
    }, env)
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.data.length, 20)
    assert.equal(body.success_count, 20)
    assert.equal(body.failed_count, 0)
    assert.equal(body.partial_failure, false)
    assert.equal(apns.requests.length, 20)
})

test('batch rejects 21 devices without silently truncating or sending', async (t) => {
    const entries = deviceEntries(21)
    const env = await createTestEnv({ database: new FakeD1Database({ devices: entries }) })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await post('/push', {
        device_keys: entries.map(([key]) => key),
        body: 'too many',
    }, env)

    assert.equal(response.status, 413)
    assert.equal(apns.requests.length, 0)
})

test('batch de-duplicates device keys before database and APNs work', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const database = new FakeD1Database()
    const env = await createTestEnv({ database })

    const { response } = await post('/push', {
        device_keys: [TEST_DEVICE_KEY, TEST_DEVICE_KEY, TEST_DEVICE_KEY],
        body: 'one delivery',
    }, env)
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.data.length, 1)
    assert.equal(apns.requests.length, 1)
    assert.equal(database.callsMatching(/select `token` from `devices`/i).length, 1)
})

test('batch rejects empty keys and non-array/non-legacy-string shapes', async (t) => {
    const invalidValues = [
        ['empty key', [TEST_DEVICE_KEY, '']],
        ['object', { key: TEST_DEVICE_KEY }],
        ['number', 42],
    ]

    for (const [name, deviceKeys] of invalidValues) {
        await t.test(name, async (t) => {
            const apns = createAPNsStub()
            installFetchStub(t, apns.fetch)
            const env = await createTestEnv()
            const { response } = await post('/push', { device_keys: deviceKeys, body: 'invalid' }, env)
            const body = await readJson(response)

            assert.equal(response.status, 400)
            assert.match(body.message, /device_keys.*(?:array|string)|invalid.*device_keys/i)
            assert.equal(apns.requests.length, 0)
        })
    }
})

test('batch limits concurrent APNs calls to five', async (t) => {
    const entries = deviceEntries(20)
    const env = await createTestEnv({ database: new FakeD1Database({ devices: entries }) })
    const apns = createAPNsStub({ scenario: apnsScenario.success({ delayMs: 30 }) })
    installFetchStub(t, apns.fetch)

    const { response } = await post('/push', {
        device_keys: entries.map(([key]) => key),
        body: 'bounded concurrency',
    }, env)

    assert.equal(response.status, 200)
    assert.equal(apns.requests.length, 20)
    assert.ok(apns.maxActive <= 5, `expected <= 5 concurrent calls, observed ${apns.maxActive}`)
})

test('one batch item failure is isolated and summarized', async (t) => {
    const entries = deviceEntries(2)
    const failedToken = entries[1][1]
    const env = await createTestEnv({ database: new FakeD1Database({ devices: entries }) })
    const apns = createAPNsStub({
        scenario: ({ url }) => url.endsWith(failedToken)
            ? apnsScenario.status(500, 'InternalServerError')
            : apnsScenario.success(),
    })
    installFetchStub(t, apns.fetch)

    const { response } = await post('/push', {
        device_keys: entries.map(([key]) => key),
        body: 'partial failure',
    }, env)
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.data.length, 2)
    assert.equal(body.success_count, 1)
    assert.equal(body.failed_count, 1)
    assert.equal(body.partial_failure, true)
})

test('POST /push and path-style GET/POST push remain compatible', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv()
    const requests = [
        ['/push', { method: 'POST', headers: authenticatedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body: 'json' }) }],
        [`/${TEST_DEVICE_KEY}/Path%20body`, { method: 'GET', headers: authenticatedHeaders() }],
        [`/${TEST_DEVICE_KEY}/Title/Path%20body`, { method: 'POST', headers: authenticatedHeaders() }],
    ]

    for (const [path, request] of requests) {
        const { response } = await invokeWorker(worker, path, { env, request })
        assert.equal(response.status, 200, `${request.method} ${path}`)
    }
    assert.equal(apns.requests.length, 3)
})

test('unsupported push methods return 405 with Allow', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv()
    const { response } = await invokeWorker(worker, '/push', {
        env,
        request: { method: 'DELETE', headers: authenticatedHeaders() },
    })

    assert.equal(response.status, 405)
    assert.match(response.headers.get('allow') ?? '', /POST/)
    assert.equal(apns.requests.length, 0)
})

test('device keys are queried exactly before any legacy fallback', async (t) => {
    const exactKey = 'opaque-device.key_01'
    const database = new FakeD1Database({ devices: [[exactKey, TEST_DEVICE_TOKEN]] })
    const env = await createTestEnv({ database })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await invokeWorker(worker, `/${encodeURIComponent(exactKey)}/hello`, {
        env,
        request: { headers: authenticatedHeaders() },
    })

    assert.equal(response.status, 200)
    const lookup = database.callsMatching(/select `token` from `devices`/i)[0]
    assert.equal(lookup.bindings[0], exactKey)
})

test('unknown device errors do not echo the device key or SQL details', async () => {
    const secretKey = 'unknown-secret-device-key'
    const env = await createTestEnv({ database: new FakeD1Database({ devices: [] }) })
    const { response } = await post('/push', { device_key: secretKey, body: 'no leak' }, env)
    const text = await response.text()

    assert.equal(response.status, 400)
    assert.doesNotMatch(text, new RegExp(secretKey))
    assert.doesNotMatch(text, /SELECT|database|stack/i)
})

test('D1 stored invalid device tokens return a generic 400 without contacting APNs', async (t) => {
    const invalidStoredToken = 'not-a-valid-apns-token'
    const database = new FakeD1Database({ devices: [[TEST_DEVICE_KEY, invalidStoredToken]] })
    const env = await createTestEnv({ database })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await post('/push', {
        device_key: TEST_DEVICE_KEY,
        body: 'must not leave the Worker',
    }, env)
    const body = await readJson(response)

    assert.equal(response.status, 400)
    assert.equal(body.code, 400)
    assert.equal(body.message, 'invalid device key')
    assert.doesNotMatch(JSON.stringify(body), new RegExp(invalidStoredToken))
    assert.equal(apns.requests.length, 0)
})

test('ROOT_PATH matches only the configured path boundary', async () => {
    const env = await createTestEnv({ ROOT_PATH: '/app' })
    const mounted = await invokeWorker(worker, '/app/ping', { env })
    const lookalike = await invokeWorker(worker, '/apple/ping', {
        env,
        request: { headers: authenticatedHeaders() },
    })

    assert.equal(mounted.response.status, 200)
    assert.equal(lookalike.response.status, 404)
})

test('ROOT_PATH with a trailing slash does not create double-slash routes', async () => {
    const env = await createTestEnv({ ROOT_PATH: '/bark/' })
    const { response } = await invokeWorker(worker, '/bark/ping', { env })
    assert.equal(response.status, 200)
})

test('unexpected D1 failures are caught by the top-level JSON error boundary', async () => {
    const database = new FakeD1Database({
        failures: [{ match: /select `token` from `devices`/i, remaining: 1, error: new Error('SQL SECRET detail') }],
    })
    const env = await createTestEnv({ database })

    const { response } = await post('/push', { device_key: TEST_DEVICE_KEY, body: 'failure' }, env)
    const text = await response.text()

    assert.equal(response.status, 500)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.doesNotMatch(text, /SQL SECRET|stack|select `token`/i)
    assert.ok(response.headers.get('x-request-id'))
})
