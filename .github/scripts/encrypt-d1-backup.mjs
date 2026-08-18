import { createCipheriv, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const magic = Buffer.from('BARKD1E1', 'ascii')
const nonce = randomBytes(12)
const authTagLength = 16

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

class EncryptTransform extends Transform {
    constructor(cipher) {
        super()
        this.cipher = cipher
        this.headerWritten = false
    }

    writeHeader() {
        if (!this.headerWritten) {
            this.push(magic)
            this.push(nonce)
            this.headerWritten = true
        }
    }

    _transform(chunk, _encoding, callback) {
        try {
            this.writeHeader()
            this.push(this.cipher.update(chunk))
            callback()
        } catch (error) {
            callback(error)
        }
    }

    _flush(callback) {
        try {
            this.writeHeader()
            this.push(this.cipher.final())
            const tag = this.cipher.getAuthTag()
            if (tag.length !== authTagLength) fail('Unexpected AES-GCM authentication tag length')
            this.push(tag)
            callback()
        } catch (error) {
            callback(error)
        }
    }
}

const inputPath = backupPath(process.argv[2], 'Plaintext backup path')
const outputPath = backupPath(process.argv[3], 'Encrypted backup path')
if (inputPath === outputPath || !outputPath.endsWith('.enc')) {
    fail('Encrypted backup must use a distinct .enc output path')
}
const inputStat = await lstat(inputPath)
if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size === 0) {
    fail('Plaintext backup must be a non-empty regular file')
}

const key = encryptionKey()
process.umask(0o077)
await mkdir(path.dirname(outputPath), { recursive: true })
try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength })
    const outputHandle = await open(outputPath, 'wx', 0o600)
    let completed = false
    try {
        await pipeline(
            createReadStream(inputPath),
            new EncryptTransform(cipher),
            outputHandle.createWriteStream(),
        )
        completed = true
    } finally {
        if (!completed) await rm(outputPath, { force: true })
    }
    console.log('Production D1 backup encrypted with AES-256-GCM')
} catch (error) {
    throw error
} finally {
    key.fill(0)
}
