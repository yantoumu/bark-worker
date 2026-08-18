const nowSeconds = () => Math.floor(Date.now() / 1000)

function normalizeQuery(query) {
    return String(query).replace(/\s+/g, ' ').trim()
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value)
}

export class FakeD1Database {
    constructor(options = {}) {
        this.calls = []
        this.devices = new Map(options.devices ?? [
            ['test-device-key', 'a'.repeat(64)],
            ['testdevicekey', 'a'.repeat(64)],
        ])
        this.authorization = options.authorization === undefined
            ? { token: 'test-authorization-token', time: String(nowSeconds()) }
            : options.authorization
        this.sessions = new Map(options.sessions ?? [])
        this.users = new Map(options.users ?? [])
        this.authSessions = new Map(options.authSessions ?? [])
        this.apnsCredentials = options.apnsCredentials ?? null
        this.failures = [...(options.failures ?? [])]
        this.queryHandlers = [...(options.queryHandlers ?? [])]
        this.now = options.now ?? nowSeconds
    }

    record(type, query, bindings = []) {
        const call = {
            type,
            query: normalizeQuery(query),
            bindings: clone(bindings),
            sequence: this.calls.length,
        }
        this.calls.push(call)
        return call
    }

    maybeFail(call) {
        const index = this.failures.findIndex((failure) => {
            if (failure.remaining === 0) return false
            if (failure.type && failure.type !== call.type) return false
            if (failure.match instanceof RegExp) return failure.match.test(call.query)
            if (typeof failure.match === 'function') return failure.match(call)
            return failure.match === undefined || call.query.includes(String(failure.match))
        })

        if (index === -1) return

        const failure = this.failures[index]
        if (Number.isFinite(failure.remaining)) failure.remaining -= 1
        throw failure.error ?? new Error('Fake D1 failure')
    }

    async exec(query) {
        const call = this.record('exec', query)
        this.maybeFail(call)
        return { count: 0, duration: 0 }
    }

    async batch(statements) {
        this.record('batch', `batch(${statements.length})`)
        return Promise.all(statements.map((statement) => statement.run()))
    }

    prepare(query) {
        const database = this
        const normalized = normalizeQuery(query)
        database.record('prepare', normalized)

        const statement = (bindings = []) => ({
            bind(...nextBindings) {
                database.record('bind', normalized, nextBindings)
                return statement(nextBindings)
            },
            async run() {
                const call = database.record('run', normalized, bindings)
                database.maybeFail(call)
                return database.execute(call)
            },
            async all() {
                const call = database.record('all', normalized, bindings)
                database.maybeFail(call)
                return database.execute(call)
            },
            async first(column) {
                const call = database.record('first', normalized, bindings)
                database.maybeFail(call)
                const result = await database.execute(call)
                const row = result.results?.[0] ?? null
                return column && row ? row[column] : row
            },
            async raw() {
                const call = database.record('raw', normalized, bindings)
                database.maybeFail(call)
                const result = await database.execute(call)
                return (result.results ?? []).map((row) => Object.values(row))
            },
        })

        return statement()
    }

