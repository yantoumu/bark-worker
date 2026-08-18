import { readFile } from 'node:fs/promises'

const requiredNames = new Set([
    'APP_MASTER_KEY',
    'ADMIN_BOOTSTRAP_TOKEN',
])

const payload = JSON.parse(await readFile(process.argv[2], 'utf8'))
if (!Array.isArray(payload)) throw new Error('Wrangler secret list did not return an array')
const configuredNames = new Set(payload.map((entry) => entry?.name).filter(Boolean))
const missing = [...requiredNames].filter((name) => !configuredNames.has(name))
if (missing.length > 0) {
    throw new Error('Missing required Cloudflare Worker secret names: ' + missing.join(', '))
}
console.log('Required Cloudflare Worker secret names are configured')
