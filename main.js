const VERSION = 'v2.4.0'
const BUILD = '2026-08-18'
const SUPPORTED_MCP_PROTOCOLS = new Set(['2025-03-26', '2025-06-18'])
const encoder = new TextEncoder()
const schemaPromises = new WeakMap()

let apnsTokenCache = {
    credentials: null,
    token: null,
    expiresAt: 0,
    promise: null,
}
let compatWarningEmitted = false

class AppError extends Error {
    constructor(status, message, options = {}) {
        super(message)
        this.name = 'AppError'
        this.status = status
        this.code = options.code ?? status
        this.headers = options.headers ?? {}
        this.retryable = options.retryable
    }
}

export default {
    async fetch(request, env, ctx) {
        const requestId = requestID(request)
        let route = 'unknown'

        try {
            const rootPath = parseRootPath(env?.ROOT_PATH)
            const pathname = mountedPath(new URL(request.url).pathname, rootPath)
            if (pathname === null) {
                return attachRequestID(jsonError(404, 'not found'), requestId)
            }

            route = safeRouteName(pathname)
            const response = await handleRequest(request, env ?? {}, ctx, pathname, requestId)
            return attachRequestID(response, requestId)
        } catch (error) {
            if (!(error instanceof AppError)) {
                console.error(JSON.stringify({ event: 'request_failed', request_id: requestId, route }))
            }
            return attachRequestID(errorResponse(error), requestId)
        }
    },

    async scheduled(controller, env, ctx) {
        const task = runScheduled(env ?? {}, controller)
        ctx.waitUntil(task)
        return task
    },
}

async function handleRequest(request, env, ctx, pathname, requestId) {
    if (pathname === '/') {
        if (request.method !== 'GET') return methodNotAllowed(['GET'])
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    }

    if (pathname === '/ping') {
        if (request.method !== 'GET') return methodNotAllowed(['GET'])
        return jsonResponse({ code: 200, message: 'pong', timestamp: timestamp() })
    }

    if (pathname === '/healthz') {
        if (request.method !== 'GET') return methodNotAllowed(['GET'])
        return healthz(env)
    }

    const config = parseConfig(env)

    if (pathname === '/register') {
        return handleRegister(request, env, config)
    }

    if (pathname === '/info') {
        if (request.method !== 'GET') return methodNotAllowed(['GET'])
        const auth = authorize(request, config, { required: true })
        if (auth.response) return auth.response
        const db = new Database(env.database)
        await db.ensureSchema()
        const body = {
            version: VERSION,
            build: BUILD,
            arch: 'js',
        }
        if (config.allowQueryNums) body.devices = await db.countAll()
        return jsonResponse(body)
    }

    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
        const parts = splitPath(pathname)
        if (parts.length > 2) return jsonError(404, 'not found')
        const deviceKey = parts[1] === undefined ? null : decodePathSegment(parts[1])
        return handleMCP(request, env, config, deviceKey, requestId)
    }

    if (pathname === '/push') {
        if (request.method !== 'POST') return methodNotAllowed(['POST'])
        return handlePush(request, env, config, null, requestId)
    }

    const parts = splitPath(pathname)
    if (parts.length < 1 || parts.length > 4) return jsonError(404, 'not found')
    if (!['GET', 'POST'].includes(request.method)) return methodNotAllowed(['GET', 'POST'])
    const decoded = parts.map(decodePathSegment)
    return handlePush(request, env, config, decoded, requestId)
}

async function healthz(env) {
    try {
        parseConfig(env)
    } catch (error) {
        return new Response('configuration unavailable', {
            status: 503,
            headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
        })
    }

    try {
        const db = new Database(env.database)
        await db.ensureSchema()
        await db.ready()
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    } catch (error) {
        return new Response('service unavailable', {
            status: 503,
            headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
        })
    }
}

async function handleRegister(request, env, config) {
    const legacyGET = request.method === 'GET'
    if (legacyGET && !config.allowLegacyGetRegister) return methodNotAllowed(['POST'])
    if (!legacyGET && request.method !== 'POST') {
        return methodNotAllowed(config.allowLegacyGetRegister ? ['GET', 'POST'] : ['POST'])
    }

    const auth = authorize(request, config, { required: config.securityMode === 'strict' })
    if (auth.response) return decorateLegacyGET(auth.response, legacyGET, config)

    const subject = auth.authenticated
        ? `auth:${await fingerprint(config.basicAuth)}`
        : `ip:${await fingerprint(request.headers.get('cf-connecting-ip') || 'unknown')}`
    const limited = await enforceRateLimit(env.REGISTER_RATE_LIMITER, subject)
    if (limited) return decorateLegacyGET(limited, legacyGET, config)

    let input
    if (legacyGET) {
        input = queryObject(new URL(request.url).searchParams)
    } else {
        input = await parseStructuredBody(request, config, ['application/json', 'application/x-www-form-urlencoded'])
    }

    const tokenValue = input.device_token ?? input.devicetoken
    const token = validateDeviceToken(tokenValue)
    let key = input.device_key ?? input.key
    if (key === undefined || key === null || key === '') {
        if (!config.allowNewDevice) throw new AppError(403, 'device registration disabled')
        key = await newShortUUID()
    }
    validateDeviceKey(key)

    const db = new Database(env.database)
    await db.ensureSchema()
    const existing = await db.deviceByKey(key)

    if (existing.token !== undefined) {
        if (existing.matchedKey !== key) {
            return decorateLegacyGET(jsonError(409, 'device key is already registered'), legacyGET, config)
        }
        if (existing.token === token) {
            return decorateLegacyGET(registerSuccess(key, token), legacyGET, config)
        }
        const insecureCompatRebind = config.securityMode === 'compat'
            && config.allowInsecureDeviceRebind
            && !auth.authenticated
        if (!auth.authenticated && !insecureCompatRebind) {
            return decorateLegacyGET(jsonError(409, 'device key is already registered'), legacyGET, config)
        }
        if (insecureCompatRebind) {
            console.warn(JSON.stringify({ event: 'insecure_device_rebind', mode: 'compat' }))
        }
        await db.saveDevice(existing.matchedKey ?? key, token)
    } else {
        if (!config.allowNewDevice) throw new AppError(403, 'device registration disabled')
        await db.saveDevice(key, token)
    }

    return decorateLegacyGET(registerSuccess(key, token), legacyGET, config)
}

