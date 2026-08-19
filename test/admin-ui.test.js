import assert from 'node:assert/strict'
import test from 'node:test'

import worker from '../main.js'
import { FakeD1Database } from './helpers/fake-d1.js'
import { TEST_AUTH, createTestEnv } from './helpers/worker-harness.js'
import { invokeWorker, readJson } from './helpers/worker-context.js'

const ORIGIN = 'https://worker.example'

async function request(path, { env, method = 'GET', headers = {}, body, origin = ORIGIN } = {}) {
    return invokeWorker(worker, path, {
        env,
        origin,
        request: { method, headers, body },
    })
}

async function login(env) {
    const response = (await request('/auth/login', {
        env,
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
            username: TEST_AUTH.split(':', 1)[0],
            password: TEST_AUTH.slice(TEST_AUTH.indexOf(':') + 1),
        }),
    })).response
    assert.equal(response.status, 200)
    const body = await readJson(response.clone())
    const setCookie = response.headers.get('set-cookie') ?? ''
    return { body, setCookie, cookie: setCookie.split(';', 1)[0] }
}

test('browser root enters the admin UI while API root compatibility remains intact', async () => {
    const env = await createTestEnv()
    const browser = await request('/', { env, headers: { accept: 'text/html,application/xhtml+xml' } })
    const api = await request('/', { env, headers: { accept: '*/*' } })
    const mounted = await request('/bark', {
        env: await createTestEnv({ ROOT_PATH: '/bark/' }),
        headers: { accept: 'text/html' },
    })

    assert.equal(browser.response.status, 302)
    assert.equal(browser.response.headers.get('location'), `${ORIGIN}/admin`)
    assert.equal(api.response.status, 200)
    assert.equal(await api.response.text(), 'ok')
    assert.equal(mounted.response.status, 302)
    assert.equal(mounted.response.headers.get('location'), `${ORIGIN}/bark/admin`)
})

test('admin UI ships a complete accessible login and management surface with strict headers', async () => {
    const env = await createTestEnv()
    const page = await request('/admin', { env })
    const stylesheet = await request('/admin/styles.css', { env })
    const script = await request('/admin/app.js', { env })
    const html = await page.response.text()
    const css = await stylesheet.response.text()
    const javascript = await script.response.text()

    assert.equal(page.response.status, 200)
    assert.match(page.response.headers.get('content-type') ?? '', /^text\/html/)
    assert.equal(page.response.headers.get('cache-control'), 'private, no-store, no-transform')
    assert.match(page.response.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    assert.match(page.response.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.equal(page.response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains')
    assert.equal(page.response.headers.get('x-frame-options'), 'DENY')
    assert.equal(page.response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    assert.match(html, /<form[^>]+id="login-form"/)
    assert.match(html, /<form[^>]+id="user-form"/)
    assert.match(html, /<form[^>]+id="apns-form"/)
    assert.match(html, /aria-live="polite"/)
    assert.match(html, /Bark Worker 管理台/)
    assert.match(html, /name="robots" content="noindex,nofollow,noarchive"/)
    assert.equal((html.match(/pattern="\[A-Za-z0-9]\(\?:\[A-Za-z0-9\._]\|-\)\{1,62}\[A-Za-z0-9]"/g) ?? []).length, 2)
    assert.doesNotMatch(html, /<script(?![^>]+src=)/)

    assert.equal(stylesheet.response.status, 200)
    assert.match(stylesheet.response.headers.get('content-type') ?? '', /^text\/css/)
    assert.match(css, /prefers-reduced-motion/)
    assert.match(css, /@media \(max-width:/)

    assert.equal(script.response.status, 200)
    assert.match(script.response.headers.get('content-type') ?? '', /^text\/javascript/)
    assert.match(javascript, /credentials:\s*'same-origin'/)
    assert.doesNotMatch(javascript, /localStorage|sessionStorage/)
})

test('login creates an HttpOnly same-site cookie and cookie auth is admin-only', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database })
    const session = await login(env)

    assert.match(session.body?.data?.token ?? '', /^[A-Za-z0-9_-]{40,}$/)
    assert.match(session.setCookie, /^__Host-bark_session=[A-Za-z0-9_-]{40,128};/)
    assert.match(session.setCookie, /Path=\//)
    assert.match(session.setCookie, /Max-Age=86400/)
    assert.match(session.setCookie, /HttpOnly/)
    assert.match(session.setCookie, /Secure/)
    assert.match(session.setCookie, /SameSite=Strict/)

    const me = await request('/auth/me', { env, headers: { cookie: session.cookie } })
    assert.equal(me.response.status, 200)
    assert.deepEqual((await readJson(me.response)).data.user, { username: 'admin', role: 'admin' })

    const apns = await request('/admin/apns', { env, headers: { cookie: session.cookie } })
    assert.equal(apns.response.status, 200)

    const created = await request('/admin/users', {
        env,
        method: 'POST',
        headers: { cookie: session.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
            username: 'web-user',
            password: 'web user strong password',
            role: 'user',
        }),
    })
    assert.equal(created.response.status, 201)
    assert.equal(database.users.has('web-user'), true)

    const info = await request('/info', { env, headers: { cookie: session.cookie } })
    assert.equal(info.response.status, 401)
})

test('cookie mutations require same origin and logout revokes the browser session', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database })
    const session = await login(env)

    const crossed = await request('/admin/users', {
        env,
        method: 'POST',
        headers: {
            cookie: session.cookie,
            origin: 'https://attacker.example',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            username: 'attacker',
            password: 'attacker strong password',
            role: 'admin',
        }),
    })
    assert.equal(crossed.response.status, 403)
    assert.equal(database.users.has('attacker'), false)

    const logout = await request('/auth/logout', {
        env,
        method: 'POST',
        headers: { cookie: session.cookie, origin: ORIGIN },
    })
    assert.equal(logout.response.status, 200)
    assert.match(logout.response.headers.get('set-cookie') ?? '', /^__Host-bark_session=;/)
    assert.match(logout.response.headers.get('set-cookie') ?? '', /Max-Age=0/)

    const expired = await request('/auth/me', { env, headers: { cookie: session.cookie } })
    assert.equal(expired.response.status, 401)
})

