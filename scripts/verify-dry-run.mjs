import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const outputDirectory = await mkdtemp(join(tmpdir(), 'bark-worker-wrangler-'))
const require = createRequire(import.meta.url)
const wrangler = require.resolve('wrangler/bin/wrangler.js')

try {
    const result = spawnSync(
        process.execPath,
        [wrangler, 'deploy', '--dry-run', '--outdir', outputDirectory],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )

    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
    await rm(outputDirectory, { recursive: true, force: true })
}
