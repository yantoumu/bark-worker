import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import worker from '../main.js'
import kvWorker from '../main_kv.js'
import { FakeD1Database, ExplodingD1Database } from './helpers/fake-d1.js'
import { FakeKVNamespace } from './helpers/fake-kv.js'
import { TEST_DEVICE_KEY, TEST_DEVICE_TOKEN, authenticatedHeaders, createTestEnv } from './helpers/worker-harness.js'
import { createWorkerContext, invokeWorker } from './helpers/worker-context.js'

test('Fake D1 records exec/prepare/bind/run in deterministic order and mutates rows', async () => {
    const database = new FakeD1Database({ devices: [] })
    await database.exec('CREATE TABLE devices (id INTEGER)')
    await database.prepare('INSERT INTO `devices` (`key`, `token`) VALUES (?, ?)')
        .bind(TEST_DEVICE_KEY, TEST_DEVICE_TOKEN)
        .run()
    const result = await database.prepare('SELECT `token` FROM `devices` WHERE `key` = ?')
        .bind(TEST_DEVICE_KEY)
        .run()

    assert.deepEqual(result.results, [{ token: TEST_DEVICE_TOKEN }])
    assert.deepEqual(database.calls.map((call) => call.type), [
        'exec',
        'prepare',
        'bind',
        'run',
        'prepare',
        'bind',
        'run',
    ])
})

test('Fake KV implements get/put/delete/list and expirationTtl', async () => {
    const kv = new FakeKVNamespace({ clock: () => 1_000_000 })
    await kv.put('session:a', JSON.stringify({ active: true }), { expirationTtl: 10, metadata: { kind: 'session' } })
    await kv.put('other', 'value')

    assert.deepEqual(await kv.get('session:a', 'json'), { active: true })
    assert.deepEqual((await kv.list({ prefix: 'session:' })).keys.map((key) => key.name), ['session:a'])

    kv.advance(10_001)
    assert.equal(await kv.get('session:a'), null)
    await kv.delete('other')
    assert.deepEqual((await kv.list()).keys, [])
})

test('/ping and root do not touch D1 or schedule background database work', async () => {
    for (const path of ['/', '/ping']) {
        const database = new ExplodingD1Database()
        const env = await createTestEnv({ database })
        const runtime = createWorkerContext()

        const { response } = await invokeWorker(worker, path, { env, runtime })

        assert.equal(response.status, 200, path)
        assert.deepEqual(database.calls, [], path)
        assert.equal(runtime.pendingCount, 0, path)
    }
})

test('HTTP requests never run expired-session cleanup', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database })

    await invokeWorker(worker, '/ping', { env })

    assert.equal(database.callsMatching(/delete from `sessions`/i).length, 0)
})

test('AutoMigrate DDL runs at most once per D1 binding', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database, ALLOW_QUERY_NUMS: 'false' })

    await invokeWorker(worker, '/info', {
        env,
        request: { headers: authenticatedHeaders() },
    })
    await invokeWorker(worker, '/info', {
        env,
        request: { headers: authenticatedHeaders() },
    })

    const ddlCalls = database.callsMatching(/create (?:table|index)/i)
    assert.ok(ddlCalls.length > 0, 'D1-dependent route should ensure the schema')
    const counts = new Map()
    for (const call of ddlCalls) {
        counts.set(call.query, [...(counts.get(call.query) ?? []), call])
    }
    for (const [query, calls] of counts) {
        assert.equal(calls.length, 1, `schema statement repeated: ${query}`)
    }
})

test('AutoMigrate keeps the five-column sessions schema additive and remains compatible with migrations 001-004', async (t) => {
    const now = Math.floor(Date.now() / 1000)
    const existingSession = {
        id: 'legacy-session-id',
        device_key: null,
        initialized: 1,
        created_at: now,
        last_seen: now,
    }
    const database = new FakeD1Database({
        sessions: [[existingSession.id, existingSession]],
    })
    const env = await createTestEnv({ database })

    const { response } = await invokeWorker(worker, '/info', {
        env,
        request: { headers: authenticatedHeaders() },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(database.sessions.get(existingSession.id), existingSession)
    assert.equal(database.callsMatching(/\b(?:pragma|alter\s+table)\b/i).length, 0)

    const autoMigrate = database.calls
        .filter((call) => call.type === 'exec')
        .map((call) => call.query)
    assert.ok(autoMigrate.some((query) => /create table if not exists `sessions`/i.test(query)))
    assert.ok(autoMigrate.every((query) => !/protocol_version/i.test(query)))

    const sqlite = new DatabaseSync(':memory:')
    t.after(() => sqlite.close())
    for (const statement of autoMigrate) sqlite.exec(statement)
    for (const filename of [
        '001_create_authorization.sql',
        '002_create_devices.sql',
        '003_create_session.sql',
        '004_add_session_indexes.sql',
    ]) {
        sqlite.exec(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'))
    }

    const sessionColumns = sqlite.prepare('PRAGMA table_info(`sessions`)').all().map(({ name }) => name)
    assert.deepEqual(sessionColumns, ['id', 'device_key', 'initialized', 'created_at', 'last_seen'])
})

test('scheduled handler performs session cleanup as two indexable DELETE statements', async () => {
    assert.equal(typeof worker.scheduled, 'function', 'module worker must export scheduled()')
    const now = Math.floor(Date.now() / 1000)
    const database = new FakeD1Database({
        sessions: [
            ['idle', { id: 'idle', device_key: null, initialized: 1, created_at: now, last_seen: now - 4000 }],
            ['old', { id: 'old', device_key: null, initialized: 1, created_at: now - 90000, last_seen: now }],
        ],
    })
    const env = await createTestEnv({ database })
    const runtime = createWorkerContext()

    await worker.scheduled({ scheduledTime: Date.now(), cron: '0 * * * *' }, env, runtime.context)
    await runtime.settle()

    const deletes = database.callsMatching(/delete from `sessions`/i)
    assert.equal(deletes.length, 2)
    assert.ok(deletes.every((call) => !/\bor\b/i.test(call.query)))
    assert.ok(deletes.some((call) => /last_seen/i.test(call.query)))
    assert.ok(deletes.some((call) => /created_at/i.test(call.query)))
})

test('D1 and KV production entrypoints contain no embedded private-key material', async () => {
    for (const filename of ['main.js', 'main_kv.js']) {
        const source = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8')
        assert.doesNotMatch(source, /BEGIN\s+PRIVATE\s+KEY/)
        assert.doesNotMatch(source, /MIGTAgEAMBMGByqGSM49/)
    }
})

test('KV root and ping are independent of storage availability', async () => {
    const database = new Proxy({}, {
        get() {
            throw new Error('KV must not be touched')
        },
    })
    const env = await createTestEnv({ database, SECURITY_MODE: 'compat', BASIC_AUTH: undefined })

    const root = await invokeWorker(kvWorker, '/', { env })
    const ping = await invokeWorker(kvWorker, '/ping', { env })

    assert.equal(root.response.status, 200)
    assert.equal(ping.response.status, 200)
})
