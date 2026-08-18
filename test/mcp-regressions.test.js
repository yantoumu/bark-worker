import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../main.js'
import { createAPNsStub } from './helpers/apns.js'
import { FakeD1Database } from './helpers/fake-d1.js'
import { authenticatedHeaders, createTestEnv } from './helpers/worker-harness.js'
import { installFetchStub, invokeWorker, readJson } from './helpers/worker-context.js'

async function mcpRequest(path, payload, env, options = {}) {
    const headers = options.auth === false
        ? { 'content-type': 'application/json', ...options.headers }
        : authenticatedHeaders({
            'content-type': 'application/json',
            origin: 'https://client.example',
            ...options.headers,
        })
    return invokeWorker(worker, path, {
        env,
        request: {
            method: options.method ?? 'POST',
            headers,
            body: payload === undefined ? undefined : JSON.stringify(payload),
        },
    })
}

async function initialize(env, path = '/mcp', protocolVersion = '2025-06-18') {
    const result = await mcpRequest(path, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }, env)
    return {
        ...result,
        body: await readJson(result.response.clone()),
        sessionId: result.response.headers.get('mcp-session-id'),
    }
}

async function markInitialized(env, sessionId, path = '/mcp', protocolVersion = '2025-06-18') {
    return mcpRequest(path, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
    }, env, {
        headers: {
            'mcp-session-id': sessionId,
            'mcp-protocol-version': protocolVersion,
        },
    })
}

test('MCP initialize negotiates both declared stable protocol versions', async (t) => {
    const protocols = [
        ['2025-03-26', 'v20250326'],
        ['2025-06-18', 'v20250618'],
    ]
    for (const [protocolVersion, sessionVersion] of protocols) {
        await t.test(protocolVersion, async () => {
            const database = new FakeD1Database({ sessions: [] })
            const env = await createTestEnv({ database })
            const { response, body, sessionId } = await initialize(env, '/mcp', protocolVersion)

            assert.equal(response.status, 200)
            assert.equal(body.result.protocolVersion, protocolVersion)
            assert.match(sessionId ?? '', new RegExp(`^mcp-session-${sessionVersion}-[0-9a-f-]{36}$`))
            assert.equal('protocol_version' in database.sessions.get(sessionId), false)
        })
    }
})

test('MCP initialize persists an uninitialized session until the notification arrives', async () => {
    const database = new FakeD1Database({ sessions: [] })
    const env = await createTestEnv({ database })
    const { sessionId } = await initialize(env)

    assert.equal(database.sessions.get(sessionId).initialized, 0)

    const notification = await markInitialized(env, sessionId)
    assert.equal(notification.response.status, 202)
    assert.equal(await notification.response.text(), '')
    assert.equal(database.sessions.get(sessionId).initialized, 1)
})

test('MCP tools are unavailable before notifications/initialized', async () => {
    const env = await createTestEnv({ database: new FakeD1Database({ sessions: [] }) })
    const { sessionId } = await initialize(env)

    const { response } = await mcpRequest('/mcp', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
    }, env, {
        headers: {
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-06-18',
        },
    })
    const body = await readJson(response)

    assert.ok(body.error, 'pre-initialization request must return a JSON-RPC error')
    assert.equal(body.result, undefined)
})

test('MCP notification returns HTTP 202 with an empty body', async () => {
    const env = await createTestEnv({ database: new FakeD1Database({ sessions: [] }) })
    const { sessionId } = await initialize(env)
    const { response } = await markInitialized(env, sessionId)

    assert.equal(response.status, 202)
    assert.equal(response.headers.get('content-length'), null)
    assert.equal(await response.text(), '')
})

test('MCP 2025-06-18 follow-up requests require MCP-Protocol-Version', async () => {
    const env = await createTestEnv({ database: new FakeD1Database({ sessions: [] }) })
    const { sessionId } = await initialize(env)

    const { response } = await mcpRequest('/mcp', {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
    }, env, { headers: { 'mcp-session-id': sessionId } })

    assert.equal(response.status, 400)
})

test('legacy unversioned MCP session IDs remain compatible with 2025-03-26', async () => {
    const now = Math.floor(Date.now() / 1000)
    const sessionId = 'mcp-session-legacy-client'
    const database = new FakeD1Database({
        sessions: [[sessionId, {
            id: sessionId,
            device_key: null,
            initialized: 1,
            created_at: now,
            last_seen: now,
        }]],
    })
    const env = await createTestEnv({ database })

    const { response } = await mcpRequest('/mcp', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
    }, env, { headers: { 'mcp-session-id': sessionId } })
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.ok(Array.isArray(body.result.tools))
    assert.equal(response.headers.get('mcp-protocol-version'), null)
})