function registerSuccess(key, token) {
    return jsonResponse({
        code: 200,
        message: 'success',
        timestamp: timestamp(),
        data: { key, device_key: key, device_token: token },
    })
}

function decorateLegacyGET(response, legacyGET, config) {
    if (!legacyGET) return response
    const headers = new Headers(response.headers)
    headers.set('deprecation', 'true')
    headers.set('sunset', config.legacyGetRegisterSunset)
    headers.set('cache-control', 'no-store')
    headers.set('referrer-policy', 'no-referrer')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function handlePush(request, env, config, pathParts, requestId) {
    const auth = authorize(request, config, { required: config.securityMode === 'strict' })
    if (auth.response) return auth.response

    const parameters = await parsePushParameters(request, config, pathParts)
    if (Object.prototype.hasOwnProperty.call(parameters, 'device_keys')) {
        const deviceKeys = parseDeviceKeys(parameters.device_keys, config.maxBatchSize)
        const subjectValue = auth.authenticated
            ? config.basicAuth
            : request.headers.get('cf-connecting-ip') || 'anonymous'
        const limited = await enforceRateLimit(env.BATCH_RATE_LIMITER, `batch:${await fingerprint(subjectValue)}`)
        if (limited) return limited

        const base = { ...parameters }
        delete base.device_keys
        delete base.device_key
        const validated = validatePushParameters(base, { requireDeviceKey: false })
        const prepared = prepareAPNsPayload(validated, config)
        const db = new Database(env.database)
        await db.ensureSchema()

        const results = await mapWithConcurrency(deviceKeys, config.batchConcurrency, async (deviceKey) => {
            try {
                const response = await pushPrepared(db, config, prepared, deviceKey, requestId)
                const body = await safeJSON(response)
                return {
                    code: response.status,
                    message: body?.message ?? (response.ok ? 'success' : 'push failed'),
                    device_key: deviceKey,
                }
            } catch (error) {
                return {
                    code: error instanceof AppError ? error.status : 500,
                    message: error instanceof AppError ? error.message : 'internal server error',
                    device_key: deviceKey,
                }
            }
        })
        const successCount = results.filter((item) => item.code === 200).length
        const failedCount = results.length - successCount
        return jsonResponse({
            code: 200,
            message: 'success',
            data: results,
            success_count: successCount,
            failed_count: failedCount,
            partial_failure: failedCount > 0,
            timestamp: timestamp(),
        })
    }

    const validated = validatePushParameters(parameters, { requireDeviceKey: true })
    const limited = await enforceRateLimit(
        env.PUSH_RATE_LIMITER,
        `device:${await fingerprint(validated.device_key)}`,
    )
    if (limited) return limited
    const prepared = prepareAPNsPayload(validated, config)
    const db = new Database(env.database)
    await db.ensureSchema()
    return pushPrepared(db, config, prepared, validated.device_key, requestId)
}

async function parsePushParameters(request, config, pathParts) {
    const result = queryObject(new URL(request.url).searchParams)
    if (request.body !== null) {
        Object.assign(result, await parseStructuredBody(
            request,
            config,
            ['application/json', 'application/x-www-form-urlencoded'],
        ))
    }

    if (pathParts !== null) {
        result.device_key = pathParts[0]
        if (pathParts.length === 2) result.body = pathParts[1]
        if (pathParts.length === 3) {
            result.title = pathParts[1]
            result.body = pathParts[2]
        }
        if (pathParts.length === 4) {
            result.title = pathParts[1]
            result.subtitle = pathParts[2]
            result.body = pathParts[3]
        }
    }
    return normalizeKeys(result)
}

function parseDeviceKeys(value, maxBatchSize) {
    let values
    if (Array.isArray(value)) {
        values = value
    } else if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed.startsWith('[')) {
            try {
                values = JSON.parse(trimmed)
            } catch (error) {
                throw new AppError(400, 'device_keys must be an array or string')
            }
            if (!Array.isArray(values)) throw new AppError(400, 'device_keys must be an array or string')
        } else {
            values = trimmed.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        }
    } else {
        throw new AppError(400, 'device_keys must be an array or string')
    }

    if (values.length === 0) throw new AppError(400, 'invalid device_keys')
    const unique = []
    const seen = new Set()
    for (const key of values) {
        try {
            validateDeviceKey(key)
        } catch (error) {
            throw new AppError(400, 'invalid device_keys')
        }
        if (!seen.has(key)) {
            seen.add(key)
            unique.push(key)
        }
    }
    if (values.length > maxBatchSize) throw new AppError(413, 'batch is too large')
    return unique
}

