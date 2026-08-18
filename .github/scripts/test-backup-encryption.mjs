import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
await mkdir(path.join(root, '.backups'), { recursive: true })
const directory = await mkdtemp(path.join(root, '.backups', 'encryption-self-test-'))
const plaintext = path.join(directory, 'sample.sql')
const ciphertext = path.join(directory, 'sample.sql.enc')
const restored = path.join(directory, 'restored.sql')
const tampered = path.join(directory, 'tampered.sql.enc')
const rejected = path.join(directory, 'rejected.sql')
const key = randomBytes(32).toString('base64')
const environment = { ...process.env, D1_BACKUP_ENCRYPTION_KEY: key }

function run(script, input, output) {
    return spawnSync(process.execPath, [path.join(root, '.github', 'scripts', script), input, output], {
        cwd: root,
        env: environment,
        encoding: 'utf8',
    })
}

try {
    const sample = Buffer.concat([Buffer.from('CREATE TABLE test (value TEXT);\n'), randomBytes(64 * 1024)])
    await writeFile(plaintext, sample, { mode: 0o600 })
    const encrypted = run('encrypt-d1-backup.mjs', plaintext, ciphertext)
    if (encrypted.status !== 0) throw new Error('Backup encryption self-test failed')
    const decrypted = run('decrypt-d1-backup.mjs', ciphertext, restored)
    if (decrypted.status !== 0) throw new Error('Backup decryption self-test failed')
    if (!sample.equals(await readFile(restored))) throw new Error('Backup round-trip content mismatch')

    const altered = await readFile(ciphertext)
    altered[Math.floor(altered.length / 2)] ^= 0x01
    await writeFile(tampered, altered, { mode: 0o600 })
    const rejectedResult = run('decrypt-d1-backup.mjs', tampered, rejected)
    if (rejectedResult.status === 0) throw new Error('Tampered backup unexpectedly authenticated')
    try {
        await readFile(rejected)
        throw new Error('Failed authentication left plaintext output behind')
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    console.log('PASS backup encryption round-trip and authentication-tag rejection')
} finally {
    await rm(directory, { recursive: true, force: true })
}
