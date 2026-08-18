import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../main.js'
import { createAPNsStub } from './helpers/apns.js'
import { FakeD1Database } from './helpers/fake-d1.js'
import {
    TEST_AUTH,
    TEST_BOOTSTRAP_TOKEN,
    TEST_DEVICE_KEY,
    TEST_MASTER_KEY,
    authenticatedHeaders,
    createTestEnv,
    testAPNsCredentials,
} from './helpers/worker-harness.js'
import { installFetchStub, invokeWorker, readJson } from './helpers/worker-context.js'

async function request(path, { env, method = 'GET', headers = {}, body } = {}) {
    const result = await invokeWorker(worker, path, {
        env,
        request: { method, headers, body },
    })
    return { ...result, body: await readJson(result.response.clone()) }
}

async function login(env, username = 'admin', password = TEST_AUTH.split(':', 2)[1]) {
    const result = await request('/auth/login', {
        env,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
    })
    assert.equal(result.response.status, 200)
    assert.match(result.body?.data?.token ?? '', /^[A-Za-z0-9_-]{40,}$/)
    return result.body.data.token
}

test('D1 Basic authentication validates users from D1 and ignores BASIC_AUTH', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database, BASIC_AUTH: 'ignored:wrong' })

    const accepted = await request('/info', { env, headers: authenticatedHeaders() })
    const rejected = await request('/info', { env, headers: authenticatedHeaders({}, 'admin:wrong') })

    assert.equal(accepted.response.status, 200)
    assert.equal(rejected.response.status, 401)
    assert.ok(database.callsMatching(/from `users`/i).length >= 2)
})

test('first-admin setup is bootstrap-token gated, stores only a salted hash, and is one-shot', async () => {
    const database = new FakeD1Database({ users: [] })
    const env = await createTestEnv({
        database,
        TEST_SKIP_D1_AUTH_SEED: true,
        TEST_SKIP_D1_APNS_SEED: true,
        BASIC_AUTH: undefined,
    })
    const payload = JSON.stringify({ username: 'Owner', password: 'a genuinely strong password' })

    const denied = await request('/auth/setup', {
        env,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bootstrap-token': 'wrong' },
        body: payload,
    })
    assert.equal(denied.response.status, 401)
    assert.equal(database.users.size, 0)

    const created = await request('/auth/setup', {
        env,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bootstrap-token': TEST_BOOTSTRAP_TOKEN },
        body: payload,
    })
    assert.equal(created.response.status, 201)
    const stored = database.users.get('owner')
    assert.equal(stored.role, 'admin')
    assert.equal(stored.password_iterations, 100000)
    assert.equal(stored.password_algorithm, 'pbkdf2-sha256+pepper-v1')
    assert.notEqual(stored.password_hash, 'a genuinely strong password')
    assert.doesNotMatch(JSON.stringify(stored), /genuinely strong password/)

    const replay = await request('/auth/setup', {
        env,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bootstrap-token': TEST_BOOTSTRAP_TOKEN },
        body: JSON.stringify({ username: 'second', password: 'another strong password' }),
    })
    assert.equal(replay.response.status, 409)
    assert.equal(database.users.size, 1)
})

test('login returns an opaque token while D1 stores only its SHA-256 hash', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database })
    const token = await login(env)

    assert.equal([...database.authSessions.values()].some((session) => session.token_hash === token), false)
    assert.equal(database.authSessions.size, 1)

    const me = await request('/auth/me', { env, headers: { authorization: `Bearer ${token}` } })
    assert.equal(me.response.status, 200)
    assert.deepEqual(me.body.data.user, { username: 'admin', role: 'admin' })

    const invalid = await request('/auth/login', {
        env,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong password here' }),
    })
    assert.equal(invalid.response.status, 401)
    assert.equal(database.authSessions.size, 1)

    const logout = await request('/auth/logout', {
        env,
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(logout.response.status, 200)
    assert.equal(database.authSessions.size, 0)
})