test('cross-origin browser login is rejected without creating a session', async () => {
    const database = new FakeD1Database()
    const env = await createTestEnv({ database })
    const response = (await request('/auth/login', {
        env,
        method: 'POST',
        headers: {
            origin: 'https://attacker.example',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            username: 'admin',
            password: TEST_AUTH.slice(TEST_AUTH.indexOf(':') + 1),
        }),
    })).response

    assert.equal(response.status, 403)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(database.authSessions.size, 0)
})

test('browser auth endpoints avoid native Basic prompts while push APIs keep their challenge', async () => {
    const env = await createTestEnv()
    const me = await request('/auth/me', { env })
    const badLogin = await request('/auth/login', {
        env,
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong password here' }),
    })
    const push = await request('/push', {
        env,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: 'test-device-key', body: 'test' }),
    })

    assert.equal(me.response.status, 401)
    assert.equal(me.response.headers.has('www-authenticate'), false)
    assert.equal(badLogin.response.status, 401)
    assert.equal(badLogin.response.headers.has('www-authenticate'), false)
    assert.equal(push.response.status, 401)
    assert.equal(push.response.headers.get('www-authenticate'), 'Basic realm="Bark"')
})

test('browser session probe returns a quiet unauthenticated state and recognizes its cookie', async () => {
    const env = await createTestEnv()
    const anonymous = await request('/auth/session', { env })
    const anonymousBody = await readJson(anonymous.response.clone())
    const session = await login(env)
    const authenticated = await request('/auth/session', { env, headers: { cookie: session.cookie } })
    const authenticatedBody = await readJson(authenticated.response.clone())

    assert.equal(anonymous.response.status, 200)
    assert.deepEqual(anonymousBody.data, { authenticated: false })
    assert.equal(authenticated.response.status, 200)
    assert.deepEqual(authenticatedBody.data, {
        authenticated: true,
        user: { username: 'admin', role: 'admin' },
    })
})
