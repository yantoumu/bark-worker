# Secure setup guide

This guide describes a new deployment. It does not mean that any Worker, database, secret, APNs key, migration, or canary has already been created or verified.

> [!IMPORTANT]
> `main.js` is the default D1 production entrypoint selected by `wrangler.jsonc` and the GitHub Actions workflow. `main_kv.js` is a separate, manually configured KV compatibility entrypoint. It has no MCP support and is not deployed by the default configuration.

## 1. Prerequisites

You need:

- A Cloudflare account with Workers and D1 access.
- An Apple Developer APNs signing key authorized for the configured topic.
- Node.js at the version used by CI and npm with lockfile support.
- A strong Basic Auth value in the exact `username:password` form expected by your clients.

Review `package.json` before installing dependencies. This repository uses the committed lockfile and a project-local Wrangler; install with `npm ci`. Do not install a separate global Wrangler.

```sh
npm ci
npx wrangler login
```

## 2. Create and bind D1

Create the production database once, outside the daily deployment workflow:

```sh
npx wrangler d1 create database-bark
```

The binding name must be `database`. The committed `wrangler.jsonc` deliberately contains one placeholder database UUID. For a manual deployment, render an ignored configuration under `.wrangler/` with the real canonical UUID, or maintain an equivalent untracked environment-specific configuration. Do not commit a production-specific rendered file. CI reads the UUID from the GitHub Variable `CLOUDFLARE_D1_DATABASE_ID` and validates that exactly one placeholder is replaced.

Do not create D1 from CI. Use separate databases for staging and production.

## 3. Configure runtime secrets

The following values are runtime credentials and must be stored as Cloudflare Secrets:

| Secret | Purpose |
| --- | --- |
| `BASIC_AUTH` | Exact Basic Auth credential pair in `username:password` form |
| `APNS_PRIVATE_KEY` | APNs PKCS#8 private signing key |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_KEY_ID` | APNs signing Key ID |
| `APNS_TOPIC` | APNs topic authorized for the key |

Set each value through Wrangler's interactive prompt so the value is not placed in a shell argument or command history:

```sh
npx wrangler secret put BASIC_AUTH
npx wrangler secret put APNS_PRIVATE_KEY
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TOPIC
```

Select the intended environment/configuration when running these commands. Never place these values in `vars`, source files, workflow inputs, URLs, logs, issues, or screenshots. For local development, copy `.dev.vars.example` to the ignored `.dev.vars` file and replace placeholders locally; never commit that file.

Missing required secrets fail closed. Protected routes return a configuration error, and `/healthz` returns HTTP 503 rather than silently allowing anonymous access.

### APNs key incident rule

If an APNs private key has ever appeared in source, Git history, logs, or a shared artifact, treat it as compromised. Revoke it in Apple Developer, create a replacement, update the Cloudflare Secret, and verify the replacement on staging. Deleting the old text from the repository is not a rotation, and the old key must not be re-enabled as a rollback.

## 4. Configure non-secret variables

Non-secret settings belong in Wrangler `vars`. Boolean settings accept only the lowercase strings `"true"` or `"false"`; any other spelling is a configuration error.

| Variable | Secure default | Meaning |
| --- | --- | --- |
| `SECURITY_MODE` | `strict` | `strict` or the explicit, temporary `compat` migration mode |
| `ALLOW_NEW_DEVICE` | `true` | Permit authenticated creation of a previously unknown key |
| `ALLOW_QUERY_NUMS` | `false` | Allow authenticated `/info` to query device counts |
| `ALLOW_LEGACY_GET_REGISTER` | `false` | Enable deprecated GET registration only during migration |
| `LEGACY_GET_REGISTER_SUNSET` | unset | Required with legacy GET; must be a valid HTTP-date used in the `Sunset` response header |
| `ALLOW_INSECURE_DEVICE_REBIND` | `false` | Compat-only, temporary unauthenticated rebind escape hatch |
| `ROOT_PATH` | `/` | `/` or an absolute mount path; trailing slashes are normalized |
| `MAX_REQUEST_BYTES` | `32768` | Maximum streamed HTTP request body in bytes |
| `MAX_BATCH_SIZE` | `20` | Maximum unique devices in one batch |
| `BATCH_CONCURRENCY` | `5` | Maximum simultaneous APNs calls |
| `APNS_TIMEOUT_MS` | `10000` | APNs timeout; valid range 1000–30000 ms |
| `MCP_ALLOWED_ORIGINS` | unset | Comma-separated exact MCP origins; see below |

