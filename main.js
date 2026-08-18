const VERSION = 'v2.5.0'
const BUILD = '2026-08-18'
const SUPPORTED_MCP_PROTOCOLS = new Set(['2025-03-26', '2025-06-18'])
const encoder = new TextEncoder()
const schemaPromises = new WeakMap()
const PASSWORD_ITERATIONS = 100000
const PASSWORD_ALGORITHM = 'pbkdf2-sha256+pepper-v1'
const AUTH_SESSION_TTL_SECONDS = 86400
const APNS_CREDENTIAL_KEY_VERSION = 1
const APNS_CREDENTIAL_AAD = encoder.encode('bark-worker:apns-credentials:v1')
const PKCS8_PRIVATE_KEY_BEGIN = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
const PKCS8_PRIVATE_KEY_END = ['-----END ', 'PRIVATE KEY-----'].join('')

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

    if (pathname === '/auth/setup') {
        if (request.method !== 'POST') return methodNotAllowed(['POST'])
        return handleAuthSetup(request, env, config)
    }

    if (pathname === '/auth/login') {
        if (request.method !== 'POST') return methodNotAllowed(['POST'])
        return handleAuthLogin(request, env, config)
    }

    if (pathname === '/auth/logout') {
        if (request.method !== 'POST') return methodNotAllowed(['POST'])
        return handleAuthLogout(request, env, config)
    }

    if (pathname === '/auth/me') {
        if (request.method !== 'GET') return methodNotAllowed(['GET'])
        return handleAuthMe(request, env, config)
    }

    if (pathname === '/admin/users') {
        if (request.method !== 'POST') return methodNotAllowed(['POST'])
        return handleAdminUsers(request, env, config)
    }

    if (pathname === '/admin/apns') {
        if (!['GET', 'PUT'].includes(request.method)) return methodNotAllowed(['GET', 'PUT'])
        return handleAdminAPNs(request, env, config)
    }

    if (pathname.startsWith('/auth/') || pathname.startsWith('/admin/')) return jsonError(404, 'not found')

    if (pathname === '/register') {
        return handleRegister(request, env, config)
    }

    if (pathname === '/info') {
        if (request.method !== 'GET') return methodNotAllowed(['GET'])
        const db = new Database(env.database)
        await db.ensureSchema()
        const auth = await authorize(request, env, db, config, { required: true })
        if (auth.response) return auth.response
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

async function handleAuthSetup(request, env, config) {
    const limited = await enforceRateLimit(
        env.REGISTER_RATE_LIMITER,
        `setup:${await fingerprint(request.headers.get('cf-connecting-ip') || 'unknown')}`,
    )
    if (limited) return limited
    const suppliedToken = request.headers.get('x-bootstrap-token')
    if (!suppliedToken || !constantTimeCompare(suppliedToken, config.bootstrapToken)) return unauthorized()

    const input = await parseStructuredBody(request, config, ['application/json'])
    const username = validateUsername(input.username)
    const password = validatePassword(input.password)
    const passwordRecord = await createPasswordRecord(password, config.masterKey)
    const db = new Database(env.database)
    await db.ensureSchema()
    const created = await db.createFirstUser(username, passwordRecord)
    if (!created) throw new AppError(409, 'setup already completed')
    return jsonResponse({
        code: 201,
        message: 'created',
        data: { user: { username, role: 'admin' } },
        timestamp: timestamp(),
    }, 201, { 'cache-control': 'no-store' })
}

async function handleAuthLogin(request, env, config) {
    const input = await parseStructuredBody(request, config, ['application/json'])
    const username = validateUsername(input.username)
    const password = validatePassword(input.password)
    const limited = await enforceRateLimit(
        env.AUTH_RATE_LIMITER,
        `login:${await fingerprint(`${request.headers.get('cf-connecting-ip') || 'unknown'}\u0000${username}`)}`,
    )
    if (limited) return limited

    const db = new Database(env.database)
    await db.ensureSchema()
    const user = await db.userByUsername(username)
    if (!await passwordMatches(password, user, config.masterKey)) return unauthorized()

    const tokenBytes = new Uint8Array(32)
    crypto.getRandomValues(tokenBytes)
    const token = base64URL(tokenBytes)
    const tokenHash = await sha256Base64URL(token)
    const expiresAt = timestamp() + AUTH_SESSION_TTL_SECONDS
    await db.saveAuthSession(tokenHash, user.username, expiresAt)
    return jsonResponse({
        code: 200,
        message: 'success',
        data: {
            token,
            token_type: 'Bearer',
            expires_at: expiresAt,
            user: { username: user.username, role: user.role },
        },
        timestamp: timestamp(),
    }, 200, { 'cache-control': 'no-store' })
}

async function handleAuthLogout(request, env, config) {
    const db = new Database(env.database)
    await db.ensureSchema()
    const auth = await authorize(request, env, db, config, { required: true })
    if (auth.response) return auth.response
    if (auth.sessionTokenHash) await db.deleteAuthSession(auth.sessionTokenHash)
    return jsonResponse({ code: 200, message: 'success', timestamp: timestamp() }, 200, { 'cache-control': 'no-store' })
}

async function handleAuthMe(request, env, config) {
    const db = new Database(env.database)
    await db.ensureSchema()
    const auth = await authorize(request, env, db, config, { required: true })
    if (auth.response) return auth.response
    return jsonResponse({
        code: 200,
        message: 'success',
        data: { user: { username: auth.user.username, role: auth.user.role } },
        timestamp: timestamp(),
    }, 200, { 'cache-control': 'no-store' })
}

async function handleAdminUsers(request, env, config) {
    const db = new Database(env.database)
    await db.ensureSchema()
    const auth = await authorize(request, env, db, config, { required: true })
    if (auth.response) return auth.response
    if (auth.user.role !== 'admin') throw new AppError(403, 'forbidden')
    const input = await parseStructuredBody(request, config, ['application/json'])
    const username = validateUsername(input.username)
    const password = validatePassword(input.password)
    const role = input.role ?? 'user'
    if (!['admin', 'user'].includes(role)) throw new AppError(400, 'role is invalid')
    const passwordRecord = await createPasswordRecord(password, config.masterKey)
    const created = await db.createUser(username, passwordRecord, role)
    if (!created) throw new AppError(409, 'user already exists')
    return jsonResponse({
        code: 201,
        message: 'created',
        data: { user: { username, role } },
        timestamp: timestamp(),
    }, 201, { 'cache-control': 'no-store' })
}

async function handleAdminAPNs(request, env, config) {
    const db = new Database(env.database)
    await db.ensureSchema()
    const auth = await authorize(request, env, db, config, { required: true })
    if (auth.response) return auth.response
    if (auth.user.role !== 'admin') throw new AppError(403, 'forbidden')

    if (request.method === 'GET') {
        const row = await db.apnsCredentialRecord()
        if (!row) {
            return jsonResponse({
                code: 200,
                message: 'success',
                data: { configured: false },
                timestamp: timestamp(),
            }, 200, { 'cache-control': 'no-store' })
        }
        const credentials = await decryptAPNsCredentials(row, config.masterKey)
        return jsonResponse({
            code: 200,
            message: 'success',
            data: {
                configured: true,
                team_id: credentials.apnsTeamID,
                key_id: credentials.apnsKeyID,
                topic: credentials.apnsTopic,
                updated_at: Number(row.updated_at),
            },
            timestamp: timestamp(),
        }, 200, { 'cache-control': 'no-store' })
    }

    const input = await parseStructuredBody(request, config, ['application/json'])
    const credentials = validateAPNsCredentials({
        apnsPrivateKey: input.private_key,
        apnsTeamID: input.team_id,
        apnsKeyID: input.key_id,
        apnsTopic: input.topic,
    }, 400)
    try {
        await importAPNsSigningKey(credentials.apnsPrivateKey)
    } catch (error) {
        throw new AppError(400, 'APNs credentials are invalid')
    }
    const encrypted = await encryptAPNsCredentials(credentials, config.masterKey)
    await db.saveAPNsCredential(encrypted, auth.user.username)
    apnsTokenCache = { credentials: null, token: null, expiresAt: 0, promise: null }
    return jsonResponse({
        code: 200,
        message: 'success',
        data: {
            configured: true,
            team_id: credentials.apnsTeamID,
            key_id: credentials.apnsKeyID,
            topic: credentials.apnsTopic,
        },
        timestamp: timestamp(),
    }, 200, { 'cache-control': 'no-store' })
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

    const subjectSource = request.headers.get('authorization')
        || request.headers.get('cf-connecting-ip')
        || 'anonymous'
    const subject = `request:${await fingerprint(subjectSource)}`
    const limited = await enforceRateLimit(env.REGISTER_RATE_LIMITER, subject)
    if (limited) return decorateLegacyGET(limited, legacyGET, config)

    const db = new Database(env.database)
    await db.ensureSchema()
    const auth = await authorize(request, env, db, config, { required: config.securityMode === 'strict' })
    if (auth.response) return decorateLegacyGET(auth.response, legacyGET, config)

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
    const parameters = await parsePushParameters(request, config, pathParts)
    if (Object.prototype.hasOwnProperty.call(parameters, 'device_keys')) {
        const deviceKeys = parseDeviceKeys(parameters.device_keys, config.maxBatchSize)
        const subjectValue = request.headers.get('authorization')
            || request.headers.get('cf-connecting-ip')
            || 'anonymous'
        const limited = await enforceRateLimit(env.BATCH_RATE_LIMITER, `batch:${await fingerprint(subjectValue)}`)
        if (limited) return limited

        const base = { ...parameters }
        delete base.device_keys
        delete base.device_key
        const validated = validatePushParameters(base, { requireDeviceKey: false })
        const prepared = prepareAPNsPayload(validated, config)
        const db = new Database(env.database)
        await db.ensureSchema()
        const auth = await authorize(request, env, db, config, { required: config.securityMode === 'strict' })
        if (auth.response) return auth.response
        const apnsConfigPromise = loadAPNsConfig(db, config)

        const results = await mapWithConcurrency(deviceKeys, config.batchConcurrency, async (deviceKey) => {
            try {
                const response = await pushPrepared(db, config, prepared, deviceKey, requestId, apnsConfigPromise)
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
    const auth = await authorize(request, env, db, config, { required: config.securityMode === 'strict' })
    if (auth.response) return auth.response
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

async function pushPrepared(db, config, prepared, deviceKey, requestId, apnsConfigPromise = null) {
    validateDeviceKey(deviceKey)
    const device = await db.deviceByKey(deviceKey)
    if (!device.token) return jsonError(400, 'invalid device key')

    let deviceToken
    try {
        deviceToken = validateDeviceToken(device.token)
    } catch (error) {
        return jsonError(400, 'invalid device key')
    }

    const apnsConfig = await (apnsConfigPromise ?? loadAPNsConfig(db, config))
    const apns = new APNs({ ...config, ...apnsConfig })
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
    const privateKey = await importAPNsSigningKey(config.apnsPrivateKey)
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

async function importAPNsSigningKey(privateKey) {
    const encodedKey = privateKey
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('-----'))
        .join('')
    const keyBytes = base64Decode(encodedKey)
    return crypto.subtle.importKey(
        'pkcs8',
        keyBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
    )
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
        await this.db.exec("CREATE TABLE IF NOT EXISTS `users` (`username` TEXT PRIMARY KEY COLLATE NOCASE, `password_hash` TEXT NOT NULL, `password_salt` TEXT NOT NULL, `password_iterations` INTEGER NOT NULL, `password_algorithm` TEXT NOT NULL, `role` TEXT NOT NULL CHECK (`role` IN ('admin', 'user')), `disabled` INTEGER NOT NULL DEFAULT 0 CHECK (`disabled` IN (0, 1)), `created_at` INTEGER NOT NULL, `updated_at` INTEGER NOT NULL)")
        await this.db.exec('CREATE TABLE IF NOT EXISTS `auth_sessions` (`token_hash` TEXT PRIMARY KEY, `username` TEXT NOT NULL, `created_at` INTEGER NOT NULL, `expires_at` INTEGER NOT NULL, FOREIGN KEY (`username`) REFERENCES `users` (`username`) ON DELETE CASCADE)')
        await this.db.exec('CREATE INDEX IF NOT EXISTS `idx_auth_sessions_expires_at` ON `auth_sessions` (`expires_at`)')
        await this.db.exec('CREATE INDEX IF NOT EXISTS `idx_auth_sessions_username` ON `auth_sessions` (`username`)')
        await this.db.exec('CREATE TABLE IF NOT EXISTS `apns_credentials` (`id` INTEGER PRIMARY KEY CHECK (`id` = 1), `ciphertext` TEXT NOT NULL, `iv` TEXT NOT NULL, `key_version` INTEGER NOT NULL, `updated_by` TEXT NOT NULL, `updated_at` INTEGER NOT NULL, FOREIGN KEY (`updated_by`) REFERENCES `users` (`username`))')
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

    async userByUsername(username) {
        const result = await this.db.prepare('SELECT `username`, `password_hash`, `password_salt`, `password_iterations`, `password_algorithm`, `role`, `disabled` FROM `users` WHERE `username` = ?')
            .bind(username)
            .run()
        return result.results?.[0] ?? null
    }

    async createFirstUser(username, passwordRecord) {
        const now = timestamp()
        const result = await this.db.prepare("INSERT OR IGNORE INTO `users` (`username`, `password_hash`, `password_salt`, `password_iterations`, `password_algorithm`, `role`, `created_at`, `updated_at`) SELECT ?, ?, ?, ?, ?, 'admin', ?, ? WHERE NOT EXISTS (SELECT 1 FROM `users`)")
            .bind(
                username,
                passwordRecord.passwordHash,
                passwordRecord.passwordSalt,
                passwordRecord.passwordIterations,
                passwordRecord.passwordAlgorithm,
                now,
                now,
            )
            .run()
        return Number(result.meta?.changes ?? 0) === 1
    }

    async createUser(username, passwordRecord, role) {
        const now = timestamp()
        const result = await this.db.prepare('INSERT OR IGNORE INTO `users` (`username`, `password_hash`, `password_salt`, `password_iterations`, `password_algorithm`, `role`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(
                username,
                passwordRecord.passwordHash,
                passwordRecord.passwordSalt,
                passwordRecord.passwordIterations,
                passwordRecord.passwordAlgorithm,
                role,
                now,
                now,
            )
            .run()
        return Number(result.meta?.changes ?? 0) === 1
    }

    async saveAuthSession(tokenHash, username, expiresAt) {
        const now = timestamp()
        return this.db.prepare('INSERT INTO `auth_sessions` (`token_hash`, `username`, `created_at`, `expires_at`) VALUES (?, ?, ?, ?)')
            .bind(tokenHash, username, now, expiresAt)
            .run()
    }

    async authSession(tokenHash) {
        const result = await this.db.prepare('SELECT `users`.`username`, `users`.`role`, `auth_sessions`.`expires_at` FROM `auth_sessions` JOIN `users` ON `users`.`username` = `auth_sessions`.`username` WHERE `auth_sessions`.`token_hash` = ? AND `auth_sessions`.`expires_at` > ? AND `users`.`disabled` = 0')
            .bind(tokenHash, timestamp())
            .run()
        return result.results?.[0] ?? null
    }

    async deleteAuthSession(tokenHash) {
        return this.db.prepare('DELETE FROM `auth_sessions` WHERE `token_hash` = ?').bind(tokenHash).run()
    }

    async apnsCredentialRecord() {
        const result = await this.db.prepare('SELECT `ciphertext`, `iv`, `key_version`, `updated_by`, `updated_at` FROM `apns_credentials` WHERE `id` = 1').run()
        return result.results?.[0] ?? null
    }

    async saveAPNsCredential(encrypted, username) {
        return this.db.prepare('INSERT INTO `apns_credentials` (`id`, `ciphertext`, `iv`, `key_version`, `updated_by`, `updated_at`) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(`id`) DO UPDATE SET `ciphertext` = EXCLUDED.`ciphertext`, `iv` = EXCLUDED.`iv`, `key_version` = EXCLUDED.`key_version`, `updated_by` = EXCLUDED.`updated_by`, `updated_at` = EXCLUDED.`updated_at`')
            .bind(encrypted.ciphertext, encrypted.iv, APNS_CREDENTIAL_KEY_VERSION, username, timestamp())
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

    async cleanupAuthSessions() {
        const result = await this.db.prepare('DELETE FROM `auth_sessions` WHERE `expires_at` < ?')
            .bind(timestamp())
            .run()
        return Number(result.meta?.changes ?? 0)
    }
}

async function runScheduled(env, controller) {
    const started = Date.now()
    try {
        const db = new Database(env.database)
        await db.ensureSchema()
        const mcpDeleted = await db.cleanupSessions()
        const authDeleted = await db.cleanupAuthSessions()
        console.log(JSON.stringify({
            event: 'session_cleanup',
            deleted: mcpDeleted + authDeleted,
            mcp_deleted: mcpDeleted,
            auth_deleted: authDeleted,
            duration_ms: Date.now() - started,
        }))
    } catch (error) {
        console.error(JSON.stringify({ event: 'session_cleanup_failed', duration_ms: Date.now() - started }))
        throw error
    }
}

async function handleMCP(request, env, config, deviceKey, requestId) {
    if (!originAllowed(request.headers.get('origin'), config.mcpAllowedOrigins)) {
        return jsonError(403, 'origin is not allowed')
    }
    if (deviceKey !== null) validateDeviceKey(deviceKey)
    if (!['POST', 'DELETE'].includes(request.method)) return methodNotAllowed(['POST', 'DELETE'])

    const sessionHeader = request.headers.get('mcp-session-id')

    if (request.method === 'DELETE') {
        const db = new Database(env.database)
        await db.ensureSchema()
        const auth = await authorize(request, env, db, config, { required: true })
        if (auth.response) return auth.response
        if (!sessionHeader) return jsonError(400, 'missing session ID')
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
        const subject = request.headers.get('authorization')
            || request.headers.get('cf-connecting-ip')
            || 'anonymous'
        const limited = await enforceRateLimit(
            env.MCP_RATE_LIMITER,
            `mcp:auth:${await fingerprint(subject)}`,
        )
        if (limited) return limited
        const db = new Database(env.database)
        await db.ensureSchema()
        const auth = await authorize(request, env, db, config, { required: true })
        if (auth.response) return auth.response
        if (sessionHeader) return jsonError(400, 'initialize must not include a session ID')
        if (!hasID) return new Response(null, { status: 202 })
        const protocolVersion = params?.protocolVersion
        if (!SUPPORTED_MCP_PROTOCOLS.has(protocolVersion)) {
            return rpcError(id ?? null, -32602, 'Unsupported protocol version')
        }
        const sessionID = newMCPSessionID(protocolVersion)
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

    const db = new Database(env.database)
    await db.ensureSchema()
    const auth = await authorize(request, env, db, config, { required: true })
    if (auth.response) return auth.response
    if (!sessionHeader) return jsonError(400, 'missing session ID')
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

    const masterKey = parseMasterKey(env.APP_MASTER_KEY)
    const bootstrapToken = requiredConfigString(env.ADMIN_BOOTSTRAP_TOKEN)
    if (encoder.encode(bootstrapToken).byteLength < 32 || encoder.encode(bootstrapToken).byteLength > 256) {
        throw new AppError(503, 'configuration unavailable')
    }

    const maxRequestBytes = parseInteger(env, 'MAX_REQUEST_BYTES', 32768, 1, 32768)
    const maxBatchSize = parseInteger(env, 'MAX_BATCH_SIZE', 20, 1, 20)
    const batchConcurrency = parseInteger(env, 'BATCH_CONCURRENCY', 5, 1, 5)
    const apnsTimeoutMs = parseInteger(env, 'APNS_TIMEOUT_MS', 10000, 1000, 30000)
    if (batchConcurrency > maxBatchSize) throw new AppError(503, 'configuration unavailable')

    return {
        securityMode,
        masterKey,
        bootstrapToken,
        allowNewDevice,
        allowQueryNums,
        allowLegacyGetRegister,
        allowInsecureDeviceRebind,
        legacyGetRegisterSunset,
        maxRequestBytes,
        maxBatchSize,
        batchConcurrency,
        apnsTimeoutMs,
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
    if (typeof value !== 'string') return false
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length < 3
        || lines[0] !== PKCS8_PRIVATE_KEY_BEGIN
        || lines.at(-1) !== PKCS8_PRIVATE_KEY_END) return false
    const encoded = lines.slice(1, -1).join('')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
    try {
        return base64Decode(encoded).byteLength > 0
    } catch (error) {
        return false
    }
}

function validateUsername(value) {
    if (typeof value !== 'string') throw new AppError(400, 'username is invalid')
    const username = value.toLowerCase()
    if (!/^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])$/.test(username)) {
        throw new AppError(400, 'username is invalid')
    }
    return username
}

function validatePassword(value) {
    if (typeof value !== 'string') throw new AppError(400, 'password is invalid')
    const length = encoder.encode(value).byteLength
    if (length < 12 || length > 128) throw new AppError(400, 'password is invalid')
    return value
}

async function deriveApplicationKey(masterKey, purpose, algorithm, usages) {
    const source = await crypto.subtle.importKey('raw', base64Decode(masterKey), 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode('bark-worker:v1'),
        info: encoder.encode(purpose),
    }, source, algorithm, false, usages)
}

async function passwordDigest(password, salt, iterations, masterKey) {
    const pepperKey = await deriveApplicationKey(
        masterKey,
        'password-pepper',
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        ['sign'],
    )
    const peppered = await crypto.subtle.sign('HMAC', pepperKey, encoder.encode(password))
    const material = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits'])
    return new Uint8Array(await crypto.subtle.deriveBits({
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt,
        iterations,
    }, material, 256))
}

async function createPasswordRecord(password, masterKey) {
    const salt = new Uint8Array(16)
    crypto.getRandomValues(salt)
    const hash = await passwordDigest(password, salt, PASSWORD_ITERATIONS, masterKey)
    return {
        passwordHash: base64Encode(hash),
        passwordSalt: base64Encode(salt),
        passwordIterations: PASSWORD_ITERATIONS,
        passwordAlgorithm: PASSWORD_ALGORITHM,
    }
}

async function passwordMatches(password, user, masterKey) {
    const passwordBytes = typeof password === 'string' ? encoder.encode(password).byteLength : 0
    if (passwordBytes === 0 || passwordBytes > 128) return false
    const dummyRecord = {
        password_hash: base64Encode(new Uint8Array(32)),
        password_salt: base64Encode(new Uint8Array(16)),
        password_iterations: PASSWORD_ITERATIONS,
        password_algorithm: PASSWORD_ALGORITHM,
        disabled: 0,
    }
    const metadataValid = user?.password_algorithm === PASSWORD_ALGORITHM
        && Number(user?.password_iterations) === PASSWORD_ITERATIONS
    const record = metadataValid ? user : dummyRecord
    let salt
    let expected
    try {
        salt = base64Decode(record.password_salt)
        expected = base64Decode(record.password_hash)
    } catch (error) {
        return false
    }
    if (salt.byteLength !== 16 || expected.byteLength !== 32) return false
    const actual = await passwordDigest(password, salt, PASSWORD_ITERATIONS, masterKey)
    return Boolean(user && metadataValid && !Number(user.disabled) && constantTimeBytes(actual, expected))
}

function validateAPNsCredentials(credentials, status = 503) {
    if (!validEncodedPrivateKey(credentials?.apnsPrivateKey)
        || !/^[A-Za-z0-9._-]{1,128}$/.test(credentials?.apnsTeamID ?? '')
        || !/^[A-Za-z0-9._-]{1,128}$/.test(credentials?.apnsKeyID ?? '')
        || !/^[A-Za-z0-9.-]{1,255}$/.test(credentials?.apnsTopic ?? '')) {
        throw new AppError(status, status === 400 ? 'APNs credentials are invalid' : 'APNs configuration unavailable')
    }
    return credentials
}

async function encryptAPNsCredentials(credentials, masterKey) {
    const key = await deriveApplicationKey(masterKey, 'apns-vault', { name: 'AES-GCM', length: 256 }, ['encrypt'])
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const plaintext = encoder.encode(JSON.stringify({
        private_key: credentials.apnsPrivateKey,
        team_id: credentials.apnsTeamID,
        key_id: credentials.apnsKeyID,
        topic: credentials.apnsTopic,
    }))
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: APNS_CREDENTIAL_AAD, tagLength: 128 },
        key,
        plaintext,
    )
    return { ciphertext: base64Encode(new Uint8Array(ciphertext)), iv: base64Encode(iv) }
}

async function decryptAPNsCredentials(record, masterKey) {
    if (!record || Number(record.key_version) !== APNS_CREDENTIAL_KEY_VERSION) {
        throw new AppError(503, 'APNs configuration unavailable')
    }
    try {
        const iv = base64Decode(record.iv)
        const ciphertext = base64Decode(record.ciphertext)
        if (iv.byteLength !== 12 || ciphertext.byteLength < 17 || ciphertext.byteLength > 16384) throw new Error('invalid record')
        const key = await deriveApplicationKey(masterKey, 'apns-vault', { name: 'AES-GCM', length: 256 }, ['decrypt'])
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, additionalData: APNS_CREDENTIAL_AAD, tagLength: 128 },
            key,
            ciphertext,
        )
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
        return validateAPNsCredentials({
            apnsPrivateKey: parsed.private_key,
            apnsTeamID: parsed.team_id,
            apnsKeyID: parsed.key_id,
            apnsTopic: parsed.topic,
        })
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(503, 'APNs configuration unavailable')
    }
}

async function loadAPNsConfig(db, config) {
    const record = await db.apnsCredentialRecord()
    if (!record) throw new AppError(503, 'APNs configuration unavailable')
    return decryptAPNsCredentials(record, config.masterKey)
}

function parseMasterKey(value) {
    const encoded = requiredConfigString(value)
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new AppError(503, 'configuration unavailable')
    let bytes
    try {
        bytes = base64Decode(encoded)
    } catch (error) {
        throw new AppError(503, 'configuration unavailable')
    }
    if (bytes.byteLength !== 32 || base64Encode(bytes) !== encoded) {
        throw new AppError(503, 'configuration unavailable')
    }
    return encoded
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

async function authorize(request, env, db, config, options = {}) {
    const required = options.required === true
    const header = request.headers.get('authorization')
    if (!header) {
        if (!required) return { authenticated: false, response: null }
        return { authenticated: false, response: unauthorized() }
    }

    if (header.startsWith('Basic ') && header.slice(6).length > 0) {
        const encodedCredentials = header.slice(6)
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedCredentials)) {
            return { authenticated: false, response: unauthorized() }
        }
        let decoded
        try {
            const decodedBytes = base64Decode(encodedCredentials)
            if (base64Encode(decodedBytes) !== encodedCredentials) throw new Error('non-canonical credentials')
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes)
        } catch (error) {
            return { authenticated: false, response: unauthorized() }
        }
        const separator = decoded.indexOf(':')
        if (separator < 1) return { authenticated: false, response: unauthorized() }
        let username
        try {
            username = validateUsername(decoded.slice(0, separator))
        } catch (error) {
            return { authenticated: false, response: unauthorized() }
        }
        const limited = await enforceRateLimit(
            env.AUTH_RATE_LIMITER,
            `basic:${await fingerprint(`${request.headers.get('cf-connecting-ip') || 'unknown'}\u0000${username}`)}`,
        )
        if (limited) return { authenticated: false, response: limited }
        const password = decoded.slice(separator + 1)
        const user = await db.userByUsername(username)
        if (!await passwordMatches(password, user, config.masterKey)) {
            return { authenticated: false, response: unauthorized() }
        }
        return { authenticated: true, response: null, user, sessionTokenHash: null }
    }

    if (header.startsWith('Bearer ') && /^[A-Za-z0-9_-]{40,128}$/.test(header.slice(7))) {
        const sessionTokenHash = await sha256Base64URL(header.slice(7))
        const user = await db.authSession(sessionTokenHash)
        if (user) return { authenticated: true, response: null, user, sessionTokenHash }
    }
    return { authenticated: false, response: unauthorized() }
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
    if ([
        '/',
        '/ping',
        '/healthz',
        '/register',
        '/info',
        '/push',
        '/mcp',
        '/auth/setup',
        '/auth/login',
        '/auth/logout',
        '/auth/me',
        '/admin/users',
        '/admin/apns',
    ].includes(pathname)) return pathname
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

function constantTimeBytes(left, right) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) return false
    let result = 0
    for (let index = 0; index < left.byteLength; index += 1) result |= left[index] ^ right[index]
    return result === 0
}

async function sha256Base64URL(value) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)))
    return base64URL(new Uint8Array(digest))
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
