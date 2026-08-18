import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const outputDirectory = await mkdtemp(join(tmpdir(), 'bark-worker-wrangler-'))
const wrangler = fileURLToPath(new URL(
    process.platform === 'win32'
        ? '../node_modules/.bin/wrangler.cmd'
        : '../node_modules/.bin/wrangler',
    import.meta.url,
))

try {
    const result = spawnSync(
        wrangler,
        ['deploy', '--dry-run', '--outdir', outputDirectory],
        {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                CI: 'true',
                WRANGLER_SEND_METRICS: 'false',
            },
        },
    )

    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
    await rm(outputDirectory, { recursive: true, force: true })
}