function validatePushParameters(input, options = {}) {
    const value = normalizeKeys(input)
    const output = {}
    if (options.requireDeviceKey) {
        validateDeviceKey(value.device_key)
        output.device_key = value.device_key
    }

    output.title = optionalString(value.title, 'title', 512)
    output.subtitle = optionalString(value.subtitle, 'subtitle', 512)
    output.body = optionalString(value.body, 'body', 4096, 413)
    output.markdown = optionalString(value.markdown, 'markdown', 4096, 413)
    output.ciphertext = optionalString(value.ciphertext, 'ciphertext', 4096, 413)
    output.copy = optionalString(value.copy, 'copy', 4096)
    output.iv = optionalString(value.iv, 'iv', 4096)
    output.sound = optionalString(value.sound, 'sound', 128)
    output.group = optionalString(value.group, 'group', 128)
    output.action = optionalString(value.action, 'action', 128)
    output.id = optionalString(value.id, 'id', 128)
    output.call = optionalScalarString(value.call, 'call', 128)
    output.isarchive = optionalScalarString(value.isarchive, 'isarchive', 128)
    output.autocopy = optionalScalarString(value.autocopy, 'autocopy', 128)
    output.delete = optionalFlag(value.delete, 'delete')
    output.level = optionalString(value.level, 'level', 128)
    if (output.level !== undefined && !['passive', 'active', 'timeSensitive', 'critical'].includes(output.level)) {
        throw new AppError(400, 'level is invalid')
    }
    output.badge = optionalInteger(value.badge, 'badge')
    output.ttl = optionalInteger(value.ttl, 'ttl')
    output.volume = optionalNumber(value.volume, 'volume', 0, 10)
    output.url = optionalURL(value.url, 'url')
    output.icon = optionalURL(value.icon, 'icon')
    output.image = optionalURL(value.image, 'image')
    return output
}

function prepareAPNsPayload(parameters, config) {
    let sound = parameters.sound
    if (sound && !sound.endsWith('.caf')) sound += '.caf'
    if (!sound) sound = '1107'
    const isDelete = parameters.delete === true

    const payload = {
        aps: isDelete ? {
            'content-available': 1,
            'mutable-content': 1,
        } : {
            alert: {
                title: parameters.title,
                subtitle: parameters.subtitle,
                body: (!parameters.title && !parameters.subtitle && !parameters.body) ? 'Empty Message' : parameters.body,
            },
            sound,
            'thread-id': parameters.group,
            category: 'myNotificationCategory',
            'mutable-content': 1,
        },
        group: parameters.group,
        call: parameters.call,
        isarchive: parameters.isarchive,
        icon: parameters.icon,
        ciphertext: parameters.ciphertext,
        level: parameters.level,
        volume: parameters.volume,
        url: parameters.url,
        copy: parameters.copy,
        badge: parameters.badge === undefined ? undefined : String(parameters.badge),
        autocopy: parameters.autocopy,
        action: parameters.action,
        iv: parameters.iv,
        image: parameters.image,
        id: parameters.id,
        delete: parameters.delete === undefined ? undefined : (parameters.delete ? '1' : '0'),
        markdown: parameters.markdown,
        ttl: parameters.ttl,
    }
    const body = JSON.stringify(payload)
    if (encoder.encode(body).byteLength > 4096) throw new AppError(413, 'APNs payload is too large')
    return {
        body,
        headers: {
            'apns-collapse-id': parameters.id,
            'apns-push-type': isDelete ? 'background' : 'alert',
            'apns-priority': isDelete ? '5' : '10',
        },
    }
}

async function pushPrepared(db, config, prepared, deviceKey, requestId) {
    validateDeviceKey(deviceKey)
    const device = await db.deviceByKey(deviceKey)
    if (!device.token) return jsonError(400, 'invalid device key')

    let deviceToken
    try {
        deviceToken = validateDeviceToken(device.token)
    } catch (error) {
        return jsonError(400, 'invalid device key')
    }

    const apns = new APNs(config)
    const result = await apns.push(deviceToken, prepared.headers, prepared.body)
    if (result.ok) {
        return jsonResponse({ code: 200, message: 'success', timestamp: timestamp() })
    }

    if (result.permanentTokenFailure) {
        try {
            await db.saveDevice(device.matchedKey ?? deviceKey, '')
        } catch (error) {
            console.error(JSON.stringify({ event: 'device_token_invalidation_failed', request_id: requestId }))
        }
    }
    console.warn(JSON.stringify({
        event: 'apns_failure',
        request_id: requestId,
        status: result.upstreamStatus,
        reason: safeAPNsLogReason(result.reason, result.upstreamStatus),
        latency_ms: result.latency,
        retryable: result.retryable,
    }))
    const headers = {}
    if (result.retryAfter) headers['retry-after'] = result.retryAfter
    return jsonResponse({
        code: result.status,
        message: `push failed: ${result.reason}`,
        retryable: result.retryable,
        timestamp: timestamp(),
    }, result.status, headers)
}

class APNs {
    constructor(config) {
        this.config = config
    }

    async push(deviceToken, headers, body) {
        const started = Date.now()
        const authToken = await getAPNsProviderToken(this.config)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.config.apnsTimeoutMs)
        try {
            const response = await fetch(`https://api.push.apple.com/3/device/${deviceToken}`, {
                method: 'POST',
                signal: controller.signal,
                headers: cleanObject({
                    'apns-topic': this.config.apnsTopic,
                    'apns-collapse-id': headers['apns-collapse-id'],
                    'apns-expiration': String(timestamp() + 86400),
                    'apns-push-type': headers['apns-push-type'] || 'alert',
                    'apns-priority': headers['apns-priority'],
                    authorization: `bearer ${authToken}`,
                    'content-type': 'application/json',
                }),
                body,
            })

            if (response.status === 200) {
                return { ok: true, status: 200, upstreamStatus: 200, latency: Date.now() - started }
            }

            let text = ''
            try {
                text = await response.text()
            } catch (error) {
                if (error?.name === 'AbortError' || controller.signal.aborted) throw error
            }
            if (controller.signal.aborted) {
                const error = new Error('APNs response body timed out')
                error.name = 'AbortError'
                throw error
            }

            let reason
            try {
                const parsed = text ? JSON.parse(text) : null
                if (typeof parsed?.reason === 'string' && parsed.reason.trim()) reason = parsed.reason.trim()
            } catch (error) {
                reason = undefined
            }
            reason ??= `APNs error (${response.status})`
            const retryable = response.status === 429 || response.status >= 500
            const status = response.status >= 500 ? 503 : response.status
            return {
                ok: false,
                status,
                upstreamStatus: response.status,
                reason,
                retryable,
                retryAfter: response.status === 429 ? response.headers.get('retry-after') : null,
                permanentTokenFailure: response.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered',
                latency: Date.now() - started,
            }
        } catch (error) {
            const timedOut = error?.name === 'AbortError' || controller.signal.aborted
            return {
                ok: false,
                status: timedOut ? 504 : 502,
                upstreamStatus: null,
                reason: timedOut ? 'APNs request timed out' : 'APNs network error',
                retryable: true,
                latency: Date.now() - started,
            }
        } finally {
            clearTimeout(timer)
        }
    }
}

