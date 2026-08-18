const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function delayedResponseBody(body, milliseconds, signal) {
    const bytes = new TextEncoder().encode(body ?? '')
    let timer
    let abort

    return new ReadableStream({
        start(controller) {
            let settled = false
            const cleanup = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', abort)
            }
            abort = () => {
                if (settled) return
                settled = true
                cleanup()
                const error = new Error('The operation was aborted while reading the response body')
                error.name = 'AbortError'
                controller.error(error)
            }
            timer = setTimeout(() => {
                if (settled) return
                settled = true
                cleanup()
                controller.enqueue(bytes)
                controller.close()
            }, milliseconds)
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) abort()
        },
        cancel() {
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
        },
    })
}

export const apnsScenario = {
    success: (options = {}) => ({ status: 200, body: null, ...options }),
    status: (status, reason, options = {}) => ({
        status,
        body: reason === undefined ? null : JSON.stringify({ reason }),
        ...options,
    }),
    emptyBody: (status = 400, options = {}) => ({ status, body: null, ...options }),
    invalidJson: (status = 400, options = {}) => ({ status, body: '{not-json', ...options }),
    jsonWithoutReason: (status = 400, options = {}) => ({ status, body: '{}', ...options }),
    delayedErrorBody: (status = 400, reason = 'BadDeviceToken', options = {}) => ({
        status,
        body: JSON.stringify({ reason }),
        bodyDelayMs: 1250,
        ...options,
    }),
    networkError: (message = 'simulated network refusal') => ({ networkError: new TypeError(message) }),
    timeout: (options = {}) => ({ timeout: true, safetyMs: 1250, ...options }),
}

export function createAPNsStub(options = {}) {
    const requests = []
    let active = 0
    let maxActive = 0

    const resolveScenario = (url, init, index) => {
        if (typeof options.scenario === 'function') return options.scenario({ url, init, index })
        return options.scenario ?? apnsScenario.success()
    }

    const fetch = async (url, init = {}) => {
        const index = requests.length
        const record = { url: String(url), init, startedAt: Date.now(), finishedAt: null }
        requests.push(record)
        active += 1
        maxActive = Math.max(maxActive, active)

        try {
            const scenario = await resolveScenario(String(url), init, index)
            if (scenario.delayMs) await delay(scenario.delayMs)
            if (scenario.networkError) throw scenario.networkError

            if (scenario.timeout) {
                await new Promise((resolve, reject) => {
                    let timer
                    const abort = () => {
                        clearTimeout(timer)
                        const error = new Error('The operation was aborted')
                        error.name = 'AbortError'
                        reject(error)
                    }

                    if (init.signal?.aborted) return abort()
                    init.signal?.addEventListener('abort', abort, { once: true })
                    timer = setTimeout(() => {
                        init.signal?.removeEventListener('abort', abort)
                        reject(new Error('APNs stub safety timeout: AbortSignal was not used'))
                    }, scenario.safetyMs)
                })
            }

            const responseBody = scenario.bodyDelayMs
                ? delayedResponseBody(scenario.body, scenario.bodyDelayMs, init.signal)
                : scenario.body ?? null
            return new Response(responseBody, {
                status: scenario.status ?? 200,
                headers: scenario.headers,
            })
        } finally {
            active -= 1
            record.finishedAt = Date.now()
        }
    }

    return {
        fetch,
        requests,
        get active() {
            return active
        },
        get maxActive() {
            return maxActive
        },
        payload(index = 0) {
            return JSON.parse(requests[index].init.body)
        },
    }
}