    async execute(call) {
        for (const handler of this.queryHandlers) {
            const matches = handler.match instanceof RegExp
                ? handler.match.test(call.query)
                : handler.match(call)
            if (matches) return clone(await handler.handle(call, this))
        }

        const query = call.query.toLowerCase()
        const bindings = call.bindings

        if (/^select 1\b/.test(query)) return { results: [{ 1: 1 }], success: true }

        if (query.includes('select count(*)') && query.includes('from `devices`')) {
            return { results: [{ rowCount: this.devices.size }], success: true }
        }

        if (query.includes('select count(*)') && query.includes('from `users`')) {
            return { results: [{ rowCount: this.users.size }], success: true }
        }

        if (query.includes('from `users`') && query.includes('where `username` = ?')) {
            const user = this.users.get(bindings[0])
            return { results: user ? [clone(user)] : [], success: true }
        }

        if (query.startsWith('insert or ignore into `users`')) {
            const firstAdminInsert = query.includes('where not exists')
            const [username, passwordHash, passwordSalt, passwordIterations, passwordAlgorithm] = bindings
            const role = firstAdminInsert ? 'admin' : bindings[5]
            const createdAt = bindings[firstAdminInsert ? 5 : 6]
            const updatedAt = bindings[firstAdminInsert ? 6 : 7]
            if ((firstAdminInsert && this.users.size > 0) || this.users.has(username)) {
                return { results: [], success: true, meta: { changes: 0 } }
            }
            this.users.set(username, {
                username,
                password_hash: passwordHash,
                password_salt: passwordSalt,
                password_iterations: Number(passwordIterations),
                password_algorithm: passwordAlgorithm,
                role,
                disabled: 0,
                created_at: Number(createdAt),
                updated_at: Number(updatedAt),
            })
            return { results: [], success: true, meta: { changes: 1 } }
        }

        if (query.includes('from `auth_sessions`') && query.includes('join `users`')) {
            const session = this.authSessions.get(bindings[0])
            if (!session || session.expires_at <= Number(bindings[1])) return { results: [], success: true }
            const user = this.users.get(session.username)
            if (!user || Number(user.disabled)) return { results: [], success: true }
            return { results: [{
                username: user.username,
                role: user.role,
                expires_at: session.expires_at,
            }], success: true }
        }

        if (query.startsWith('insert into `auth_sessions`')) {
            const [tokenHash, username, createdAt, expiresAt] = bindings
            this.authSessions.set(tokenHash, {
                token_hash: tokenHash,
                username,
                created_at: Number(createdAt),
                expires_at: Number(expiresAt),
            })
            return { results: [], success: true, meta: { changes: 1 } }
        }

        if (query.startsWith('delete from `auth_sessions`') && query.includes('where `token_hash`')) {
            const changed = this.authSessions.delete(bindings[0]) ? 1 : 0
            return { results: [], success: true, meta: { changes: changed } }
        }

        if (query.startsWith('delete from `auth_sessions`')) {
            let changes = 0
            for (const [tokenHash, session] of this.authSessions) {
                if (session.expires_at < Number(bindings[0])) {
                    this.authSessions.delete(tokenHash)
                    changes += 1
                }
            }
            return { results: [], success: true, meta: { changes } }
        }

        if (query.includes('from `apns_credentials`') && query.includes('where `id` = 1')) {
            return { results: this.apnsCredentials ? [clone(this.apnsCredentials)] : [], success: true }
        }

        if (query.startsWith('insert into `apns_credentials`')) {
            const [ciphertext, iv, keyVersion, updatedBy, updatedAt] = bindings
            this.apnsCredentials = {
                id: 1,
                ciphertext,
                iv,
                key_version: Number(keyVersion),
                updated_by: updatedBy,
                updated_at: Number(updatedAt),
            }
            return { results: [], success: true, meta: { changes: 1 } }
        }

        if (query.includes('select `token`') && query.includes('from `devices`')) {
            const token = this.devices.get(bindings[0])
            return { results: token === undefined ? [] : [{ token }], success: true }
        }

        if ((query.startsWith('insert into `devices`') || query.startsWith('update `devices`')) && bindings.length >= 2) {
            this.devices.set(bindings[0], bindings[1])
            return { results: [], success: true, meta: { changes: 1 } }
        }

        if (query.startsWith('delete from `devices`')) {
            const changed = this.devices.delete(bindings[0]) ? 1 : 0
            return { results: [], success: true, meta: { changes: changed } }
        }

        if (query.includes('select `token`, `time`') && query.includes('from `authorization`')) {
            return { results: this.authorization ? [clone(this.authorization)] : [], success: true }
        }

        if (query.startsWith('insert into `authorization`') || query.startsWith('update `authorization`')) {
            this.authorization = { token: bindings[0], time: String(bindings[1] ?? this.now()) }
            return { results: [], success: true, meta: { changes: 1 } }
        }

        if (query.includes('select') && query.includes('from `sessions`')) {
            const session = this.sessions.get(bindings[0])
            if (!session) return { results: [], success: true }

            const minimumLastSeen = bindings[1] ?? -Infinity
            const minimumCreatedAt = bindings[2] ?? -Infinity
            if ((session.last_seen ?? 0) <= minimumLastSeen || (session.created_at ?? 0) <= minimumCreatedAt) {
                return { results: [], success: true }
            }

            return { results: [clone(session)], success: true }
        }

        if (query.startsWith('insert into `sessions`') || query.startsWith('update `sessions`')) {
            const [id, deviceKey, initialized, createdAt, lastSeen] = bindings
            const previous = this.sessions.get(id)
            this.sessions.set(id, {
                id,
                device_key: deviceKey ?? previous?.device_key ?? null,
                initialized: Number(initialized ?? previous?.initialized ?? 0),
                created_at: previous?.created_at ?? createdAt ?? this.now(),
                last_seen: lastSeen ?? this.now(),
            })
            return { results: [], success: true, meta: { changes: 1 } }
        }

        if (query.startsWith('delete from `sessions`') && query.includes('where `id`')) {
            const changed = this.sessions.delete(bindings[0]) ? 1 : 0
            return { results: [], success: true, meta: { changes: changed } }
        }

        if (query.startsWith('delete from `sessions`')) {
            let changes = 0
            const [cutoff] = bindings
            for (const [id, session] of this.sessions) {
                const expiredLastSeen = query.includes('last_seen') && session.last_seen < cutoff
                const expiredCreatedAt = query.includes('created_at') && session.created_at < cutoff
                if (expiredLastSeen || expiredCreatedAt) {
                    this.sessions.delete(id)
                    changes += 1
                }
            }
            return { results: [], success: true, meta: { changes } }
        }

        return { results: [], success: true, meta: { changes: 0 } }
    }

    callsMatching(pattern, types = ['exec', 'run', 'all', 'first', 'raw']) {
        return this.calls.filter((call) => types.includes(call.type) && pattern.test(call.query))
    }
}

export class ExplodingD1Database {
    constructor(error = new Error('D1 must not be touched')) {
        this.error = error
        this.calls = []
    }

    exec(query) {
        this.calls.push({ type: 'exec', query: normalizeQuery(query) })
        throw this.error
    }

    prepare(query) {
        this.calls.push({ type: 'prepare', query: normalizeQuery(query) })
        throw this.error
    }
}