async function getAPNsProviderToken(config) {
    const credentials = `${config.apnsTeamID}\u0000${config.apnsKeyID}\u0000${config.apnsPrivateKey}`
    const now = Date.now()
    if (apnsTokenCache.credentials === credentials && apnsTokenCache.token && apnsTokenCache.expiresAt > now) {
        return apnsTokenCache.token
    }
    if (apnsTokenCache.credentials === credentials && apnsTokenCache.promise) {
        return apnsTokenCache.promise
    }

    const promise = generateAPNsProviderToken(config)
    apnsTokenCache = { credentials, token: null, expiresAt: 0, promise }
    try {
        const token = await promise
        if (apnsTokenCache.promise === promise) {
            apnsTokenCache.token = token
            apnsTokenCache.expiresAt = now + 50 * 60 * 1000
            apnsTokenCache.promise = null
        }
        return token
    } catch (error) {
        if (apnsTokenCache.promise === promise) {
            apnsTokenCache = { credentials: null, token: null, expiresAt: 0, promise: null }
        }
        throw new AppError(503, 'APNs configuration unavailable')
    }
}

async function generateAPNsProviderToken(config) {
    const encodedKey = config.apnsPrivateKey
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('-----'))
        .join('')
    const keyBytes = base64Decode(encodedKey)
    const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        keyBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
    )
    const header = base64URL(JSON.stringify({ alg: 'ES256', kid: config.apnsKeyID }))
    const claims = base64URL(JSON.stringify({ iss: config.apnsTeamID, iat: timestamp() }))
    const unsigned = `${header}.${claims}`
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        encoder.encode(unsigned),
    )
    return `${unsigned}.${base64URL(new Uint8Array(signature))}`
}

class Database {
    constructor(binding) {
        if (!binding || (typeof binding !== 'object' && typeof binding !== 'function')) {
            throw new AppError(503, 'service unavailable')
        }
        this.db = binding
    }

    async ensureSchema() {
        let promise = schemaPromises.get(this.db)
        if (!promise) {
            promise = this.migrate()
            schemaPromises.set(this.db, promise)
            promise.catch(() => {
                if (schemaPromises.get(this.db) === promise) schemaPromises.delete(this.db)
            })
        }
        try {
            await promise
        } catch (error) {
            throw new AppError(503, 'service unavailable')
        }
    }

    async migrate() {
        await this.db.exec('CREATE TABLE IF NOT EXISTS `devices` (`id` INTEGER PRIMARY KEY, `key` VARCHAR(255) NOT NULL, `token` VARCHAR(255) NOT NULL, UNIQUE (`key`))')
        await this.db.exec('CREATE TABLE IF NOT EXISTS `sessions` (`id` VARCHAR(64) PRIMARY KEY, `device_key` VARCHAR(255), `initialized` INTEGER DEFAULT 0, `created_at` INTEGER NOT NULL, `last_seen` INTEGER NOT NULL)')
        await this.db.exec('CREATE INDEX IF NOT EXISTS `idx_sessions_last_seen` ON `sessions` (`last_seen`)')
        await this.db.exec('CREATE INDEX IF NOT EXISTS `idx_sessions_created_at` ON `sessions` (`created_at`)')
    }

    async ready() {
        await this.db.prepare('SELECT 1').run()
    }

    async countAll() {
        const result = await this.db.prepare('SELECT COUNT(*) as rowCount FROM `devices`').run()
        return result.results?.[0]?.rowCount ?? 0
    }

    async deviceByKey(key) {
        const exact = await this.lookupDevice(key)
        if (exact !== undefined) return { token: exact, matchedKey: key }
        const legacy = key.replace(/[^a-zA-Z0-9]/g, '')
        if (legacy && legacy !== key) {
            const fallback = await this.lookupDevice(legacy)
            if (fallback !== undefined) {
                console.warn(JSON.stringify({ event: 'legacy_device_key_fallback' }))
                return { token: fallback, matchedKey: legacy }
            }
        }
        return { token: undefined, matchedKey: null }
    }

    async lookupDevice(key) {
        const result = await this.db.prepare('SELECT `token` FROM `devices` WHERE `key` = ?').bind(key).run()
        return result.results?.[0]?.token
    }

    async saveDevice(key, token) {
        return this.db.prepare('INSERT INTO `devices` (`key`, `token`) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET `token` = EXCLUDED.`token`')
            .bind(key, token)
            .run()
    }

    async sessionByID(sessionID) {
        const now = timestamp()
        const result = await this.db.prepare('SELECT `id`, `device_key`, `initialized`, `created_at`, `last_seen` FROM `sessions` WHERE `id` = ? AND `last_seen` > ? AND `created_at` > ?')
            .bind(sessionID, now - 3600, now - 86400)
            .run()
        const session = result.results?.[0] ?? null
        if (!session) return null
        return { ...session, protocol_version: protocolVersionFromSessionID(session.id) }
    }

    async saveSession(sessionID, deviceKey, initialized) {
        const now = timestamp()
        return this.db.prepare('INSERT INTO `sessions` (`id`, `device_key`, `initialized`, `created_at`, `last_seen`) VALUES (?, ?, ?, ?, ?) ON CONFLICT(`id`) DO UPDATE SET `initialized` = EXCLUDED.`initialized`, `last_seen` = EXCLUDED.`last_seen`')
            .bind(sessionID, deviceKey, initialized ? 1 : 0, now, now)
            .run()
    }

