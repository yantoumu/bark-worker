import assert from 'node:assert/strict'
import test from 'node:test'

import d1Worker from '../main.js'
import kvWorker from '../main_kv.js'
import { createAPNsStub } from './helpers/apns.js'
import { FakeD1Database } from './helpers/fake-d1.js'
import { FakeKVNamespace } from './helpers/fake-kv.js'
import {
    TEST_DEVICE_KEY,
    TEST_DEVICE_TOKEN,
    authenticatedHeaders,
    basicAuthorization,
    createTestEnv,
} from './helpers/worker-harness.js'
import { installFetchStub, invokeWorker, readJson } from './helpers/worker-context.js'

const workers = [
    {
        name: 'D1',
        worker: d1Worker,
        binding: (entries = [[TEST_DEVICE_KEY, TEST_DEVICE_TOKEN], ['testdevicekey', TEST_DEVICE_TOKEN]]) => new FakeD1Database({ devices: entries }),
        storedToken: (binding, key) => binding.devices.get(key),
        writes: (binding) => binding.callsMatching(/(?:insert|update) into `devices`/i).length,
    },
    {
        name: 'KV',
        worker: kvWorker,
        binding: (entries = [[TEST_DEVICE_KEY, TEST_DEVICE_TOKEN], ['testdevicekey', TEST_DEVICE_TOKEN]]) => new FakeKVNamespace({
            values: [...entries, ['_authToken_', 'test-authorization-token']],
        }),
        storedToken: (binding, key) => binding.values.get(key)?.value,
        writes: (binding) => binding.calls.filter((call) => call.type === 'put' && call.key !== '_authToken_').length,
    },
]

async function request(worker, path, { env, method = 'GET', headers, body, settle = true } = {}) {
    return invokeWorker(worker, path, {
        env,
        settle,
        request: { method, headers, body },
    })
}

