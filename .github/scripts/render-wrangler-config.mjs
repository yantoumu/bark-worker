import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const projectRoot = process.cwd()
const sourcePath = path.resolve(projectRoot, 'wrangler.jsonc')
const outputPath = path.resolve(
    projectRoot,
    process.env.WRANGLER_OUTPUT_CONFIG || '.wrangler/wrangler.production.jsonc',
)
const placeholderDatabaseId = '00000000-0000-0000-0000-000000000000'
const requiredSecrets = [
    'APP_MASTER_KEY',
    'ADMIN_BOOTSTRAP_TOKEN',
]
const strictVars = {
    SECURITY_MODE: 'strict',
    ALLOW_NEW_DEVICE: 'true',
    ALLOW_QUERY_NUMS: 'false',
    ALLOW_LEGACY_GET_REGISTER: 'true',
    LEGACY_GET_REGISTER_SUNSET: 'Fri, 31 Dec 2027 23:59:59 GMT',
    ALLOW_INSECURE_DEVICE_REBIND: 'false',
    MCP_ALLOWED_ORIGINS: '',
    ROOT_PATH: '/',
    MAX_REQUEST_BYTES: '32768',
    MAX_BATCH_SIZE: '20',
    BATCH_CONCURRENCY: '5',
    APNS_TIMEOUT_MS: '10000',
}
const rateLimitBudgets = {
    REGISTER_RATE_LIMITER: 5,
    PUSH_RATE_LIMITER: 60,
    BATCH_RATE_LIMITER: 10,
    MCP_RATE_LIMITER: 60,
    AUTH_RATE_LIMITER: 60,
}
const localRateLimitNamespaceBase = 1000

function rateLimitNamespaceIds(base) {
    return Object.fromEntries(
        Object.keys(rateLimitBudgets).map((name, index) => [name, String(base + index + 1)]),
    )
}

const localRateLimitNamespaceIds = rateLimitNamespaceIds(localRateLimitNamespaceBase)

function assert(condition, message) {
    if (!condition) {
        throw new Error(message)
    }
}

function parseRepositoryJsonc(text) {
    // The checked-in config uses full-line comments only. Strip exactly that
    // supported form instead of evaluating configuration as JavaScript.
    return JSON.parse(text.replace(/^\s*\/\/.*(?:\r?\n|$)/gm, ''))
}

function validateConfig(config, expectedDatabaseId, expectedRateLimitNamespaceIds, production) {
    assert(config && typeof config === 'object', 'Wrangler config must be an object')
    assert(config.keep_vars === false, 'keep_vars must remain false')

    if (production) {
        assert(
            Array.isArray(config.routes)
                && config.routes.length === 1
                && config.routes[0]?.pattern === 'bark.seo9.org'
                && config.routes[0]?.custom_domain === true,
            'Production must publish exactly the bark.seo9.org custom domain',
        )
    } else {
        assert(!('routes' in config), 'Non-production configs must not claim the production custom domain')
    }

    const databaseBindings = (config.d1_databases || []).filter(
        (binding) => binding.binding === 'database',
    )
    assert(databaseBindings.length === 1, 'Expected exactly one D1 binding named database')
    assert(
        databaseBindings[0].database_id === expectedDatabaseId,
        'D1 database ID was not replaced exactly',
    )

    const vars = config.vars || {}
    for (const [name, expectedValue] of Object.entries(strictVars)) {
        assert(vars[name] === expectedValue, 'Unsafe or missing default for ' + name)
    }
    for (const secretName of requiredSecrets) {
        assert(!(secretName in vars), secretName + ' must not be stored in vars')
    }
    const configuredSecrets = config.secrets?.required
    assert(Array.isArray(configuredSecrets), 'secrets.required must be an array')
    assert(
        configuredSecrets.length === requiredSecrets.length
            && requiredSecrets.every((name) => configuredSecrets.includes(name)),
        'secrets.required must contain the D1 vault root and bootstrap secret set',
    )

    const rateLimits = config.ratelimits || []
    assert(
        rateLimits.length === Object.keys(rateLimitBudgets).length,
        'Expected exactly five rate limit bindings',
    )
    const namespaceIds = new Set()
    for (const [name, limit] of Object.entries(rateLimitBudgets)) {
        const matches = rateLimits.filter((binding) => binding.name === name)
        assert(matches.length === 1, 'Expected exactly one binding named ' + name)
        const binding = matches[0]
        assert(
            typeof binding.namespace_id === 'string'
                && /^[1-9][0-9]*$/.test(binding.namespace_id),
            name + ' namespace_id must be a positive integer string',
        )
        assert(!namespaceIds.has(binding.namespace_id), 'Rate limit namespace IDs must be unique')
        namespaceIds.add(binding.namespace_id)
        assert(
            binding.namespace_id === expectedRateLimitNamespaceIds[name],
            'Unexpected rate limit namespace ID for ' + name,
        )
        assert(binding.simple?.limit === limit, 'Unexpected limit for ' + name)
        assert(binding.simple?.period === 60, 'Unexpected period for ' + name)
    }

    assert(
        Array.isArray(config.triggers?.crons)
            && config.triggers.crons.length === 1
            && config.triggers.crons[0] === '0 * * * *',
        'The hourly UTC Cron trigger must remain configured',
    )
}

function relativeConfigPath(outputDirectory, absoluteTarget) {
    const relativePath = path.relative(outputDirectory, absoluteTarget)
    return relativePath.split(path.sep).join('/')
}

