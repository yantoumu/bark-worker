<p align="center">
    <h1 align="center">Bark-Worker</h1>
</p>

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

English | **[中文文档](README.zh.md)**

Bark-Worker is a [Bark server](https://github.com/Finb/bark-server) implementation for Cloudflare Workers. It provides a small, self-hosted backend for sending notifications to the [Bark iOS app](https://github.com/Finb/Bark).

> [!IMPORTANT]
> `main.js` is the default production entrypoint. The checked-in Wrangler configuration and deployment workflow target this D1 version. `main_kv.js` remains a manually deployed KV compatibility entrypoint: it has no MCP support and is not selected by the default deployment path. Common authentication, registration, validation, APNs, and error-handling security behavior is still maintained in both entrypoints.

## Interfaces

- `GET /ping`: public liveness check.
- `GET /healthz`: readiness check with no sensitive configuration details.
- `GET /info`: authenticated service information; device counts are hidden unless `ALLOW_QUERY_NUMS="true"`.
- `POST /register`: primary registration interface. It accepts JSON or form fields `device_key` and `device_token`, plus the legacy aliases `key` and `devicetoken`.
- `POST /push`: JSON or form push interface, including bounded batch pushes.
- Path-style Bark push: existing GET and POST paths remain supported for client compatibility.
- `POST /mcp` and `DELETE /mcp`: D1-only MCP Streamable HTTP lifecycle; see [MCP](doc/mcp.md).

Batch mode takes precedence when a non-empty `device_keys` value is supplied. The outer batch response remains HTTP 200 for Bark compatibility and includes per-item results plus `success_count`, `failed_count`, and `partial_failure`.

## Secure defaults

The repository configuration defaults to `SECURITY_MODE="strict"`. In strict mode, registration, push, MCP, and `/info` require HTTP Basic authentication. `/ping` remains public. A missing `BASIC_AUTH` fails closed: protected routes and readiness return a configuration error instead of allowing anonymous access.

Runtime credentials are Cloudflare Secrets, never Wrangler `vars` or source constants:

- `BASIC_AUTH`
- `APNS_PRIVATE_KEY`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_TOPIC`

Only the lowercase strings `"true"` and `"false"` are accepted for boolean configuration. A misspelling such as `"False"` is a configuration error. `SECURITY_MODE="compat"` is an explicit, temporary migration mode; it is not the recommended production default and never disables MCP authentication.

The primary registration method is `POST /register`. Legacy GET registration is disabled unless `ALLOW_LEGACY_GET_REGISTER="true"`; enabling it also requires `LEGACY_GET_REGISTER_SUNSET` to be a valid HTTP-date. Missing or invalid dates are configuration errors. Enabled responses carry `Deprecation`, the configured `Sunset`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`. Treat that `Sunset` value as the migration deadline. Do not put a real device token or key in a URL, terminal history, log, support ticket, or screenshot.

Existing-key behavior is deliberately conservative:

- The same key and token is an idempotent success.
- A different token requires valid Basic Auth.
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

The four Cloudflare Rate Limiting bindings are `REGISTER_RATE_LIMITER` (5/60 seconds), `PUSH_RATE_LIMITER` (60/60 seconds), `BATCH_RATE_LIMITER` (10/60 seconds), and `MCP_RATE_LIMITER` (60/60 seconds). Their counters are data-center-local and eventually consistent, so they are an abuse-control layer—not an exact global quota or a replacement for the synchronous body, batch, concurrency, and APNs payload limits.

## Storage and lifecycle

D1 migrations in `migrations/` are the authoritative production schema history and must be applied before deploying code that depends on them. Awaited AutoMigrate is an idempotent fallback for first-run or manually copied deployments; it does not replace migration records. D1-backed routes return HTTP 503 when schema readiness fails.

Expired MCP sessions are cleaned by the D1 entrypoint's scheduled handler at `0 * * * *`—once per hour in UTC. HTTP requests do not run session cleanup.

APNs requests are limited to 4096 payload bytes and have an explicit timeout. Timeouts map to HTTP 504, network failures to 502, and APNs 5xx responses to 503; throttling preserves 429 and `Retry-After`. Retryable failures are marked, but the Worker does not synchronously retry a notification because that can create duplicates. Any APNs signing key previously exposed in source or history must be revoked and rotated in Apple Developer; deleting it from a file is not remediation.

## Deployment

Use the [secure setup guide](doc/setup_guide.md) to create D1 outside CI, configure the `database` binding, install Cloudflare Secrets interactively, apply migrations, verify locally, and deploy. Do not treat a generated bundle, dry run, or successful unit test as evidence that production was deployed or that an APNs key was rotated.

Additional operating and migration guidance is in [Tips](doc/tips.md). MCP clients should read the [MCP lifecycle and security contract](doc/mcp.md) before connecting.
