import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../main.js'
import kvWorker from '../main_kv.js'
import { apnsScenario, createAPNsStub } from './helpers/apns.js'
import { FakeD1Database } from './helpers/fake-d1.js'
import { FakeKVNamespace } from './helpers/fake-kv.js'
import {
    TEST_DEVICE_KEY,
    TEST_DEVICE_TOKEN,
    authenticatedHeaders,
    createTestEnv,
    installDeterministicSignature,
} from './helpers/worker-harness.js'
import { createWorkerContext, installFetchStub, invokeWorker, readJson } from './helpers/worker-context.js'

async function push(env, body = 'APNs regression') {
    return invokeWorker(worker, '/push', {
        env,
        request: {
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body }),
        },
    })
}

const implementations = [
    {
        name: 'D1',
        worker,
        database: () => new FakeD1Database(),
    },
    {
        name: 'KV',
        worker: kvWorker,
        database: () => new FakeKVNamespace({
            values: [[TEST_DEVICE_KEY, TEST_DEVICE_TOKEN], ['_authToken_', 'test-authorization-token']],
        }),
    },
]

async function pushWith(implementation, env, payload) {
    return invokeWorker(implementation.worker, '/push', {
        env,
        request: {
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, ...payload }),
        },
    })
}

test('concurrent cold-start pushes share one ES256 signing promise and emit Base64URL JWT segments', async (t) => {
    const database = new FakeD1Database({ authorization: null })
    const env = await createTestEnv({ database })
    const signature = installDeterministicSignature(t)
    const apns = createAPNsStub({ scenario: apnsScenario.success({ delayMs: 10 }) })
    installFetchStub(t, apns.fetch)
    const firstRuntime = createWorkerContext()
    const secondRuntime = createWorkerContext()

    const [first, second] = await Promise.all([
        invokeWorker(worker, '/push', {
            env,
            runtime: firstRuntime,
            request: {
                method: 'POST',
                headers: authenticatedHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body: 'first' }),
            },
        }),
        invokeWorker(worker, '/push', {
            env,
            runtime: secondRuntime,
            request: {
                method: 'POST',
                headers: authenticatedHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body: 'second' }),
            },
        }),
    ])

    assert.equal(first.response.status, 200)
    assert.equal(second.response.status, 200)
    assert.equal(signature.calls, 1)
    assert.equal(apns.requests.length, 2)

    const tokens = apns.requests.map(({ init }) => new Headers(init.headers).get('authorization')?.replace(/^bearer\s+/i, ''))
    assert.equal(tokens[0], tokens[1])
    assert.equal(tokens[0].split('.').length, 3)
    for (const segment of tokens[0].split('.')) {
        assert.match(segment, /^[A-Za-z0-9_-]+$/)
        assert.doesNotMatch(segment, /=/)
    }
})

test('new APNs provider JWTs are cached in isolate memory, not D1 authorization rows', async (t) => {
    const database = new FakeD1Database({ authorization: null })
    const env = await createTestEnv({ database })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const first = await push(env, 'cache one')
    const second = await push(env, 'cache two')

    assert.equal(first.response.status, 200)
    assert.equal(second.response.status, 200)
    assert.equal(database.callsMatching(/authorization/i).length, 0)
})

test('APNs empty, invalid, and reason-less JSON bodies return stable responses instead of throwing', async (t) => {
    const scenarios = [
        ['empty body', apnsScenario.emptyBody(400)],
        ['invalid JSON', apnsScenario.invalidJson(400)],
        ['missing reason', apnsScenario.jsonWithoutReason(400)],
        ['non-string reason', { status: 400, body: JSON.stringify({ reason: { code: 'BadDeviceToken' } }) }],
    ]

    for (const [name, scenario] of scenarios) {
        await t.test(name, async (t) => {
            const database = new FakeD1Database()
            const env = await createTestEnv({ database })
            const apns = createAPNsStub({ scenario })
            installFetchStub(t, apns.fetch)

            const { response } = await push(env)
            const body = await readJson(response)

            assert.equal(response.status, 400)
            assert.equal(body.code, 400)
            assert.equal(typeof body.message, 'string')
            assert.ok(body.message.trim().length > 'push failed:'.length)
            assert.equal(database.devices.get(TEST_DEVICE_KEY), TEST_DEVICE_TOKEN)
        })
    }
})