    async deleteSession(sessionID) {
        return this.db.prepare('DELETE FROM `sessions` WHERE `id` = ?').bind(sessionID).run()
    }

    async cleanupSessions() {
        const now = timestamp()
        const idle = await this.db.prepare('DELETE FROM `sessions` WHERE `last_seen` < ?').bind(now - 3600).run()
        const old = await this.db.prepare('DELETE FROM `sessions` WHERE `created_at` < ?').bind(now - 86400).run()
        return Number(idle.meta?.changes ?? 0) + Number(old.meta?.changes ?? 0)
    }
}

async function runScheduled(env, controller) {
    const started = Date.now()
    try {
        const db = new Database(env.database)
        await db.ensureSchema()
        const deleted = await db.cleanupSessions()
        console.log(JSON.stringify({ event: 'session_cleanup', deleted, duration_ms: Date.now() - started }))
    } catch (error) {
        console.error(JSON.stringify({ event: 'session_cleanup_failed', duration_ms: Date.now() - started }))
        throw error
    }
}

async function handleMCP(request, env, config, deviceKey, requestId) {
    const auth = authorize(request, config, { required: true })
    if (auth.response) return auth.response
    if (!originAllowed(request.headers.get('origin'), config.mcpAllowedOrigins)) {
        return jsonError(403, 'origin is not allowed')
    }
    if (deviceKey !== null) validateDeviceKey(deviceKey)
    if (!['POST', 'DELETE'].includes(request.method)) return methodNotAllowed(['POST', 'DELETE'])

    const sessionHeader = request.headers.get('mcp-session-id')

    if (request.method === 'DELETE') {
        if (!sessionHeader) return jsonError(400, 'missing session ID')
        const db = new Database(env.database)
        await db.ensureSchema()
        const session = await db.sessionByID(sessionHeader)
        if (!session) return jsonError(404, 'session not found')
        if (!sessionOwnedByPath(session, deviceKey)) return jsonError(403, 'session not found')
        const protocolError = validateMCPProtocolHeader(request, session)
        if (protocolError) return protocolError
        const headers = session.protocol_version === '2025-06-18'
            ? { 'mcp-protocol-version': session.protocol_version }
            : {}
        const limited = await enforceRateLimit(
            env.MCP_RATE_LIMITER,
            `mcp:session:${await fingerprint(session.id)}`,
        )
        if (limited) return mergeResponseHeaders(limited, headers)
        await db.deleteSession(sessionHeader)
        return new Response(null, { status: 200, headers })
    }

    let body
    try {
        body = await parseStructuredBody(request, config, ['application/json'])
    } catch (error) {
        if (error instanceof AppError && error.status === 400) return rpcError(null, -32700, 'Parse error')
        throw error
    }
    const { jsonrpc, id, method, params } = body
    const hasID = Object.prototype.hasOwnProperty.call(body, 'id')
    if (jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id ?? null, -32600, 'Invalid Request')

    if (method === 'initialize') {
        const limited = await enforceRateLimit(
            env.MCP_RATE_LIMITER,
            `mcp:auth:${await fingerprint(config.basicAuth)}`,
        )
        if (limited) return limited
        if (sessionHeader) return jsonError(400, 'initialize must not include a session ID')
        if (!hasID) return new Response(null, { status: 202 })
        const protocolVersion = params?.protocolVersion
        if (!SUPPORTED_MCP_PROTOCOLS.has(protocolVersion)) {
            return rpcError(id ?? null, -32602, 'Unsupported protocol version')
        }
        const sessionID = newMCPSessionID(protocolVersion)
        const db = new Database(env.database)
        await db.ensureSchema()
        await db.saveSession(sessionID, deviceKey, false)
        return rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: deviceKey ? 'Bark MCP Server (Specific)' : 'Bark MCP Server', version: VERSION },
        }, {
            'mcp-session-id': sessionID,
            ...(protocolVersion === '2025-06-18' ? { 'mcp-protocol-version': protocolVersion } : {}),
        })
    }

    if (!sessionHeader) return jsonError(400, 'missing session ID')
    const db = new Database(env.database)
    await db.ensureSchema()
    const session = await db.sessionByID(sessionHeader)
    if (!session) return jsonError(404, 'session not found')
    if (!sessionOwnedByPath(session, deviceKey)) return jsonError(403, 'session not found')
    const protocolError = validateMCPProtocolHeader(request, session)
    if (protocolError) return protocolError
    const protocolHeaders = session.protocol_version === '2025-06-18'
        ? { 'mcp-protocol-version': session.protocol_version }
        : {}
    const limited = await enforceRateLimit(
        env.MCP_RATE_LIMITER,
        `mcp:session:${await fingerprint(session.id)}`,
    )
    if (limited) return mergeResponseHeaders(limited, protocolHeaders)

    if (method === 'notifications/initialized') {
        await db.saveSession(session.id, session.device_key, true)
        return new Response(null, { status: 202, headers: protocolHeaders })
    }

    if (!Number(session.initialized)) {
        if (!hasID) return new Response(null, { status: 202, headers: protocolHeaders })
        return rpcError(id ?? null, -32002, 'Session is not initialized', protocolHeaders)
    }
    await db.saveSession(session.id, session.device_key, true)

    if (method === 'tools/list') {
        if (!hasID) return new Response(null, { status: 202, headers: protocolHeaders })
        const required = session.device_key ? [] : ['device_key']
        const properties = {
            title: { type: 'string', description: 'Notification title' },
            subtitle: { type: 'string', description: 'Notification subtitle' },
            body: { type: 'string', description: 'Notification content' },
            markdown: { type: 'string', description: 'Markdown content, overrides body' },
            level: { type: 'string', enum: ['critical', 'active', 'timeSensitive', 'passive'] },
            volume: { type: 'number', minimum: 0, maximum: 10 },
            badge: { type: 'number', minimum: 0 },
            sound: { type: 'string' },
            icon: { type: 'string' },
            image: { type: 'string' },
            group: { type: 'string' },
            isArchive: { type: 'string' },
            ttl: { type: 'number', minimum: 0 },
            url: { type: 'string' },
            copy: { type: 'string' },
            ...(session.device_key ? {} : { device_key: { type: 'string', description: 'Device key' } }),
        }
        return rpcResult(id, {
            tools: [{
                annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
                name: 'notify',
                description: 'Send a notification to a device via Bark',
                inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
            }],
        }, protocolHeaders)
    }

    if (method === 'tools/call') {
        const { name, arguments: args = {} } = params ?? {}
        if (name !== 'notify') {
            if (!hasID) return new Response(null, { status: 202, headers: protocolHeaders })
            return rpcError(id, -32602, `tool '${String(name)}' not found`, protocolHeaders)
        }
        const normalized = normalizeKeys(isPlainObject(args) ? args : {})
        normalized.device_key = session.device_key || normalized.device_key
        try {
            const validated = validatePushParameters(normalized, { requireDeviceKey: true })
            const prepared = prepareAPNsPayload(validated, config)
            const response = await pushPrepared(db, config, prepared, validated.device_key, requestId)
            const responseBody = await safeJSON(response)
            if (!hasID) return new Response(null, { status: 202, headers: protocolHeaders })
            if (response.status === 200) {
                return rpcResult(id, { content: [{ type: 'text', text: 'Notification sent successfully' }] }, protocolHeaders)
            }
            return rpcResult(id, {
                content: [{ type: 'text', text: `Failed to send notification: ${responseBody?.message ?? 'push failed'}` }],
                isError: true,
            }, protocolHeaders)
        } catch (error) {
            if (!(error instanceof AppError)) throw error
            if (!hasID) return new Response(null, { status: 202, headers: protocolHeaders })
            return rpcResult(id, {
                content: [{ type: 'text', text: `Failed to send notification: ${error.message}` }],
                isError: true,
            }, protocolHeaders)
        }
    }

    if (!hasID) return new Response(null, { status: 202, headers: protocolHeaders })
    return rpcError(id ?? null, -32601, `Method not found: ${method}`, protocolHeaders)
}