for (const implementation of workers) {
    test(`${implementation.name}: strict mode fails closed when BASIC_AUTH is missing`, async (t) => {
        const apns = createAPNsStub()
        installFetchStub(t, apns.fetch)
        const binding = implementation.binding()
        const env = await createTestEnv({ database: binding, BASIC_AUTH: undefined, SECURITY_MODE: 'strict' })

        const { response } = await request(implementation.worker, '/push', {
            env,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body: 'must not send' }),
        })

        assert.equal(response.status, 503)
        assert.equal(apns.requests.length, 0)
        assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
    })

    test(`${implementation.name}: strict authentication rejects malformed credentials without touching storage`, async (t) => {
        const cases = [
            ['missing', undefined],
            ['wrong secret', basicAuthorization('admin:wrong')],
            ['wrong scheme case', basicAuthorization().replace('Basic ', 'basic ')],
            ['invalid Base64', 'Basic !!!not-base64!!!'],
            ['extra whitespace', `Basic  ${basicAuthorization().slice(6)}`],
        ]

        for (const [name, authorization] of cases) {
            await t.test(name, async () => {
                const binding = implementation.binding()
                const env = await createTestEnv({ database: binding, SECURITY_MODE: 'strict' })
                const headers = { 'content-type': 'application/json' }
                if (authorization !== undefined) headers.authorization = authorization

                const { response } = await request(implementation.worker, '/push', {
                    env,
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body: 'blocked' }),
                })

                assert.equal(response.status, 401)
                assert.match(response.headers.get('www-authenticate') ?? '', /^Basic\b/)
                assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
                assert.equal(implementation.writes(binding), 0)
            })
        }
    })

    test(`${implementation.name}: explicit compat mode preserves unauthenticated legacy push`, async (t) => {
        const apns = createAPNsStub()
        installFetchStub(t, apns.fetch)
        const env = await createTestEnv({
            database: implementation.binding(),
            SECURITY_MODE: 'compat',
            BASIC_AUTH: undefined,
        })

        const { response } = await request(implementation.worker, '/push', {
            env,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body: 'legacy contract' }),
        })

        assert.equal(response.status, 200)
        assert.equal(apns.requests.length, 1)
    })

    test(`${implementation.name}: POST /register accepts JSON and legacy field aliases`, async () => {
        const binding = implementation.binding([])
        const env = await createTestEnv({ database: binding, ALLOW_NEW_DEVICE: 'true' })
        const token = 'AB'.repeat(32)

        const { response } = await request(implementation.worker, '/register', {
            env,
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ key: 'new-device-key', devicetoken: token }),
        })
        const body = await readJson(response)

        assert.equal(response.status, 200)
        assert.equal(body.code, 200)
        assert.equal(body.data.device_key, 'new-device-key')
        assert.equal(implementation.storedToken(binding, 'new-device-key'), token.toLowerCase())
    })

    test(`${implementation.name}: POST /register accepts form data without exposing token in the URL`, async () => {
        const binding = implementation.binding([])
        const env = await createTestEnv({ database: binding, ALLOW_NEW_DEVICE: 'true' })
        const form = new URLSearchParams({ device_key: 'form-device-key', device_token: 'cd'.repeat(32) })

        const { response } = await request(implementation.worker, '/register', {
            env,
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/x-www-form-urlencoded' }),
            body: form.toString(),
        })

        assert.equal(response.status, 200)
        assert.equal(implementation.storedToken(binding, 'form-device-key'), 'cd'.repeat(32))
    })

    test(`${implementation.name}: legacy GET registration is disabled by default`, async () => {
        const binding = implementation.binding()
        const env = await createTestEnv({ database: binding, ALLOW_LEGACY_GET_REGISTER: 'false' })
        const url = `/register?key=${TEST_DEVICE_KEY}&devicetoken=${'b'.repeat(64)}`

        const { response } = await request(implementation.worker, url, {
            env,
            headers: authenticatedHeaders(),
        })

        assert.equal(response.status, 405)
        assert.match(response.headers.get('allow') ?? '', /POST/)
        assert.equal(implementation.storedToken(binding, TEST_DEVICE_KEY), TEST_DEVICE_TOKEN)
    })

    test(`${implementation.name}: explicitly enabled legacy GET registration is deprecated and non-cacheable`, async () => {
        const binding = implementation.binding([])
        const env = await createTestEnv({
            database: binding,
            SECURITY_MODE: 'compat',
            BASIC_AUTH: undefined,
            ALLOW_NEW_DEVICE: 'true',
            ALLOW_LEGACY_GET_REGISTER: 'true',
        })

        const { response } = await request(
            implementation.worker,
            `/register?key=legacy-key&devicetoken=${'c'.repeat(64)}`,
            { env },
        )

        assert.equal(response.status, 200)
        assert.ok(response.headers.has('deprecation'))
        assert.ok(response.headers.has('sunset'))
        assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    })

    test(`${implementation.name}: unauthenticated callers cannot rebind an existing key`, async () => {
        const binding = implementation.binding()
        const env = await createTestEnv({ database: binding, SECURITY_MODE: 'strict' })

        const { response } = await request(implementation.worker, '/register', {
            env,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, device_token: 'b'.repeat(64) }),
        })

        assert.equal(response.status, 401)
        assert.equal(implementation.storedToken(binding, TEST_DEVICE_KEY), TEST_DEVICE_TOKEN)
    })

    test(`${implementation.name}: compat rebind requires the explicit insecure escape hatch`, async () => {
        const binding = implementation.binding()
        const env = await createTestEnv({
            database: binding,
            SECURITY_MODE: 'compat',
            BASIC_AUTH: undefined,
            ALLOW_INSECURE_DEVICE_REBIND: 'false',
        })

        const { response } = await request(implementation.worker, '/register', {
            env,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, device_token: 'b'.repeat(64) }),
        })

        assert.equal(response.status, 409)
        assert.equal(implementation.storedToken(binding, TEST_DEVICE_KEY), TEST_DEVICE_TOKEN)
    })

    test(`${implementation.name}: authenticated rebind updates the token exactly once`, async () => {
        const binding = implementation.binding()
        const env = await createTestEnv({ database: binding })

        const { response } = await request(implementation.worker, '/register', {
            env,
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, device_token: 'B0'.repeat(32) }),
        })

        assert.equal(response.status, 200)
        assert.equal(implementation.storedToken(binding, TEST_DEVICE_KEY), 'b0'.repeat(32))
        assert.equal(implementation.writes(binding), 1)
    })

    test(`${implementation.name}: idempotent registration does not rewrite storage`, async () => {
        const binding = implementation.binding()
        const env = await createTestEnv({ database: binding })

        const { response } = await request(implementation.worker, '/register', {
            env,
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, device_token: TEST_DEVICE_TOKEN }),
        })

        assert.equal(response.status, 200)
        assert.equal(implementation.writes(binding), 0)
    })

    test(`${implementation.name}: register rejects a legacy-fallback key collision without overwriting either key`, async () => {
        const requestedKey = 'collision-key'
        const legacyKey = 'collisionkey'
        const storedToken = 'c0'.repeat(32)
        const replacementToken = 'd0'.repeat(32)
        const binding = implementation.binding([[legacyKey, storedToken]])
        const env = await createTestEnv({ database: binding, ALLOW_NEW_DEVICE: 'true' })

        const { response } = await request(implementation.worker, '/register', {
            env,
            method: 'POST',
            headers: authenticatedHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ device_key: requestedKey, device_token: replacementToken }),
        })
        const body = await readJson(response)

        assert.equal(response.status, 409)
        assert.equal(body.message, 'device key is already registered')
        assert.equal(implementation.storedToken(binding, legacyKey), storedToken)
        assert.equal(implementation.storedToken(binding, requestedKey), undefined)
        assert.equal(implementation.writes(binding), 0)
    })

    test(`${implementation.name}: register validates token type, format, and length`, async (t) => {
        const invalidTokens = [
            ['object', { value: TEST_DEVICE_TOKEN }],
            ['non-hex', 'z'.repeat(64)],
            ['odd length', 'a'.repeat(33)],
            ['too short', 'a'.repeat(30)],
            ['too long', 'a'.repeat(162)],
        ]

        for (const [name, token] of invalidTokens) {
            await t.test(name, async () => {
                const binding = implementation.binding([])
                const env = await createTestEnv({ database: binding, ALLOW_NEW_DEVICE: 'true' })
                const { response } = await request(implementation.worker, '/register', {
                    env,
                    method: 'POST',
                    headers: authenticatedHeaders({ 'content-type': 'application/json' }),
                    body: JSON.stringify({ device_key: 'invalid-token-key', device_token: token }),
                })
                const body = await readJson(response)

                assert.equal(response.status, 400)
                assert.match(body.message, /device token.*invalid/i)
                assert.equal(implementation.storedToken(binding, 'invalid-token-key'), undefined)
            })
        }
    })

    test(`${implementation.name}: invalid numeric, path, and legacy sunset configuration fails closed`, async (t) => {
        const cases = [
            ['unsupported security mode', { SECURITY_MODE: 'legacy' }],
            ['misspelled boolean', { ALLOW_QUERY_NUMS: 'False' }],
            ['insecure rebind outside compat mode', { ALLOW_INSECURE_DEVICE_REBIND: 'true' }],
            ['non-numeric request limit', { MAX_REQUEST_BYTES: '32KiB' }],
            ['out-of-range batch size', { MAX_BATCH_SIZE: '21' }],
            ['timeout below one second', { APNS_TIMEOUT_MS: '999' }],
            ['concurrency larger than batch size', { MAX_BATCH_SIZE: '2', BATCH_CONCURRENCY: '3' }],
            ['relative root path', { ROOT_PATH: 'worker' }],
            ['malformed legacy sunset', {
                ALLOW_LEGACY_GET_REGISTER: 'true',
                LEGACY_GET_REGISTER_SUNSET: '2027-12-31',
            }],
        ]

        for (const [name, overrides] of cases) {
            await t.test(name, async () => {
                const env = await createTestEnv({ database: implementation.binding(), ...overrides })
                const { response } = await request(implementation.worker, '/healthz', { env })
                const body = await response.text()

                assert.equal(response.status, 503)
                assert.match(body, /config/i)
                assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
            })
        }
    })
}