const outputRelativePath = path.relative(projectRoot, outputPath)
assert(
    outputRelativePath !== '..'
        && !outputRelativePath.startsWith('..' + path.sep)
        && outputRelativePath.split(path.sep)[0] === '.wrangler',
    'Generated Wrangler config must stay inside the ignored .wrangler directory',
)

const databaseId = (process.env.D1_DATABASE_ID || '').trim().toLowerCase()
assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(databaseId),
    'D1_DATABASE_ID must be a canonical RFC 4122/RFC 9562 UUID',
)
assert(databaseId !== placeholderDatabaseId, 'D1_DATABASE_ID must not be the placeholder UUID')
const workerNameOverride = (process.env.WORKER_NAME || '').trim()
const rateLimitNamespaceBaseValue = (process.env.RATE_LIMIT_NAMESPACE_BASE || '').trim()
const productionRateLimitNamespaceBaseValue = (
    process.env.PRODUCTION_RATE_LIMIT_NAMESPACE_BASE || ''
).trim()
if (workerNameOverride) {
    assert(
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerNameOverride),
        'WORKER_NAME must be a valid lowercase Cloudflare Worker name',
    )
    assert(
        /^[1-9][0-9]*$/.test(rateLimitNamespaceBaseValue),
        'RATE_LIMIT_NAMESPACE_BASE must be a positive integer for a non-production Worker',
    )
    assert(
        /^[1-9][0-9]*$/.test(productionRateLimitNamespaceBaseValue),
        'PRODUCTION_RATE_LIMIT_NAMESPACE_BASE must be provided when rendering a non-production Worker',
    )
} else {
    assert(
        productionRateLimitNamespaceBaseValue === '',
        'PRODUCTION_RATE_LIMIT_NAMESPACE_BASE is only used to verify non-production isolation',
    )
}
if (rateLimitNamespaceBaseValue) {
    assert(
        /^[1-9][0-9]*$/.test(rateLimitNamespaceBaseValue),
        'RATE_LIMIT_NAMESPACE_BASE must be a positive integer',
    )
}

const sourceText = await readFile(sourcePath, 'utf8')
const placeholderCount = sourceText.split(placeholderDatabaseId).length - 1
assert(placeholderCount === 1, 'D1 database placeholder must occur exactly once')

const renderedText = sourceText.replace(placeholderDatabaseId, databaseId)
assert(!renderedText.includes(placeholderDatabaseId), 'D1 database placeholder remains after render')

const config = parseRepositoryJsonc(renderedText)
let expectedRateLimitNamespaceIds = localRateLimitNamespaceIds
if (workerNameOverride) {
    assert(workerNameOverride !== config.name, 'Environment Worker name must differ from the default production name')
    config.name = workerNameOverride
    delete config.routes
}
if (rateLimitNamespaceBaseValue) {
    const namespaceBase = Number(rateLimitNamespaceBaseValue)
    assert(
        Number.isSafeInteger(namespaceBase)
            && namespaceBase > 0
            && namespaceBase <= Number.MAX_SAFE_INTEGER - Object.keys(rateLimitBudgets).length,
        'RATE_LIMIT_NAMESPACE_BASE must safely allocate five consecutive namespace IDs',
    )
    expectedRateLimitNamespaceIds = rateLimitNamespaceIds(namespaceBase)
    for (const binding of config.ratelimits || []) {
        assert(binding.name in expectedRateLimitNamespaceIds, 'Unexpected rate limit binding name')
        binding.namespace_id = expectedRateLimitNamespaceIds[binding.name]
    }
}
if (workerNameOverride) {
    const productionNamespaceBase = Number(productionRateLimitNamespaceBaseValue)
    assert(
        Number.isSafeInteger(productionNamespaceBase)
            && productionNamespaceBase > 0
            && productionNamespaceBase <= Number.MAX_SAFE_INTEGER - Object.keys(rateLimitBudgets).length,
        'PRODUCTION_RATE_LIMIT_NAMESPACE_BASE must safely allocate five consecutive namespace IDs',
    )
    const productionIds = new Set(Object.values(rateLimitNamespaceIds(productionNamespaceBase)))
    assert(
        Object.values(expectedRateLimitNamespaceIds).every((id) => !productionIds.has(id)),
        'Staging and production rate limit namespace ranges must not overlap',
    )
}
validateConfig(config, databaseId, expectedRateLimitNamespaceIds, !workerNameOverride)

const sourceDirectory = path.dirname(sourcePath)
const outputDirectory = path.dirname(outputPath)
const sourceMain = path.resolve(sourceDirectory, config.main)
const sourceSchema = config.$schema
    ? path.resolve(sourceDirectory, config.$schema)
    : undefined
const databaseBinding = config.d1_databases.find((binding) => binding.binding === 'database')
const sourceMigrations = path.resolve(
    sourceDirectory,
    databaseBinding.migrations_dir || 'migrations',
)

config.main = relativeConfigPath(outputDirectory, sourceMain)
if (sourceSchema) {
    config.$schema = relativeConfigPath(outputDirectory, sourceSchema)
}
databaseBinding.migrations_dir = relativeConfigPath(outputDirectory, sourceMigrations)

await mkdir(outputDirectory, { recursive: true })
const temporaryPath = outputPath + '.tmp-' + process.pid
await writeFile(temporaryPath, JSON.stringify(config, null, 4) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
})
await rename(temporaryPath, outputPath)

const writtenText = await readFile(outputPath, 'utf8')
assert(!writtenText.includes(placeholderDatabaseId), 'Generated config contains the placeholder')
validateConfig(JSON.parse(writtenText), databaseId, expectedRateLimitNamespaceIds, !workerNameOverride)

console.log('Rendered and validated Wrangler config at ' + outputRelativePath)