test('admin can add a D1 user and the new user can use Basic authentication', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database })
    const token = await login(env)

    const added = await request('/admin/users', {
        env,
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'Sender', password: 'send-only strong password', role: 'user' }),
    })
    assert.equal(added.response.status, 201)
    assert.deepEqual(added.body.data.user, { username: 'sender', role: 'user' })

    const info = await request('/info', {
        env,
        headers: authenticatedHeaders({}, 'sender:send-only strong password'),
    })
    assert.equal(info.response.status, 200)

    const senderToken = await login(env, 'sender', 'send-only strong password')
    const forbidden = await request('/admin/users', {
        env,
        method: 'POST',
        headers: { authorization: `Bearer ${senderToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'forbidden', password: 'another strong password' }),
    })
    assert.equal(forbidden.response.status, 403)
})

test('APNs credentials are AES-GCM encrypted in D1 and never returned by admin reads', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const database = new FakeD1Database()
    const env = await createTestEnv({
        database,
        TEST_SKIP_D1_APNS_SEED: true,
        APNS_PRIVATE_KEY: undefined,
        APNS_TEAM_ID: undefined,
        APNS_KEY_ID: undefined,
        APNS_TOPIC: undefined,
    })
    const token = await login(env)
    const source = await testAPNsCredentials()

    const saved = await request('/admin/apns', {
        env,
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            private_key: source.APNS_PRIVATE_KEY,
            team_id: source.APNS_TEAM_ID,
            key_id: source.APNS_KEY_ID,
            topic: source.APNS_TOPIC,
        }),
    })
    assert.equal(saved.response.status, 200)
    assert.doesNotMatch(database.apnsCredentials.ciphertext, /BEGIN|PRIVATE|TESTTEAM1/)
    assert.doesNotMatch(JSON.stringify(database.apnsCredentials), new RegExp(source.APNS_KEY_ID))

    const metadata = await request('/admin/apns', {
        env,
        headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(metadata.response.status, 200)
    assert.equal(metadata.body.data.configured, true)
    assert.equal(metadata.body.data.key_id, source.APNS_KEY_ID)
    assert.equal('private_key' in metadata.body.data, false)
    assert.equal('ciphertext' in metadata.body.data, false)

    const pushed = await request('/push', {
        env,
        method: 'POST',
        headers: authenticatedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body: 'encrypted vault' }),
    })
    assert.equal(pushed.response.status, 200)
    assert.equal(apns.requests.length, 1)
})

test('APNs vault rejects a framed but invalid PKCS8 P-256 key before writing D1', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database, TEST_SKIP_D1_APNS_SEED: true })
    const token = await login(env)

    const result = await request('/admin/apns', {
        env,
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            private_key: [
                ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
                'AQIDBA==',
                ['-----END ', 'PRIVATE KEY-----'].join(''),
            ].join('\n'),
            team_id: 'TEAM123456',
            key_id: 'KEY1234567',
            topic: 'me.fin.bark',
        }),
    })

    assert.equal(result.response.status, 400)
    assert.equal(result.body.message, 'APNs credentials are invalid')
    assert.equal(database.apnsCredentials, null)
})

test('missing or wrong APP_MASTER_KEY fails closed without contacting APNs', async (t) => {
    const apns = createAPNsStub()
    installFetchStub(t, apns.fetch)
    const database = new FakeD1Database()

    for (const key of [undefined, Buffer.alloc(32, 9).toString('base64')]) {
        const env = await createTestEnv({ database, APP_MASTER_KEY: key, SECURITY_MODE: 'compat' })
        const result = await request('/push', {
            env,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_key: TEST_DEVICE_KEY, body: 'must fail closed' }),
        })
        assert.equal(result.response.status, 503)
    }
    assert.equal(apns.requests.length, 0)
    assert.notEqual(TEST_MASTER_KEY, undefined)
})