test('only permanent APNs token failures clear a stored device token', async (t) => {
    const scenarios = [
        ['410 Unregistered', apnsScenario.status(410, 'Unregistered'), true],
        ['400 BadDeviceToken', apnsScenario.status(400, 'BadDeviceToken'), true],
        ['400 DeviceTokenNotForTopic', apnsScenario.status(400, 'DeviceTokenNotForTopic'), false],
        ['403 ExpiredProviderToken', apnsScenario.status(403, 'ExpiredProviderToken'), false],
        ['500 InternalServerError', apnsScenario.status(500, 'InternalServerError'), false],
    ]

    for (const [name, scenario, clearsToken] of scenarios) {
        await t.test(name, async (t) => {
            const database = new FakeD1Database()
            const env = await createTestEnv({ database })
            const apns = createAPNsStub({ scenario })
            installFetchStub(t, apns.fetch)

            await push(env)

            assert.equal(database.devices.get(TEST_DEVICE_KEY), clearsToken ? '' : TEST_DEVICE_TOKEN)
        })
    }
})

test('APNs status mapping preserves client errors and marks throttling/server failures retryable', async (t) => {
    const cases = [
        ['payload too large', apnsScenario.status(413, 'PayloadTooLarge'), 413, false],
        ['throttled', apnsScenario.status(429, 'TooManyRequests', { headers: { 'retry-after': '17' } }), 429, true],
        ['server 500', apnsScenario.status(500, 'InternalServerError'), 503, true],
        ['server 503', apnsScenario.status(503, 'ServiceUnavailable'), 503, true],
    ]

    for (const [name, scenario, expectedStatus, retryable] of cases) {
        await t.test(name, async (t) => {
            const env = await createTestEnv()
            const apns = createAPNsStub({ scenario })
            installFetchStub(t, apns.fetch)

            const { response } = await push(env)
            const body = await readJson(response)

            assert.equal(response.status, expectedStatus)
            assert.equal(body.retryable, retryable)
            if (scenario.status === 429) assert.equal(response.headers.get('retry-after'), '17')
        })
    }
})

test('APNs timeout is aborted and mapped to 504 within the configured budget', async (t) => {
    const env = await createTestEnv({ APNS_TIMEOUT_MS: '1000' })
    const apns = createAPNsStub({ scenario: apnsScenario.timeout({ safetyMs: 1250 }) })
    installFetchStub(t, apns.fetch)
    const startedAt = Date.now()

    const { response } = await push(env)

    assert.equal(response.status, 504)
    assert.ok(Date.now() - startedAt < 1200, 'timeout should be enforced by AbortController')
    assert.ok(apns.requests[0].init.signal instanceof AbortSignal)
})

test('APNs network refusal is caught and mapped to 502', async (t) => {
    const env = await createTestEnv()
    const apns = createAPNsStub({ scenario: apnsScenario.networkError() })
    installFetchStub(t, apns.fetch)

    const { response } = await push(env)
    const body = await readJson(response)

    assert.equal(response.status, 502)
    assert.equal(body.retryable, true)
    assert.doesNotMatch(JSON.stringify(body), /simulated network refusal/)
})

for (const implementation of implementations) {
    test(`${implementation.name}: APNs timeout covers a delayed error response body`, async (t) => {
        const env = await createTestEnv({
            database: implementation.database(),
            APNS_TIMEOUT_MS: '1000',
        })
        const apns = createAPNsStub({
            scenario: apnsScenario.delayedErrorBody(400, 'BadDeviceToken', { bodyDelayMs: 1250 }),
        })
        installFetchStub(t, apns.fetch)
        const startedAt = Date.now()

        const { response } = await pushWith(implementation, env, { body: 'delayed APNs body' })
        const body = await readJson(response)

        assert.equal(response.status, 504)
        assert.equal(body.retryable, true)
        assert.ok(Date.now() - startedAt < 1200, 'the timeout must cover response body consumption')
        assert.equal(apns.requests.length, 1)
    })

    test(`${implementation.name}: background delete notifications use APNs priority 5`, async (t) => {
        const env = await createTestEnv({ database: implementation.database() })
        const apns = createAPNsStub()
        installFetchStub(t, apns.fetch)

        const { response } = await pushWith(implementation, env, {
            body: 'background delete',
            delete: 1,
        })
        const headers = new Headers(apns.requests[0].init.headers)

        assert.equal(response.status, 200)
        assert.equal(headers.get('apns-push-type'), 'background')
        assert.equal(headers.get('apns-priority'), '5')
    })
}
