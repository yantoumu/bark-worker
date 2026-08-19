<p align="center">
    <h1 align="center">Bark-Worker</h1>
</p>

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

English | **[中文文档](README.zh.md)**

Bark-Worker is a [Bark server](https://github.com/Finb/bark-server) implementation for Cloudflare Workers. It provides a small, self-hosted backend for sending notifications to the [Bark iOS app](https://github.com/Finb/Bark).

Production endpoint: `https://bark.seo9.org`; administration console: `https://bark.seo9.org/admin`.

> [!IMPORTANT]
> `main.js` is the default production entrypoint. The checked-in Wrangler configuration and deployment workflow target this D1 version. `main_kv.js` is a manually deployed legacy KV entrypoint: it has no D1 user login, encrypted APNs vault, or MCP support and is not selected by the default deployment path.

## Interfaces

- `GET /ping`: public liveness check.
- `GET /healthz`: readiness check with no sensitive configuration details.
- `GET /admin`: responsive D1 administration console for login, user creation, and encrypted APNs credential management.
- `GET /info`: authenticated service information; device counts are hidden unless `ALLOW_QUERY_NUMS="true"`.
- `POST /auth/setup`: create the first D1 administrator with the one-time bootstrap token; permanently rejects once a user exists.
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, and `GET /auth/session`: create, revoke, and inspect short-lived Bearer or browser sessions.
- `POST /admin/users`: administrators add D1 users; passwords are stored only as salted, peppered PBKDF2-SHA256 hashes.
- `GET/PUT /admin/apns`: administrators inspect or replace AES-256-GCM-encrypted APNs credentials; reads never return the private key or ciphertext.
- `POST /register`: primary registration interface. It accepts JSON or form fields `device_key` and `device_token`, plus the legacy aliases `key` and `devicetoken`.
- `POST /push`: JSON or form push interface, including bounded batch pushes.
- Path-style Bark push: existing GET and POST paths remain supported for client compatibility.
- `POST /mcp` and `DELETE /mcp`: D1-only MCP Streamable HTTP lifecycle; see [MCP](doc/mcp.md).

Batch mode takes precedence when a non-empty `device_keys` value is supplied. The outer batch response remains HTTP 200 for Bark compatibility and includes per-item results plus `success_count`, `failed_count`, and `partial_failure`.

## Secure defaults

The repository configuration defaults to `SECURITY_MODE="strict"`. In strict mode, registration, push, MCP, and `/info` require authentication, while `/ping` remains public. Existing clients can keep using HTTP Basic, but credentials are now verified against D1 users; Bearer sessions returned by login are also accepted. The D1 entrypoint no longer reads a `BASIC_AUTH` environment variable.

The administration console never stores its token in `localStorage` or `sessionStorage`. It uses a short-lived `__Host-`-prefixed, HttpOnly, Secure, SameSite=Strict cookie that is accepted only by browser-auth and administration routes. Cookie-authenticated mutations also require an exact same-origin `Origin`; the cookie cannot replace client authentication for registration, push, MCP, or `/info`.

Runtime credentials are Cloudflare Secrets, never Wrangler `vars` or source constants:

- `APP_MASTER_KEY`: canonical Base64 for 32 random bytes, used to derive the password pepper and APNs AES-GCM key.
- `ADMIN_BOOTSTRAP_TOKEN`: an at-least-32-byte one-time first-administrator setup token.

User records, login-token hashes, and APNs ciphertext live in D1. Passwords are irreversible. The APNs key must be decrypted, so `APP_MASTER_KEY` stays only in a Cloudflare Secret and must also be backed up in an independent secret manager. Storing that root key beside the ciphertext in D1 would provide no protection.

Only the lowercase strings `"true"` and `"false"` are accepted for boolean configuration. A misspelling such as `"False"` is a configuration error. `SECURITY_MODE="compat"` is an explicit, temporary migration mode; it is not the recommended production default and never disables MCP authentication.

The primary registration method is `POST /register`. Legacy GET registration is disabled unless `ALLOW_LEGACY_GET_REGISTER="true"`; enabling it also requires `LEGACY_GET_REGISTER_SUNSET` to be a valid HTTP-date. Missing or invalid dates are configuration errors. Enabled responses carry `Deprecation`, the configured `Sunset`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`. Treat that `Sunset` value as the migration deadline. Do not put a real device token or key in a URL, terminal history, log, support ticket, or screenshot.

Existing-key behavior is deliberately conservative:

- The same key and token is an idempotent success.
- A different token requires valid D1 user authentication (Basic or Bearer).
- An unauthenticated rebind is rejected with HTTP 409.
- `ALLOW_INSECURE_DEVICE_REBIND="true"` is a migration-only escape hatch valid only with `SECURITY_MODE="compat"`; keep it off unless a bounded, monitored migration requires it.

## Resource budgets

| Boundary | Default |
| --- | ---: |
| Request body | 32 KiB (`MAX_REQUEST_BYTES="32768"`) |
| Final APNs JSON payload | 4096 UTF-8 bytes |
| Devices per batch | 20 (`MAX_BATCH_SIZE="20"`) |
| Concurrent APNs calls | 5 (`BATCH_CONCURRENCY="5"`) |
| APNs timeout | 10 seconds (`APNS_TIMEOUT_MS="10000"`, valid range 1–30 seconds) |

The five Cloudflare Rate Limiting bindings are `REGISTER_RATE_LIMITER` (5/60 seconds), `PUSH_RATE_LIMITER` (60/60 seconds), `BATCH_RATE_LIMITER` (10/60 seconds), `MCP_RATE_LIMITER` (60/60 seconds), and `AUTH_RATE_LIMITER` (60/60 seconds per IP/user for D1 Basic verification). Their counters are data-center-local and eventually consistent, so they are an abuse-control layer—not an exact global quota or a replacement for the synchronous body, batch, concurrency, and APNs payload limits.

## Storage and lifecycle

D1 migrations in `migrations/` are the authoritative production schema history and must be applied before deploying code that depends on them. Awaited AutoMigrate is an idempotent fallback for first-run or manually copied deployments; it does not replace migration records. D1-backed routes return HTTP 503 when schema readiness fails.

Expired MCP and login sessions are cleaned by the D1 entrypoint's scheduled handler at `0 * * * *`—once per hour in UTC. HTTP requests do not run session cleanup.

The complete APNs credential set is stored as one AES-256-GCM D1 record. The Worker decrypts it only for pushes, while provider JWTs remain isolate-memory-only. Missing or undecryptable credentials fail pushes with HTTP 503. Any APNs signing key previously exposed in source or history must be revoked and rotated in Apple Developer; never place that old key into the vault.

## Deployment

Use the [secure setup guide](doc/setup_guide.md) to create D1 outside CI, configure the `database` binding, install Cloudflare Secrets interactively, apply migrations, verify locally, and deploy. Do not treat a generated bundle, dry run, or successful unit test as evidence that production was deployed or that an APNs key was rotated.

Additional operating and migration guidance is in [Tips](doc/tips.md). MCP clients should read the [MCP lifecycle and security contract](doc/mcp.md) before connecting.
