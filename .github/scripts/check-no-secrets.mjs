import { readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const projectRoot = process.cwd()
const excludedDirectories = new Set([
    '.git',
    '.wrangler',
    '.backups',
    'coverage',
    'node_modules',
])
const textExtensions = new Set([
    '.cjs',
    '.js',
    '.json',
    '.jsonc',
    '.md',
    '.mjs',
    '.sh',
    '.sql',
    '.yaml',
    '.yml',
])
const forbiddenPatterns = [
    {
        name: 'embedded private key',
        pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/g,
    },
    {
        name: 'hard-coded APNs credential constant',
        pattern: /\b(?:const|let|var)\s+(?:TOKEN_KEY|TEAM_ID|AUTH_KEY_ID)\s*=\s*['"`]/g,
    },
]

const gitFiles = spawnSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
})
if (gitFiles.status !== 0) {
    console.error('Secret scan failed: unable to enumerate tracked files')
    process.exit(1)
}
const trackedFiles = new Set(gitFiles.stdout.split('\0').filter(Boolean))

function isEnvironmentFile(name) {
    return name.startsWith('.dev.vars') || name.startsWith('.env')
}

function isExplicitExample(name) {
    return name.endsWith('.example')
}

function shouldInspect(filePath) {
    const name = path.basename(filePath)
    if (isEnvironmentFile(name)) {
        const relativePath = path.relative(projectRoot, filePath).split(path.sep).join('/')
        return isExplicitExample(name) || trackedFiles.has(relativePath)
    }
    return textExtensions.has(path.extname(name)) || name === '.dev.vars.example'
}

async function collectFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = []

    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            continue
        }

        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            if (!excludedDirectories.has(entry.name)) {
                files.push(...await collectFiles(fullPath))
            }
        } else if (entry.isFile() && shouldInspect(fullPath)) {
            files.push(fullPath)
        }
    }

    return files
}

const findings = []
for (const trackedFile of trackedFiles) {
    const name = path.basename(trackedFile)
    if (isEnvironmentFile(name) && !isExplicitExample(name)) {
        findings.push({
            file: trackedFile,
            line: 1,
            rule: 'tracked non-example environment file',
        })
    }
}
for (const filePath of await collectFiles(projectRoot)) {
    const content = await readFile(filePath, 'utf8')
    for (const rule of forbiddenPatterns) {
        rule.pattern.lastIndex = 0
        for (const match of content.matchAll(rule.pattern)) {
            const line = content.slice(0, match.index).split('\n').length
            findings.push({
                file: path.relative(projectRoot, filePath),
                line,
                rule: rule.name,
            })
        }
    }
}

if (findings.length > 0) {
    console.error('Secret scan failed:')
    for (const finding of findings) {
        console.error('  ' + finding.file + ':' + finding.line + ' (' + finding.rule + ')')
    }
    process.exit(1)
}

console.log('Secret scan passed without embedded APNs credentials or private keys')
