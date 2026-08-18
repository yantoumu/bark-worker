import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const readJson = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))

test('Wrangler is reproducibly locked to exactly 4.123.0', async () => {
    const manifest = await readJson('package.json')
    const lock = await readJson('package-lock.json')

    assert.equal(manifest.devDependencies.wrangler, '4.123.0')
    assert.equal(lock.packages[''].devDependencies.wrangler, '4.123.0')
    assert.equal(lock.packages['node_modules/wrangler'].version, '4.123.0')
    assert.doesNotMatch(manifest.devDependencies.wrangler, /^[~^*><=]/)
})

test('verification scripts cover syntax, all tests, coverage thresholds, and a dry-run', async () => {
    const manifest = await readJson('package.json')
    const scripts = manifest.scripts

    for (const name of [
        'check:syntax',
        'test',
        'test:coverage',
        'test:coverage:d1',
        'test:coverage:kv',
        'deploy:dry-run',
        'verify',
    ]) {
        assert.equal(typeof scripts[name], 'string', `missing npm script ${name}`)
    }
    assert.match(scripts['test:coverage'], /test:coverage:d1\s*&&\s*npm run test:coverage:kv/)
    for (const [name, entrypoint] of [['test:coverage:d1', 'main.js'], ['test:coverage:kv', 'main_kv.js']]) {
        assert.match(scripts[name], new RegExp(`test-coverage-include=${entrypoint.replace('.', '\\.')}(?:\\s|$)`))
        assert.match(scripts[name], /test-coverage-lines=80/)
        assert.match(scripts[name], /test-coverage-branches=75/)
        assert.match(scripts[name], /test-coverage-functions=85/)
    }
    assert.doesNotMatch(scripts['test:coverage:d1'], /test-coverage-include=main_kv\.js/)
    assert.doesNotMatch(scripts['test:coverage:kv'], /test-coverage-include=main\.js(?:\s|$)/)
    assert.match(scripts.verify, /check:syntax/)
    assert.match(scripts.verify, /test:coverage/)
    assert.match(scripts.verify, /deploy:dry-run/)

    const syntaxVerifier = await readFile(new URL('../scripts/verify-syntax.mjs', import.meta.url), 'utf8')
    assert.match(syntaxVerifier, /['"]\.github\/scripts['"]/)
})

test('package lifecycle has no implicit install or remote-migration side effects', async () => {
    const manifest = await readJson('package.json')

    for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'predeploy']) {
        assert.equal(manifest.scripts[lifecycle], undefined, `${lifecycle} must not mutate developer or remote state implicitly`)
    }
})

test('GitHub deployment uses the lockfile, pinned actions, and minimum permissions', async () => {
    const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')

    assert.match(workflow, /branches:\s*\n\s*- master/)
    assert.match(workflow, /permissions:\s*\n\s*contents: read/)
    assert.match(workflow, /\bnpm ci\b/)
    assert.doesNotMatch(workflow, /npm install\s+(?:--global|-g)|wrangler-action@/)

    for (const line of workflow.split('\n').filter((candidate) => /^\s*uses:/.test(candidate))) {
        assert.match(line, /@[0-9a-f]{40}(?:\s|#|$)/, `action is not commit-pinned: ${line.trim()}`)
    }
})

test('Cloudflare credentials use secrets while the D1 identifier uses a variable', async () => {
    const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')

    assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*}}/)
    assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*}}/)
    assert.match(workflow, /D1_DATABASE_ID:\s*\$\{\{\s*vars\.CLOUDFLARE_D1_DATABASE_ID\s*}}/)
    assert.doesNotMatch(workflow, /wrangler\s+d1\s+create/i)
})

test('production workflow verifies and backs up before migration, then deploys before smoke', async () => {
    const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
    const productionStart = workflow.search(/^  deploy-production:\s*$/m)
    assert.ok(productionStart >= 0, 'deploy-production job is missing')
    const productionJob = workflow.slice(productionStart)
    const verify = workflow.indexOf('npm run verify')
    const backup = productionJob.search(/wrangler\s+d1\s+export|production D1 backup/i)
    const migration = productionJob.search(/wrangler\s+d1\s+migrations\s+apply/i)
    const deploy = productionJob.search(/wrangler\s+deploy\s*\n\s*--strict/i)
    const smoke = productionJob.search(/Run production smoke/i)

    assert.ok(verify >= 0, 'verification step is missing')
    assert.match(productionJob, /needs:\s*deploy-staging/, 'production must depend on the verified staging job')
    assert.ok(backup >= 0, 'production backup is missing')
    assert.ok(migration > backup, 'migration must occur after production backup')
    assert.ok(deploy > migration, 'deployment must occur after migration')
    assert.ok(smoke > deploy, 'smoke must occur after deployment')
})