`SECURITY_MODE="strict"` requires Basic Auth for registration, push, MCP, and `/info`. Use `compat` only for a measured migration with an owner and exit date; it never disables MCP authentication.

If `ALLOW_LEGACY_GET_REGISTER="true"`, `LEGACY_GET_REGISTER_SUNSET` must also contain a valid HTTP-date. Missing or invalid values are configuration errors. Do not invent a date in automation: select and document the actual migration deadline. GET responses include that `Sunset` value plus deprecation and no-cache headers.

`MCP_ALLOWED_ORIGINS` is a comma-separated list of exact origins after trimming. Each entry is `scheme://host[:port]`; wildcards are not supported. A non-browser client may omit `Origin`. If a request does send `Origin`, an empty allowlist or a non-exact match is rejected with HTTP 403.

## 5. Configure abuse controls and hard limits

The D1 Wrangler configuration declares four Rate Limiting bindings:

| Binding | Budget |
| --- | ---: |
| `REGISTER_RATE_LIMITER` | 5 requests per 60 seconds per registration subject |
| `PUSH_RATE_LIMITER` | 60 requests per 60 seconds per device key |
| `BATCH_RATE_LIMITER` | 10 requests per 60 seconds per authenticated subject |
| `MCP_RATE_LIMITER` | 60 requests per 60 seconds per session/subject |

Cloudflare evaluates these counters locally per data center and propagates them with eventual consistency. They reduce abuse but are not exact global quotas. Keep the synchronous hard limits enabled: 32 KiB request bodies, 20 devices per batch, five APNs calls in parallel, and 4096 UTF-8 bytes for the final APNs JSON payload.

Rate Limiting namespace IDs are account-scoped. The checked-in `1001` through `1004` values are local dry-run defaults, not proof that those IDs are free in an account. Reserve two non-overlapping blocks of four consecutive IDs, set `STAGING_RATE_LIMIT_NAMESPACE_BASE` and `PRODUCTION_RATE_LIMIT_NAMESPACE_BASE` to their bases, and the renderer assigns `base+1` through `base+4`. CI rejects overlap between those two rendered ranges, but it cannot discover IDs used by other Workers. Record both reservations and verify account-wide uniqueness before deployment.

## 6. Apply D1 migrations

The SQL files under `migrations/` are the authoritative schema history. Apply them locally first:

```sh
npm run db:migrate
npm run verify
```

Before a remote production migration, export a recoverable D1 backup to the ignored `.backups/` directory, immediately encrypt it, remove the plaintext, then apply migrations with the same rendered production configuration that deployment will use. `D1_BACKUP_ENCRYPTION_KEY` must already be present in the protected environment as canonical Base64 for exactly 32 random bytes; never paste it into the command line. Do not print database rows containing device data during validation.

```sh
mkdir -p .backups
umask 077
npx wrangler d1 export database --remote --config .wrangler/wrangler.production.jsonc --output=.backups/bark-before-migration.sql
node .github/scripts/encrypt-d1-backup.mjs .backups/bark-before-migration.sql .backups/bark-before-migration.sql.enc
rm -f -- .backups/bark-before-migration.sql
npx wrangler d1 migrations apply database --remote --config .wrangler/wrangler.production.jsonc
```

Keep a separately controlled recovery copy of the encryption key: GitHub Environment Secrets cannot be read back. To authenticate and decrypt a downloaded artifact, load that recovery key into the environment through the approved secret manager, then run:

```sh
node .github/scripts/decrypt-d1-backup.mjs \
  .backups/bark-before-migration.sql.enc \
  .backups/bark-restored.sql
```

Decryption verifies the AES-256-GCM authentication tag and removes any partial plaintext when authentication fails. Inspect and rehearse the restored SQL in an isolated local D1 before any controlled recovery; CI never restores production D1 automatically.

