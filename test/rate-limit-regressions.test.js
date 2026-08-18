import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../main.js'
import kvWorker from '../main_kv.js'
import { createAPNsStub } from './helpers/apns.js'
import { FakeD1Database } from './helpers/fake-d1.js'
import { FakeKVNamespace } from './helpers/fake-kv.js'
import { FakeRateLimiter } from './helpers/fake-rate-limiter.js'
import {
    TEST_AUTH,
    TEST_DEVICE_KEY,
    TEST_DEVICE_TOKEN,
    authenticatedHeaders,
    createTestEnv,
} from './helpers/worker-harness.js'
import { installFetchStub, invokeWorker } from './helpers/worker-context.js'

async function jsonRequest(path, payload, env) {
    return jsonRequestTo(worker, path, payload, env)
}

async function jsonRequestTo(targetWorker, path, payload, env, options = {}) {
    return invokeWorker(targetWorker, path, {
        env,
        request: {
            method: 'POST',
            headers: authenticatedHeaders({
                'content-type': 'application/json',
                origin: 'https://client.example',
                'cf-connecting-ip': '192.0.2.10',
                ...options.headers,
            }),
            body: JSON.stringify(payload),
        },
    })
}

const implementations = [
    {
        name: 'D1',
        worker,
        database: () => new FakeD1Database(),
        storageCalls: (database) => database.calls.length,
    },
    {
        name: 'KV',
        worker: kvWorker,
        database: () => new FakeKVNamespace({
            values: [[TEST_DEVICE_KEY, TEST_DEVICE_TOKEN], ['_authToken_', 'test-authorization-token']],
        }),
        storageCalls: (database) => database.calls.length,
    },
]

function throwingLimiter(message = 'sensitive limiter failure') {
    return {
        calls: [],
        async limit(options) {
            this.calls.push(structuredClone(options))
            throw new Error(message)
        },
    }
}

test('register rate limiter rejects before a device write and hashes sensitive subjects', async () => {
    const limiter = new FakeRateLimiter([{ success: false }])
    const database = new FakeD1Database({ devices: [] })
    const env = await createTestEnv({
        database,
        ALLOW_NEW_DEVICE: 'true',
        REGISTER_RATE_LIMITER: limiter,
    })

    const { response } = await jsonRequest('/register', {
        device_key: 'rate-limited-device',
        device_token: TEST_DEVICE_TOKEN,
    }, env)

    assert.equal(response.status, 429)
    assert.equal(limiter.calls.length, 1)
    assert.equal(database.devices.size, 0)
    const limiterKey = String(limiter.calls[0].key)
    assert.doesNotMatch(limiterKey, new RegExp(TEST_AUTH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(limiterKey, new RegExp(TEST_DEVICE_TOKEN))
})

test('single-device push rate limiter rejects before D1 lookup and APNs', async (t) => {
    const limiter = new FakeRateLimiter([{ success: false }])
    const database = new FakeD1Database()
    const env = await createTestEnv({ database, PUSH_RATE_LIMITER: limiter })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await jsonRequest('/push', {
        device_key: TEST_DEVICE_KEY,
        body: 'rate limited',
    }, env)

    assert.equal(response.status, 429)
    assert.equal(limiter.calls.length, 1)
    assert.equal(database.callsMatching(/select `token` from `devices`/i).length, 0)
    assert.equal(apns.requests.length, 0)
})

test('batch rate limiter rejects before per-device fan-out', async (t) => {
    const limiter = new FakeRateLimiter([{ success: false }])
    const env = await createTestEnv({ BATCH_RATE_LIMITER: limiter })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)

    const { response } = await jsonRequest('/push', {
        device_keys: [TEST_DEVICE_KEY],
        body: 'rate limited batch',
    }, env)

    assert.equal(response.status, 429)
    assert.equal(limiter.calls.length, 1)
    assert.equal(apns.requests.length, 0)
})

test('MCP rate limiter rejects initialize before session creation', async () => {
    const limiter = new FakeRateLimiter([{ success: false }])
    const database = new FakeD1Database({ sessions: [] })
    const env = await createTestEnv({ database, MCP_RATE_LIMITER: limiter })

    const { response } = await jsonRequest('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
    }, env)

    assert.equal(response.status, 429)
    assert.equal(limiter.calls.length, 1)
    assert.equal(database.sessions.size, 0)
})