function newMCPSessionID(protocolVersion) {
    const versionTag = protocolVersion === '2025-06-18' ? 'v20250618' : 'v20250326'
    return `mcp-session-${versionTag}-${crypto.randomUUID()}`
}

function protocolVersionFromSessionID(sessionID) {
    if (typeof sessionID === 'string' && sessionID.startsWith('mcp-session-v20250618-')) {
        return '2025-06-18'
    }
    return '2025-03-26'
}

function sessionOwnedByPath(session, deviceKey) {
    return (session.device_key ?? null) === (deviceKey ?? null)
}

function validateMCPProtocolHeader(request, session) {
    const received = request.headers.get('mcp-protocol-version')
    if (session.protocol_version === '2025-06-18' && received !== '2025-06-18') {
        return jsonError(400, 'invalid MCP protocol version')
    }
    if (received && received !== session.protocol_version) return jsonError(400, 'invalid MCP protocol version')
    return null
}

function originAllowed(origin, allowed) {
    if (origin === null) return true
    if (origin === '') return false
    return allowed.includes(origin)
}

function parseConfig(env) {
    const securityMode = env.SECURITY_MODE ?? 'strict'
    if (!['strict', 'compat'].includes(securityMode)) throw new AppError(503, 'configuration unavailable')
    if (securityMode === 'compat' && !compatWarningEmitted) {
        compatWarningEmitted = true
        console.warn(JSON.stringify({ event: 'compat_security_mode_enabled' }))
    }
    const allowNewDevice = parseBoolean(env, 'ALLOW_NEW_DEVICE', true)
    const allowQueryNums = parseBoolean(env, 'ALLOW_QUERY_NUMS', false)
    const allowLegacyGetRegister = parseBoolean(env, 'ALLOW_LEGACY_GET_REGISTER', false)
    const allowInsecureDeviceRebind = parseBoolean(env, 'ALLOW_INSECURE_DEVICE_REBIND', false)
    if (allowInsecureDeviceRebind && securityMode !== 'compat') throw new AppError(503, 'configuration unavailable')

    let legacyGetRegisterSunset = null
    if (allowLegacyGetRegister) {
        legacyGetRegisterSunset = env.LEGACY_GET_REGISTER_SUNSET
        if (!validHTTPDate(legacyGetRegisterSunset)) throw new AppError(503, 'configuration unavailable')
    }

    const basicAuth = optionalConfigString(env.BASIC_AUTH)
    if (securityMode === 'strict' && !basicAuth) throw new AppError(503, 'configuration unavailable')
    const apnsPrivateKey = requiredConfigString(env.APNS_PRIVATE_KEY)
    const apnsTeamID = requiredConfigString(env.APNS_TEAM_ID)
    const apnsKeyID = requiredConfigString(env.APNS_KEY_ID)
    const apnsTopic = requiredConfigString(env.APNS_TOPIC)
    if (!validEncodedPrivateKey(apnsPrivateKey)
        || !/^[A-Za-z0-9._-]{1,128}$/.test(apnsTeamID)
        || !/^[A-Za-z0-9._-]{1,128}$/.test(apnsKeyID)
        || !/^[A-Za-z0-9.-]{1,255}$/.test(apnsTopic)) {
        throw new AppError(503, 'configuration unavailable')
    }

    const maxRequestBytes = parseInteger(env, 'MAX_REQUEST_BYTES', 32768, 1, 32768)
    const maxBatchSize = parseInteger(env, 'MAX_BATCH_SIZE', 20, 1, 20)
    const batchConcurrency = parseInteger(env, 'BATCH_CONCURRENCY', 5, 1, 5)
    const apnsTimeoutMs = parseInteger(env, 'APNS_TIMEOUT_MS', 10000, 1000, 30000)
    if (batchConcurrency > maxBatchSize) throw new AppError(503, 'configuration unavailable')

    return {
        securityMode,
        basicAuth,
        allowNewDevice,
        allowQueryNums,
        allowLegacyGetRegister,
        allowInsecureDeviceRebind,
        legacyGetRegisterSunset,
        maxRequestBytes,
        maxBatchSize,
        batchConcurrency,
        apnsTimeoutMs,
        apnsPrivateKey,
        apnsTeamID,
        apnsKeyID,
        apnsTopic,
        mcpAllowedOrigins: parseOrigins(env.MCP_ALLOWED_ORIGINS),
    }
}