test('D1: MCP origin configuration rejects wildcard and non-canonical origins', async (t) => {
    const cases = [
        ['wildcard', '*'],
        ['non-canonical path', 'https://client.example/path'],
    ]

    for (const [name, value] of cases) {
        await t.test(name, async () => {
            const env = await createTestEnv({ MCP_ALLOWED_ORIGINS: value })
            const { response } = await request(d1Worker, '/healthz', { env })
            const body = await response.text()

            assert.equal(response.status, 503)
            assert.match(body, /config/i)
            assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
        })
    }
})

test('strict boolean parsing rejects misspelled configuration values', async () => {
    const env = await createTestEnv({ ALLOW_NEW_DEVICE: 'False' })
    const { response } = await request(d1Worker, '/healthz', { env })
    const body = await response.text()

    assert.equal(response.status, 503)
    assert.match(body, /config/i)
})

test('/info defaults to hiding device counts and does not issue a count query', async () => {
    const database = new FakeD1Database({ devices: [[TEST_DEVICE_KEY, TEST_DEVICE_TOKEN]] })
    const env = await createTestEnv({ database, ALLOW_QUERY_NUMS: undefined })
    const { response } = await request(d1Worker, '/info', {
        env,
        headers: authenticatedHeaders(),
    })
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.equal('devices' in body, false)
    assert.equal(database.callsMatching(/count\(\*\).*devices/i).length, 0)
})

