import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const directory = await mkdtemp(path.join(os.tmpdir(), 'bark-version-fixture-'))
const validVersion = '12345678-1234-5678-9abc-1234567890ab'

function extract(fixturePath) {
    return spawnSync(
        process.execPath,
        [path.join(root, '.github', 'scripts', 'extract-active-version.mjs'), fixturePath],
        { cwd: root, encoding: 'utf8' },
    )
}

try {
    const validFixture = path.join(directory, 'valid.json')
    await writeFile(validFixture, JSON.stringify({
        versions: [{ version_id: validVersion, percentage: 100 }],
    }))
    const validResult = extract(validFixture)
    if (validResult.status !== 0 || validResult.stdout !== validVersion) {
        throw new Error('Canonical 8-4-4-4-12 Worker version fixture was rejected')
    }

    const invalidFixture = path.join(directory, 'invalid.json')
    await writeFile(invalidFixture, JSON.stringify({
        versions: [{ version_id: '12345678-1234-5678-9abc-1234567890a', percentage: 100 }],
    }))
    const invalidResult = extract(invalidFixture)
    if (invalidResult.status === 0) {
        throw new Error('Malformed Worker version fixture was accepted')
    }

    console.log('PASS active Worker version UUID fixtures')
} finally {
    await rm(directory, { recursive: true, force: true })
}