function parseBoolean(env, name, defaultValue) {
    const value = env[name]
    if (value === undefined) return defaultValue
    if (value === 'true') return true
    if (value === 'false') return false
    throw new AppError(503, 'configuration unavailable')
}

function parseInteger(env, name, defaultValue, minimum, maximum) {
    const value = env[name]
    if (value === undefined) return defaultValue
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AppError(503, 'configuration unavailable')
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new AppError(503, 'configuration unavailable')
    }
    return number
}

function parseRootPath(value) {
    if (value === undefined || value === '' || value === '/') return '/'
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#')) {
        throw new AppError(503, 'configuration unavailable')
    }
    const normalized = value.replace(/\/+$/, '')
    if (!normalized || normalized.includes('//')) throw new AppError(503, 'configuration unavailable')
    return normalized
}

function mountedPath(pathname, rootPath) {
    if (rootPath === '/') return pathname
    if (pathname === rootPath) return '/'
    if (pathname.startsWith(`${rootPath}/`)) return pathname.slice(rootPath.length) || '/'
    return null
}

function parseOrigins(value) {
    if (value === undefined) return []
    if (typeof value !== 'string') throw new AppError(503, 'configuration unavailable')
    if (value.trim() === '') return []
    return value.split(',').map((item) => {
        const origin = item.trim()
        if (!origin || origin.includes('*')) throw new AppError(503, 'configuration unavailable')
        let parsed
        try {
            parsed = new URL(origin)
        } catch (error) {
            throw new AppError(503, 'configuration unavailable')
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
            throw new AppError(503, 'configuration unavailable')
        }
        return origin
    })
}

function validHTTPDate(value) {
    if (typeof value !== 'string') return false
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return false
    const parsed = Date.parse(value)
    return !Number.isNaN(parsed) && new Date(parsed).toUTCString() === value
}

function validEncodedPrivateKey(value) {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length < 3 || !lines[0].startsWith('-----') || !lines.at(-1).startsWith('-----')) return false
    const encoded = lines.slice(1, -1).join('')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
    try {
        return base64Decode(encoded).byteLength > 0
    } catch (error) {
        return false
    }
}

function requiredConfigString(value) {
    const parsed = optionalConfigString(value)
    if (!parsed) throw new AppError(503, 'configuration unavailable')
    return parsed
}

function optionalConfigString(value) {
    if (value === undefined) return null
    if (typeof value !== 'string' || value.length === 0) throw new AppError(503, 'configuration unavailable')
    return value
}

function authorize(request, config, options = {}) {
    const required = options.required === true
    if (!config.basicAuth) {
        if (required) return { authenticated: false, response: jsonError(503, 'configuration unavailable') }
        return { authenticated: false, response: null }
    }
    const header = request.headers.get('authorization')
    if (!header) {
        if (!required) return { authenticated: false, response: null }
        return { authenticated: false, response: unauthorized() }
    }
    if (!header.startsWith('Basic ') || header.slice(6).length === 0) {
        return { authenticated: false, response: unauthorized() }
    }
    const expected = base64Encode(encoder.encode(config.basicAuth))
    if (!constantTimeCompare(header.slice(6), expected)) {
        return { authenticated: false, response: unauthorized() }
    }
    return { authenticated: true, response: null }
}

function unauthorized() {
    return jsonError(401, 'Unauthorized', {
        'www-authenticate': 'Basic realm="Bark"',
        'cache-control': 'no-store',
    })
}

async function enforceRateLimit(binding, key) {
    if (!binding || typeof binding.limit !== 'function') {
        return jsonError(503, 'rate limiter unavailable', { 'cache-control': 'no-store' })
    }
    let result
    try {
        result = await binding.limit({ key })
    } catch (error) {
        return jsonError(503, 'rate limiter unavailable', { 'cache-control': 'no-store' })
    }
    if (result?.success !== false) return null
    return jsonResponse({
        code: 429,
        message: 'rate limit exceeded',
        retryable: true,
        timestamp: timestamp(),
    }, 429, { 'retry-after': '60', 'cache-control': 'no-store' })
}

async function parseStructuredBody(request, config, allowedMediaTypes) {
    const mediaType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
    if (!allowedMediaTypes.includes(mediaType)) throw new AppError(415, 'unsupported media type')
    const text = await readBodyText(request, config.maxRequestBytes)
    if (mediaType === 'application/json') {
        let parsed
        try {
            parsed = JSON.parse(text)
        } catch (error) {
            throw new AppError(400, 'request body is not valid JSON')
        }
        if (!isPlainObject(parsed)) throw new AppError(400, 'request body must be an object')
        return normalizeKeys(parsed)
    }
    const parsed = {}
    new URLSearchParams(text).forEach((value, key) => { parsed[key.toLowerCase()] = value })
    return parsed
}

async function readBodyText(request, maximumBytes) {
    const declared = request.headers.get('content-length')
    if (declared !== null) {
        if (!/^\d+$/.test(declared)) throw new AppError(400, 'invalid Content-Length')
        if (Number(declared) > maximumBytes) throw new AppError(413, 'request body is too large')
    }
    if (!request.body) return ''
    const reader = request.body.getReader()
    const chunks = []
    let length = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > maximumBytes) {
            try { await reader.cancel() } catch (error) { /* no-op */ }
            throw new AppError(413, 'request body is too large')
        }
        chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
        throw new AppError(400, 'request body is not valid UTF-8')
    }
}

function validateDeviceKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,255}$/.test(value)) {
        throw new AppError(400, 'device key is invalid')
    }
    return value
}

function validateDeviceToken(value) {
    if (typeof value !== 'string' || value.length < 32 || value.length > 160 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
        throw new AppError(400, 'device token is invalid')
    }
    return value.toLowerCase()
}

function optionalString(value, name, maximumBytes, status = 400) {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw new AppError(400, `${name} must be a string`)
    if (encoder.encode(value).byteLength > maximumBytes) throw new AppError(status, `${name} is too large`)
    return value
}

function optionalScalarString(value, name, maximumBytes) {
    if (value === undefined || value === null || value === '') return undefined
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new AppError(400, `${name} is invalid`)
    return optionalString(String(value), name, maximumBytes)
}

function optionalInteger(value, name) {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value === 'string' && !/^\d+$/.test(value)) throw new AppError(400, `${name} is invalid`)
    const parsed = typeof value === 'string' ? Number(value) : value
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) throw new AppError(400, `${name} is invalid`)
    return parsed
}

function optionalNumber(value, name, minimum, maximum) {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value === 'string' && !/^(?:\d+\.?\d*|\.\d+)$/.test(value)) throw new AppError(400, `${name} is invalid`)
    const parsed = typeof value === 'string' ? Number(value) : value
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        throw new AppError(400, `${name} is invalid`)
    }
    return parsed
}

function optionalFlag(value, name) {
    if (value === undefined || value === null || value === '') return undefined
    if (value === true || value === 1 || value === '1' || value === 'true') return true
    if (value === false || value === 0 || value === '0' || value === 'false') return false
    throw new AppError(400, `${name} is invalid`)
}

function optionalURL(value, name) {
    const parsedValue = optionalString(value, name, 2048)
    if (parsedValue === undefined) return undefined
    let parsed
    try {
        parsed = new URL(parsedValue)
    } catch (error) {
        throw new AppError(400, `${name} is invalid`)
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new AppError(400, `${name} is invalid`)
    return parsedValue
}

async function mapWithConcurrency(values, concurrency, worker) {
    const results = new Array(values.length)
    let next = 0
    const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (true) {
            const index = next
            next += 1
            if (index >= values.length) return
            results[index] = await worker(values[index], index)
        }
    })
    await Promise.all(runners)
    return results
}

function splitPath(pathname) {
    return pathname.split('/').filter((part) => part.length > 0)
}

function safeRouteName(pathname) {
    if (['/', '/ping', '/healthz', '/register', '/info', '/push', '/mcp'].includes(pathname)) return pathname
    if (pathname.startsWith('/mcp/')) return '/mcp/:device'
    return '/:device'
}

function safeAPNsLogReason(reason, status) {
    if (typeof reason === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(reason)) return reason
    return status === null ? 'transport_error' : `status_${status}`
}

function decodePathSegment(value) {
    try {
        return decodeURIComponent(value)
    } catch (error) {
        throw new AppError(400, 'URL path is invalid')
    }
}

function queryObject(searchParams) {
    const result = {}
    searchParams.forEach((value, key) => { result[key.toLowerCase()] = value })
    return result
}

function normalizeKeys(value) {
    if (!isPlainObject(value)) return value
    return Object.keys(value).reduce((result, key) => {
        result[key.toLowerCase()] = value[key]
        return result
    }, {})
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null))
}

function methodNotAllowed(methods) {
    return jsonError(405, 'method not allowed', { allow: methods.join(', ') })
}

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    })
}

function jsonError(status, message, headers = {}) {
    return jsonResponse({ code: status, message, timestamp: timestamp() }, status, {
        ...(status === 401 || status === 503 ? { 'cache-control': 'no-store' } : {}),
        ...headers,
    })
}

function errorResponse(error) {
    if (error instanceof AppError) {
        const body = { code: error.code, message: error.message, timestamp: timestamp() }
        if (error.retryable !== undefined) body.retryable = error.retryable
        return jsonResponse(body, error.status, {
            ...(error.status === 401 || error.status === 503 ? { 'cache-control': 'no-store' } : {}),
            ...error.headers,
        })
    }
    return jsonError(500, 'internal server error')
}

function rpcResult(id, result, headers = {}) {
    return jsonResponse({ jsonrpc: '2.0', id, result }, 200, headers)
}

function rpcError(id, code, message, headers = {}) {
    return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } }, 200, headers)
}

function attachRequestID(response, requestId) {
    const headers = new Headers(response.headers)
    headers.set('x-request-id', requestId)
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}

function mergeResponseHeaders(response, additionalHeaders) {
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value)
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}

function requestID(request) {
    const supplied = request.headers.get('x-request-id')
    if (supplied && /^[A-Za-z0-9._~-]{1,128}$/.test(supplied)) return supplied
    return crypto.randomUUID()
}

function timestamp() {
    return Math.floor(Date.now() / 1000)
}

function constantTimeCompare(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
    let result = 0
    for (let index = 0; index < left.length; index += 1) {
        result |= left.charCodeAt(index) ^ right.charCodeAt(index)
    }
    return result === 0
}

async function fingerprint(value) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)))
    return base64URL(new Uint8Array(digest)).slice(0, 32)
}

async function newShortUUID() {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(crypto.randomUUID()))
    return base64URL(new Uint8Array(digest)).replace(/[lIO01]/g, '').slice(0, 22)
}

function base64URL(value) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value
    return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64Encode(bytes) {
    let binary = ''
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
    return btoa(binary)
}

function base64Decode(value) {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
}

async function safeJSON(response) {
    try {
        return await response.json()
    } catch (error) {
        return null
    }
}
