import { createDecipheriv, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const magic = Buffer.from('BARKD1E1', 'ascii')
const nonceLength = 12
const authTagLength = 16
const headerLength = magic.length + nonceLength

function fail(message) {
    throw new Error(message)
}

function backupPath(value, label) {
    if (!value) fail(label + ' is required')
    const backupRoot = path.resolve(process.cwd(), '.backups')
    const resolved = path.resolve(process.cwd(), value)
    const relative = path.relative(backupRoot, resolved)
    if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        fail(label + ' must be a file inside .backups')
    }
    return resolved
}

function encryptionKey() {
    const encoded = process.env.D1_BACKUP_ENCRYPTION_KEY || ''
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
        fail('D1_BACKUP_ENCRYPTION_KEY must be canonical Base64 for exactly 32 bytes')
    }
    const key = Buffer.from(encoded, 'base64')
    if (key.length !== 32 || key.toString('base64') !== encoded) {
        fail('D1_BACKUP_ENCRYPTION_KEY must be canonical Base64 for exactly 32 bytes')
    }
    return key
}

async function readExactly(handle, buffer, position) {
    let offset = 0
    while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            position + offset,
        )
        if (bytesRead === 0) fail('Encrypted backup ended unexpectedly')
        offset += bytesRead
    }
}

const inputPath = backupPath(process.argv[2], 'Encrypted backup path')
const outputPath = backupPath(process.argv[3], 'Restored plaintext path')
if (inputPath === outputPath || !inputPath.endsWith('.enc') || outputPath.endsWith('.enc')) {
    fail('Restore requires distinct .enc input and plaintext output paths')
}
const inputStat = await lstat(inputPath)
if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size <= headerLength + authTagLength) {
    fail('Encrypted backup is not a valid non-empty regular file')
}

const inputHandle = await open(inputPath, 'r')
const header = Buffer.alloc(headerLength)
const authTag = Buffer.alloc(authTagLength)
try {
    await readExactly(inputHandle, header, 0)
    await readExactly(inputHandle, authTag, inputStat.size - authTagLength)
} finally {
    await inputHandle.close()
}
if (!timingSafeEqual(header.subarray(0, magic.length), magic)) {
    fail('Encrypted backup header is invalid')
}

const key = encryptionKey()
process.umask(0o077)
try {
    const nonce = header.subarray(magic.length)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength })
    decipher.setAuthTag(authTag)
    const outputHandle = await open(outputPath, 'wx', 0o600)
    let completed = false
    try {
        await pipeline(
            createReadStream(inputPath, {
                start: headerLength,
                end: inputStat.size - authTagLength - 1,
            }),
            decipher,
            outputHandle.createWriteStream(),
        )
        completed = true
    } finally {
        if (!completed) await rm(outputPath, { force: true })
    }
    console.log('Production D1 backup decrypted and authenticated')
} finally {
    key.fill(0)
}
