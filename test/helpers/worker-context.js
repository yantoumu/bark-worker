export function createWorkerContext() {
    const pending = []
    let passThrough = false

    return {
        context: {
            waitUntil(promise) {
                pending.push(Promise.resolve(promise))
            },
            passThroughOnException() {
                passThrough = true
            },
        },
        get pendingCount() {
            return pending.length
        },
        get passThroughOnExceptionCalled() {
            return passThrough
        },
        async settle() {
            const results = await Promise.allSettled(pending)
            const rejection = results.find((result) => result.status === 'rejected')
            if (rejection) throw rejection.reason
            return results
        },
    }
}

export function installFetchStub(t, fetchStub) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchStub
    t.after(() => {
        globalThis.fetch = originalFetch
    })
}

export async function invokeWorker(worker, path, options = {}) {
    const runtime = options.runtime ?? createWorkerContext()
    const request = path instanceof Request
        ? path
        : new Request(new URL(path, options.origin ?? 'https://worker.example'), options.request)
    const response = await worker.fetch(request, options.env, runtime.context)
    if (options.settle !== false) await runtime.settle()
    return { response, runtime }
}

export async function readJson(response) {
    const text = await response.text()
    return text ? JSON.parse(text) : null
}
