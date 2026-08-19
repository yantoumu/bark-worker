import assert from 'node:assert/strict'
import test from 'node:test'

import d1Worker from '../main.js'
import kvWorker from '../main_kv.js'
import { createTestEnv } from './helpers/worker-harness.js'
import { invokeWorker } from './helpers/worker-context.js'

for (const [name, worker] of [['D1', d1Worker], ['KV', kvWorker]]) {
    test(`${name} ads.txt is public and never triggers browser Basic Auth`, async () => {
        const env = await createTestEnv()

        for (const method of ['GET', 'HEAD']) {
            const { response } = await invokeWorker(worker, '/ads.txt', {
                env,
                request: { method, headers: { accept: 'text/plain,*/*' } },
            })

            assert.equal(response.status, 404)
            assert.match(response.headers.get('content-type') ?? '', /^text\/plain/)
            assert.equal(response.headers.get('www-authenticate'), null)
            assert.equal(response.headers.get('cache-control'), 'public, max-age=300')
            assert.equal(await response.text(), '')
        }
    })
}