test('MCP initialize rejects supplied session IDs while rate limiting a fixed authenticated subject', async () => {
    const limiter = new FakeRateLimiter([{ success: true }])
    const database = new FakeD1Database({ sessions: [] })
    const env = await createTestEnv({ database, MCP_RATE_LIMITER: limiter })
    const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
    }

    for (const suppliedSession of ['attacker-selected-session-a', 'attacker-selected-session-b']) {
        const { response } = await invokeWorker(worker, '/mcp', {
            env,
            request: {
                method: 'POST',
                headers: authenticatedHeaders({
                    'content-type': 'application/json',
                    origin: 'https://client.example',
                    'mcp-session-id': suppliedSession,
                }),
                body: JSON.stringify(payload),
            },
        })

        assert.equal(response.status, 400)
    }

    assert.equal(database.sessions.size, 0)
    assert.equal(limiter.calls.length, 2)
    assert.equal(limiter.calls[0].key, limiter.calls[1].key)
    assert.doesNotMatch(String(limiter.calls[0].key), /attacker-selected-session/)
})

for (const implementation of implementations) {
    test(`${implementation.name}: missing route rate-limit bindings fail closed before storage or APNs`, async (t) => {
        const cases = [
            ['register', 'REGISTER_RATE_LIMITER', '/register', {
                device_key: 'new-rate-limit-device',
                device_token: TEST_DEVICE_TOKEN,
            }],
            ['single push', 'PUSH_RATE_LIMITER', '/push', {
                device_key: TEST_DEVICE_KEY,
                body: 'missing limiter',
            }],
            ['batch push', 'BATCH_RATE_LIMITER', '/push', {
                device_keys: [TEST_DEVICE_KEY],
                body: 'missing batch limiter',
            }],
        ]

        for (const [name, bindingName, path, payload] of cases) {
            await t.test(name, async (t) => {
                const database = implementation.database()
                const env = await createTestEnv({
                    database,
                    ALLOW_NEW_DEVICE: 'true',
                    [bindingName]: undefined,
                })
                const apns = createAPNsStub()
                installFetchStub(t, apns.fetch)

                const { response } = await jsonRequestTo(implementation.worker, path, payload, env)
                const text = await response.text()

                assert.equal(response.status, 503)
                assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
                assert.doesNotMatch(text, /binding|undefined|stack/i)
                assert.equal(implementation.storageCalls(database), 0)
                assert.equal(apns.requests.length, 0)
            })
        }
    })

    test(`${implementation.name}: rate limiter exceptions fail closed without leaking details`, async (t) => {
        const database = implementation.database()
        const limiter = throwingLimiter()
        const env = await createTestEnv({ database, PUSH_RATE_LIMITER: limiter })
        const apns = createAPNsStub()
        installFetchStub(t, apns.fetch)

        const { response } = await jsonRequestTo(implementation.worker, '/push', {
            device_key: TEST_DEVICE_KEY,
            body: 'throwing limiter',
        }, env)
        const text = await response.text()

        assert.equal(response.status, 503)
        assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
        assert.doesNotMatch(text, /sensitive limiter failure|stack/i)
        assert.equal(limiter.calls.length, 1)
        assert.equal(implementation.storageCalls(database), 0)
        assert.equal(apns.requests.length, 0)
    })
}

test('D1 MCP fails closed when its rate limiter is missing or throws before session creation', async (t) => {
    for (const [name, limiter] of [
        ['missing', undefined],
        ['throws', throwingLimiter('private MCP limiter error')],
    ]) {
        await t.test(name, async () => {
            const database = new FakeD1Database({ sessions: [] })
            const env = await createTestEnv({ database, MCP_RATE_LIMITER: limiter })

            const { response } = await jsonRequestTo(worker, '/mcp', {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {} },
            }, env)
            const text = await response.text()

            assert.equal(response.status, 503)
            assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
            assert.doesNotMatch(text, /private MCP limiter error|stack/i)
            assert.equal(database.sessions.size, 0)
            assert.equal(database.calls.length, 0)
        })
    }
})
