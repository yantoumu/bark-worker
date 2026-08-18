import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../main_kv.js'
import { apnsScenario, createAPNsStub } from './helpers/apns.js'
import { FakeKVNamespace } from './helpers/fake-kv.js'
import {
    TEST_DEVICE_KEY,
    TEST_DEVICE_TOKEN,
    authenticatedHeaders,
    createTestEnv,
    jsonTextOfByteLength,
} from './helpers/worker-harness.js'
import { installFetchStub, invokeWorker, readJson } from './helpers/worker-context.js'

function kvWithDevices(entries = [[TEST_DEVICE_KEY, TEST_DEVICE_TOKEN], ['testdevicekey', TEST_DEVICE_TOKEN]]) {
    return new FakeKVNamespace({
        values: [...entries, ['_authToken_', 'test-authorization-token']],
    })
}

async function push(env, payload, options = {}) {
    return invokeWorker(worker, options.path ?? '/push', {
        env,
        request: {
            method: options.method ?? 'POST',
            headers: authenticatedHeaders({ 'content-type': options.contentType ?? 'application/json' }),
            body: typeof payload === 'string' ? payload : JSON.stringify(payload),
        },
    })
}

test('KV POST /push preserves the Bark APNs payload contract', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv({ database: kvWithDevices() })

    const { response } = await push(env, {
        device_key: TEST_DEVICE_KEY,
        title: 'KV title',
        subtitle: 'KV subtitle',
        body: 'KV body',
        group: 'KV group',
        badge: 0,
        level: 'timeSensitive',
        url: 'https://example.com/result',
    })

    assert.equal(response.status, 200)
    assert.deepEqual(apns.payload().aps.alert, {
        title: 'KV title',
        subtitle: 'KV subtitle',
        body: 'KV body',
    })
    assert.equal(apns.payload().badge, '0')
    assert.equal(apns.payload().level, 'timeSensitive')
})

test('KV supports path-style push while respecting exact device keys', async (t) => {
    const key = 'kv-device.key_01'
    const kv = kvWithDevices([[key, TEST_DEVICE_TOKEN]])
    const env = await createTestEnv({ database: kv })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await invokeWorker(worker, `/${encodeURIComponent(key)}/Title/Hello%20KV`, {
        env,
        request: { method: 'GET', headers: authenticatedHeaders() },
    })

    assert.equal(response.status, 200)
    assert.equal(kv.calls.find((call) => call.type === 'get').key, key)
    assert.equal(apns.payload().aps.alert.body, 'Hello KV')
})

test('KV enforces the streamed 32 KiB request boundary', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const env = await createTestEnv({ database: kvWithDevices() })

    const accepted = await push(env, jsonTextOfByteLength(32 * 1024))
    const rejected = await push(env, jsonTextOfByteLength(32 * 1024 + 1))

    assert.equal(accepted.response.status, 200)
    assert.equal(rejected.response.status, 413)
    assert.equal(apns.requests.length, 1)
})

test('KV batch keeps HTTP 200 stats at 20 and rejects 21 before APNs', async (t) => {
    const entries = Array.from({ length: 21 }, (_, index) => [
        `kvdevice${index}`,
        index.toString(16).padStart(64, 'a'),
    ])
    const env = await createTestEnv({ database: kvWithDevices(entries) })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const accepted = await push(env, {
        device_keys: entries.slice(0, 20).map(([key]) => key),
        body: 'twenty',
    })
    const acceptedBody = await readJson(accepted.response)
    const rejected = await push(env, {
        device_keys: entries.map(([key]) => key),
        body: 'twenty one',
    })

    assert.equal(accepted.response.status, 200)
    assert.equal(acceptedBody.success_count, 20)
    assert.equal(acceptedBody.failed_count, 0)
    assert.equal(rejected.response.status, 413)
    assert.equal(apns.requests.length, 20)
})

test('KV batch APNs concurrency never exceeds five', async (t) => {
    const entries = Array.from({ length: 20 }, (_, index) => [
        `kvdevice${index}`,
        index.toString(16).padStart(64, 'a'),
    ])
    const env = await createTestEnv({ database: kvWithDevices(entries) })
    const apns = createAPNsStub({ scenario: apnsScenario.success({ delayMs: 30 }) })
    installFetchStub(t, apns.fetch)

    const { response } = await push(env, {
        device_keys: entries.map(([key]) => key),
        body: 'concurrency',
    })

    assert.equal(response.status, 200)
    assert.equal(apns.requests.length, 20)
    assert.ok(apns.maxActive <= 5, `expected <= 5 concurrent calls, observed ${apns.maxActive}`)
})

test('KV maps APNs reason-less errors, timeout, and network refusal without throwing', async (t) => {
    const cases = [
        ['missing reason', apnsScenario.jsonWithoutReason(400), 400],
        ['timeout', apnsScenario.timeout({ safetyMs: 1250 }), 504],
        ['network', apnsScenario.networkError(), 502],
        ['server error', apnsScenario.status(500, 'InternalServerError'), 503],
    ]

    for (const [name, scenario, expectedStatus] of cases) {
        await t.test(name, async (t) => {
            const env = await createTestEnv({
                database: kvWithDevices(),
                APNS_TIMEOUT_MS: '1000',
            })
            const apns = createAPNsStub({ scenario })
            installFetchStub(t, apns.fetch)

            const { response } = await push(env, { device_key: TEST_DEVICE_KEY, body: name })
            assert.equal(response.status, expectedStatus)
        })
    }
})

test('KV rejects oversized APNs payloads locally', async (t) => {
    const env = await createTestEnv({ database: kvWithDevices() })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await push(env, {
        device_key: TEST_DEVICE_KEY,
        body: '🙂'.repeat(1100),
    })

    assert.equal(response.status, 413)
    assert.equal(apns.requests.length, 0)
})

test('KV stored invalid device tokens return a generic 400 without contacting APNs', async (t) => {
    const invalidStoredToken = 'not-a-valid-apns-token'
    const env = await createTestEnv({
        database: kvWithDevices([[TEST_DEVICE_KEY, invalidStoredToken]]),
    })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await push(env, {
        device_key: TEST_DEVICE_KEY,
        body: 'must not leave the Worker',
    })
    const body = await readJson(response)

    assert.equal(response.status, 400)
    assert.equal(body.code, 400)
    assert.equal(body.message, 'invalid device key')
    assert.doesNotMatch(JSON.stringify(body), new RegExp(invalidStoredToken))
    assert.equal(apns.requests.length, 0)
})