test('MCP distinguishes missing, unknown, and expired sessions', async (t) => {
    const now = Math.floor(Date.now() / 1000)
    const database = new FakeD1Database({
        sessions: [[
            'mcp-session-expired',
            { id: 'mcp-session-expired', device_key: null, initialized: 1, created_at: now - 90000, last_seen: now - 4000 },
        ]],
    })
    const env = await createTestEnv({ database })
    const cases = [
        ['missing', undefined, 400],
        ['unknown', 'mcp-session-unknown', 404],
        ['expired', 'mcp-session-expired', 404],
    ]

    for (const [name, sessionId, expectedStatus] of cases) {
        await t.test(name, async () => {
            const headers = { 'mcp-protocol-version': '2025-06-18' }
            if (sessionId) headers['mcp-session-id'] = sessionId
            const { response } = await mcpRequest('/mcp', {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
            }, env, { headers })

            assert.equal(response.status, expectedStatus)
        })
    }
})

test('MCP session is bound to the device-specific URL that created it', async () => {
    const database = new FakeD1Database({
        devices: [['device-a', 'a'.repeat(64)], ['device-b', 'b'.repeat(64)]],
        sessions: [],
    })
    const env = await createTestEnv({ database })
    const { sessionId } = await initialize(env, '/mcp/device-a')
    await markInitialized(env, sessionId, '/mcp/device-a')

    const { response } = await mcpRequest('/mcp/device-b', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
    }, env, {
        headers: {
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-06-18',
        },
    })

    assert.ok([403, 404].includes(response.status), `expected ownership rejection, got ${response.status}`)
})

test('MCP DELETE validates session existence and device ownership before deletion', async () => {
    const database = new FakeD1Database({ sessions: [] })
    const env = await createTestEnv({ database })
    const { sessionId } = await initialize(env, '/mcp/device-a')

    const { response } = await mcpRequest('/mcp/device-b', undefined, env, {
        method: 'DELETE',
        headers: {
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-06-18',
        },
    })

    assert.ok([403, 404].includes(response.status), `expected ownership rejection, got ${response.status}`)
    assert.ok(database.sessions.has(sessionId))
})

test('MCP validates a present Origin header against the configured allowlist', async (t) => {
    const env = await createTestEnv({ database: new FakeD1Database({ sessions: [] }) })
    const initializeBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
    }

    await t.test('allowed origin', async () => {
        const { response } = await mcpRequest('/mcp', initializeBody, env)
        assert.equal(response.status, 200)
    })

    await t.test('untrusted origin', async () => {
        const { response } = await mcpRequest('/mcp', initializeBody, env, {
            headers: { origin: 'https://evil.example' },
        })
        assert.equal(response.status, 403)
    })
})

test('MCP remains authenticated even when legacy push compatibility is enabled', async () => {
    const env = await createTestEnv({
        database: new FakeD1Database({ sessions: [] }),
        SECURITY_MODE: 'compat',
        BASIC_AUTH: undefined,
    })
    const { response } = await mcpRequest('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
    }, env, { auth: false, headers: { origin: 'https://client.example' } })

    assert.equal(response.status, 503)
})

test('GET /mcp returns 405 because SSE is not implemented', async () => {
    const env = await createTestEnv({ database: new FakeD1Database({ sessions: [] }) })
    const { response } = await mcpRequest('/mcp', undefined, env, { method: 'GET' })

    assert.equal(response.status, 405)
    assert.match(response.headers.get('allow') ?? '', /POST/)
})

test('MCP tool calls reuse the push validator and never reach APNs for invalid input', async (t) => {
    const database = new FakeD1Database({ sessions: [] })
    const env = await createTestEnv({ database })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const { sessionId } = await initialize(env)
    await markInitialized(env, sessionId)

    const { response } = await mcpRequest('/mcp', {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
            name: 'notify',
            arguments: {
                device_key: 'test-device-key',
                body: { not: 'a string' },
                url: 'javascript:alert(1)',
            },
        },
    }, env, {
        headers: {
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-06-18',
        },
    })
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.result.isError, true)
    assert.equal(apns.requests.length, 0)
})

test('unknown MCP tool notifications return 202 with an empty body and never contact APNs', async (t) => {
    const database = new FakeD1Database({ sessions: [] })
    const env = await createTestEnv({ database })
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const { sessionId } = await initialize(env)
    await markInitialized(env, sessionId)

    const { response } = await mcpRequest('/mcp', {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'unknown-tool', arguments: {} },
    }, env, {
        headers: {
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-06-18',
        },
    })

    assert.equal(response.status, 202)
    assert.equal(response.headers.get('content-length'), null)
    assert.equal(await response.text(), '')
    assert.equal(apns.requests.length, 0)
})
