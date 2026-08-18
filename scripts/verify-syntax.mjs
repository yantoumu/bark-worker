import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { extname, join } from 'node:path'

const roots = ['main.js', 'main_kv.js', 'test', 'scripts', '.github/scripts']
const files = []

async function collect(path) {
    if (extname(path) === '.js' || extname(path) === '.mjs') {
        files.push(path)
        return
    }

    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
        if (entry.name === 'node_modules') continue
        const child = join(path, entry.name)
        if (entry.isDirectory()) await collect(child)
        else if (entry.isFile() && ['.js', '.mjs'].includes(extname(entry.name))) files.push(child)
    }
}

for (const root of roots) await collect(root)

for (const file of files.sort()) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout)
        process.exit(result.status ?? 1)
    }
}

console.log(`Syntax OK: ${files.length} JavaScript files`)
