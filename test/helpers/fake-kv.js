function clone(value) {
    return value === undefined ? undefined : structuredClone(value)
}

export class FakeKVNamespace {
    constructor(options = {}) {
        this.calls = []
        this.clock = options.clock ?? (() => Date.now())
        this.offset = 0
        this.values = new Map()

        for (const [key, value] of options.values ?? []) {
            this.values.set(key, { value: String(value), expiresAt: null, metadata: null })
        }
    }

    now() {
        return this.clock() + this.offset
    }

    advance(milliseconds) {
        this.offset += milliseconds
    }

    purgeIfExpired(key) {
        const entry = this.values.get(key)
        if (entry && entry.expiresAt !== null && entry.expiresAt <= this.now()) {
            this.values.delete(key)
            return true
        }
        return false
    }

    async get(key, typeOrOptions) {
        this.calls.push({ type: 'get', key, options: clone(typeOrOptions) })
        this.purgeIfExpired(key)
        const entry = this.values.get(key)
        if (!entry) return null

        const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type
        if (type === 'json') return JSON.parse(entry.value)
        if (type === 'arrayBuffer') return new TextEncoder().encode(entry.value).buffer
        if (type === 'stream') {
            return new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(entry.value))
                    controller.close()
                },
            })
        }
        return entry.value
    }

    async getWithMetadata(key, typeOrOptions) {
        const value = await this.get(key, typeOrOptions)
        const entry = this.values.get(key)
        return { value, metadata: clone(entry?.metadata ?? null) }
    }

    async put(key, value, options = {}) {
        this.calls.push({ type: 'put', key, value: String(value), options: clone(options) })
        const expiresAt = options.expirationTtl !== undefined
            ? this.now() + Number(options.expirationTtl) * 1000
            : options.expiration !== undefined
                ? Number(options.expiration) * 1000
                : null
        this.values.set(key, {
            value: String(value),
            expiresAt,
            metadata: clone(options.metadata ?? null),
        })
    }

    async delete(key) {
        this.calls.push({ type: 'delete', key })
        this.values.delete(key)
    }

    async list(options = {}) {
        this.calls.push({ type: 'list', options: clone(options) })
        for (const key of this.values.keys()) this.purgeIfExpired(key)

        const prefix = options.prefix ?? ''
        const limit = options.limit ?? 1000
        const offset = options.cursor ? Number(options.cursor) : 0
        const all = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort()
        const selected = all.slice(offset, offset + limit)
        const nextOffset = offset + selected.length

        return {
            keys: selected.map((name) => ({
                name,
                expiration: this.values.get(name).expiresAt === null
                    ? undefined
                    : Math.floor(this.values.get(name).expiresAt / 1000),
                metadata: clone(this.values.get(name).metadata),
            })),
            list_complete: nextOffset >= all.length,
            cursor: nextOffset >= all.length ? '' : String(nextOffset),
        }
    }
}