test('KV /info counts only device entries, excluding _authToken_ and non-device metadata', async () => {
    const database = new FakeKVNamespace({
        values: [
            ['_authToken_', 'test-authorization-token'],
            ['device-a', 'a'.repeat(64)],
            ['device-b', 'b'.repeat(64)],
        ],
    })
    await database.put('session:mcp-session-v20250618-test', JSON.stringify({ initialized: true }), {
        metadata: { kind: 'session' },
    })
    const env = await createTestEnv({ database, ALLOW_QUERY_NUMS: 'true' })

    const { response } = await request(kvWorker, '/info', {
        env,
        headers: authenticatedHeaders(),
    })
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.devices, 2)
})

test('KV /info paginates all device entries without counting reserved keys', async () => {
    const entries = Array.from({ length: 1001 }, (_, index) => [
        `device-${index}`,
        index.toString(16).padStart(64, '0'),
    ])
    const database = new FakeKVNamespace({
        values: [...entries, ['_authToken_', 'test-authorization-token']],
    })
    const env = await createTestEnv({ database, ALLOW_QUERY_NUMS: 'true' })

    const { response } = await request(kvWorker, '/info', {
        env,
        headers: authenticatedHeaders(),
    })
    const body = await readJson(response)
    const listCalls = database.calls.filter((call) => call.type === 'list')

    assert.equal(response.status, 200)
    assert.equal(body.devices, entries.length)
    assert.equal(listCalls.length, 2)
    assert.equal(listCalls[1].options.cursor, '1000')
})

test('KV /info fails closed when pagination does not advance', async () => {
    const database = {
        calls: [],
        async list(options = {}) {
            this.calls.push(structuredClone(options))
            return { keys: [], list_complete: false, cursor: 'stalled' }
        },
    }
    const env = await createTestEnv({ database, ALLOW_QUERY_NUMS: 'true' })

    const { response } = await request(kvWorker, '/info', {
        env,
        headers: authenticatedHeaders(),
    })

    assert.equal(response.status, 503)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
    assert.equal(database.calls.length, 2)
})