AutoMigrate remains an awaited, idempotent fallback for first-run/manual-copy scenarios. Every D1-dependent request waits for schema readiness, and a failure returns HTTP 503. AutoMigrate does not replace Wrangler's migration ledger and must not be used as the normal production migration mechanism.

The default D1 deployment also registers `0 * * * *`. Cloudflare Cron uses UTC, so the scheduled handler runs once at every UTC hour to clean expired MCP sessions. Session cleanup does not run in the HTTP request path.

## 7. Verify, deploy, then smoke-test

The minimum local gate is:

```sh
npm run verify
```

This checks syntax, the full test suite with coverage thresholds, and a local Wrangler dry run. CI additionally runs the repository secret scan. A passing dry run proves only that the local artifact/configuration can be built; it is not a production deployment.

Keep the remote sequence one-way:

1. Verify and dry-run the exact rendered configuration.
2. Back up the target D1 database.
3. Apply additive D1 migrations.
4. Deploy the Worker.
5. Run bounded smoke checks and inspect logs without exposing credentials or device data.

Start with public, non-mutating checks:

```sh
curl --fail-with-body "$BARK_BASE_URL/ping"
curl --fail-with-body "$BARK_BASE_URL/healthz"
```

Registration, push, and MCP smoke checks are side-effecting or authenticated. Run them only through the repository's gated smoke tooling with secrets supplied by the environment. Do not type a real device key, token, Basic Auth value, or MCP session ID into a URL or terminal command, and do not capture them in screenshots.

### Registration migration

Use `POST /register` from the Bark app or another client that keeps sensitive values in the request body. The request shape is:

```http
POST /register
Authorization: Basic <redacted>
Content-Type: application/json

{"device_key":"<read from protected client storage>","device_token":"<read from protected client storage>"}
```

Legacy `key` and `devicetoken` body fields remain accepted. Do not use the deprecated GET query format. For an existing key, the same token is an idempotent success; changing the token requires authentication. An unauthenticated change returns HTTP 409 unless the compat-only insecure rebind escape hatch has been deliberately enabled.

## 8. GitHub Actions production gate

Create separate protected GitHub Environments named `staging` and `production`; require reviewer approval for production. Configure:

- Repository-level GitHub Variables: `STAGING_RATE_LIMIT_NAMESPACE_BASE` and `PRODUCTION_RATE_LIMIT_NAMESPACE_BASE`. Keep one shared source of truth; do not override either value at the staging or production Environment level, or the isolation comparison can observe different values.
- Staging Environment Variables: `STAGING_WORKER_NAME`, `STAGING_D1_DATABASE_ID`, and `STAGING_SMOKE_URL`.
- Production Environment Variables: `CLOUDFLARE_D1_DATABASE_ID` and `PRODUCTION_SMOKE_URL`.
- GitHub Secrets in the applicable Environment: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and the smoke credentials referenced by the workflow. Production also requires `D1_BACKUP_ENCRYPTION_KEY`.
- Cloudflare Worker Secrets: the five runtime secrets listed above, separately for each environment.

The gate keeps production behind verify → staging migration → staging deploy → staging smoke → production secret-name check/version capture → encrypted backup → production migration → production deploy → production smoke. Only ciphertext is uploaded as a one-day artifact; plaintext is removed immediately and again in an `always()` cleanup. The workflow uses `npm ci`, the repository-local pinned Wrangler, read-only repository permission, and the `master` branch. Production D1 creation is a one-time bootstrap action and must never be added to CI.

## 9. Manual KV compatibility deployment

To keep using `main_kv.js`, create a separate Worker configuration whose entrypoint is `main_kv.js` and whose KV namespace binding is named `database`. Reproduce the applicable Secrets, strict variables, registration/push rate limiters, request limits, and environment separation described above.

This is a manual compatibility path, not an alternative selected by the checked-in Wrangler configuration or workflow. It does not provide MCP, D1 migrations, D1 AutoMigrate, or D1 session Cron behavior. Do not describe a KV deployment as equivalent to the default D1 production service.

## 10. Rollback boundary

Record the previous Worker version before deployment. A production smoke failure after deployment rolls the Worker back to that version, but it never restores D1; migrations therefore remain additive and compatible with the prior Worker. Never roll back to a revoked or exposed APNs key.