test('test.sh is executable, valid Bash, local-only, assertion-based, and gates every side effect', async () => {
    const smokePath = fileURLToPath(new URL('../test.sh', import.meta.url))
    const smoke = await readFile(new URL('../test.sh', import.meta.url), 'utf8')
    await access(smokePath, constants.X_OK)
    const syntax = spawnSync('bash', ['-n', smokePath], { encoding: 'utf8' })

    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout)
    assert.match(smoke, /^#!\/usr\/bin\/env bash\nset -euo pipefail/m)
    assert.match(smoke, /--fail-with-body/)
    assert.match(smoke, /RUN_DESTRUCTIVE_TESTS/)
    assert.match(smoke, /refuses non-local targets/)
    assert.match(smoke, /DEVICE_KEY="\$\{DEVICE_KEY:-}"/)
    assert.match(smoke, /BASIC_AUTH="\$\{BASIC_AUTH:-}"/)
    assert.doesNotMatch(smoke, /\bcurl\s+\+\s+--/)
    assert.doesNotMatch(smoke, /admin:admin|0000test0device0token0000/)
})

test('production smoke DELETE sends the MCP protocol version negotiated by initialize', async () => {
    const smoke = await readFile(new URL('../.github/scripts/smoke.mjs', import.meta.url), 'utf8')
    const cleanupStart = smoke.indexOf("'MCP session cleanup'")
    assert.ok(cleanupStart >= 0, 'MCP cleanup request is missing')
    const cleanup = smoke.slice(cleanupStart, cleanupStart + 1_500)
    const header = cleanup.match(/['"]mcp-protocol-version['"]\s*:\s*([A-Za-z_$][\w$]*)/i)

    assert.ok(header, 'MCP DELETE must send MCP-Protocol-Version')
    assert.match(
        smoke,
        new RegExp(`${header[1]}\\s*=\\s*initializePayload(?:\\?\\.)?\\.result(?:\\?\\.)?\\.protocolVersion`),
        'cleanup protocol header must come from the initialize response',
    )
})

test('secret scanner rejects tracked non-example environment files', async (t) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'bark-secret-scan-'))
    t.after(() => rm(temporaryDirectory, { recursive: true, force: true }))
    const trackedFiles = ['.env.production', '.dev.vars']
    const privateKeyMarker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
    for (const filename of trackedFiles) {
        await writeFile(join(temporaryDirectory, filename), `APNS_PRIVATE_KEY=${privateKeyMarker}\n`, 'utf8')
    }

    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: temporaryDirectory, encoding: 'utf8' })
    assert.equal(initialized.status, 0, initialized.stderr)
    const added = spawnSync('git', ['add', '--force', '--', ...trackedFiles], {
        cwd: temporaryDirectory,
        encoding: 'utf8',
    })
    assert.equal(added.status, 0, added.stderr)

    const scannerPath = fileURLToPath(new URL('../.github/scripts/check-no-secrets.mjs', import.meta.url))
    const scan = spawnSync(process.execPath, [scannerPath], {
        cwd: temporaryDirectory,
        encoding: 'utf8',
    })
    const output = `${scan.stdout}\n${scan.stderr}`

    assert.notEqual(scan.status, 0, 'tracked environment files containing secrets must fail scanning')
    for (const filename of trackedFiles) assert.match(output, new RegExp(filename.replace('.', '\\.')))
})

test('deployment workflow gates production behind staging, encrypted backup, secret checks, and bounded rollback', async () => {
    const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
    const normalized = workflow.toLowerCase()
    const staging = normalized.search(/(?:deploy|smoke)[-_ ]+staging|staging[-_ ]+(?:deploy|smoke)/)
    const production = normalized.search(/deploy[-_ ]+production:/)
    const secretList = normalized.search(/wrangler\s+secret\s+list/)
    const migration = normalized.search(/wrangler\s+d1\s+migrations\s+apply/)
    const deploy = normalized.search(/wrangler\s+deploy\s*\n\s*--strict/)
    const rollback = normalized.search(/wrangler\s+rollback/)
    const upload = normalized.search(/upload[^\n]*encrypted[^\n]*d1[^\n]*backup|upload[^\n]*d1[^\n]*backup[^\n]*cipher/)
    const cleanup = normalized.search(/if:\s*\$\{\{\s*always\(\)\s*\}\}[\s\S]{0,500}rm\s+-f[^\n]*(?:backup|\.sql)/)

    assert.ok(staging >= 0, 'staging migration/deploy/smoke gate is missing')
    assert.ok(production > staging, 'production must depend on the staging gate')
    assert.ok(secretList >= 0 && secretList < migration, 'production secret-list gate must run before migration')
    assert.ok(upload >= 0, 'only an encrypted D1 backup artifact may be uploaded')
    assert.match(workflow, /BACKUP_(?:ENCRYPTION_(?:KEY|PASSPHRASE)|AGE_(?:IDENTITY|RECIPIENT))/)
    assert.ok(cleanup >= 0, 'plaintext backup must be removed in an always() cleanup step')
    assert.ok(rollback > deploy, 'rollback must be scoped to failures after Worker deployment')
    assert.match(workflow.slice(Math.max(0, rollback - 500), rollback + 500), /if:\s*\$\{\{[^\n]*failure\(\)/i)
    assert.doesNotMatch(workflow.slice(rollback, rollback + 500), /d1\s+(?:restore|execute)|\.sql/i)
})
