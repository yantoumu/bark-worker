# Operations and migration tips

These notes apply to the default D1 entrypoint unless a section explicitly mentions KV. Configure behavior through Cloudflare Secrets and Wrangler variables; do not edit constants in `main.js` or `main_kv.js`.

## D1 user authentication and security modes

`SECURITY_MODE="strict"` is the production default. Registration, push, MCP, and `/info` require a D1 user. Existing clients may keep sending Basic `username:password`, or call `/auth/login` and use the returned Bearer session. `/ping` remains public, and `/healthz` reveals readiness without secret details. Invalid credentials return HTTP 401 with `WWW-Authenticate` and `Cache-Control: no-store`.

Passwords are irreversible D1 records using a unique salt, 100000 PBKDF2-SHA256 iterations, and a Secret-derived pepper; login tokens are stored only as SHA-256 hashes. Administrators add accounts through `/admin/users`. Never paste credentials or complete `Authorization` headers into commands, logs, screenshots, issues, or chat.

`SECURITY_MODE="compat"` exists only to migrate clients that cannot yet send authentication. Give every compat deployment an owner, monitoring, and an exit date. Compat never disables MCP authentication.

## Strict configuration parsing

The following values are strings. Booleans accept exactly lowercase `"true"` or `"false"`; values such as `"False"`, `"yes"`, or `"1"` fail configuration validation.

| Variable | Default | Notes |
| --- | --- | --- |
| `SECURITY_MODE` | `strict` | Only `strict` or `compat` |
| `ALLOW_NEW_DEVICE` | `true` | Controls creation of unknown keys, not existing-key authorization |
| `ALLOW_QUERY_NUMS` | `false` | Device counts require auth and explicit opt-in |
| `ALLOW_LEGACY_GET_REGISTER` | `false` | Independent legacy registration switch |
| `LEGACY_GET_REGISTER_SUNSET` | unset | Required valid HTTP-date when legacy GET is enabled |
| `ALLOW_INSECURE_DEVICE_REBIND` | `false` | Valid only in compat; migration escape hatch |
| `ROOT_PATH` | `/` | Absolute path; normalized without a trailing slash except `/` |
| `MAX_REQUEST_BYTES` | `32768` | Streamed request-body limit |
| `MAX_BATCH_SIZE` | `20` | Unique device keys per batch |
| `BATCH_CONCURRENCY` | `5` | Concurrent APNs requests |
| `APNS_TIMEOUT_MS` | `10000` | 1000–30000 ms |
| `MCP_ALLOWED_ORIGINS` | unset | Comma-separated exact origins, no wildcard |

Unknown enum values, misspelled booleans, missing conditional settings, or out-of-range integers are errors. Check `/healthz` and Worker logs after changing configuration; do not keep retrying a broken deployment until it happens to start.

## Register safely

Use `POST /register` with JSON or `application/x-www-form-urlencoded`. The primary fields are `device_key` and `device_token`; the legacy body aliases `key` and `devicetoken` are still accepted. Keep actual values in the request body and protected client storage—not in a query string, terminal history, browser address bar, access log, support ticket, or screenshot.

Legacy GET registration is off by default. To run a bounded migration, set both:

- `ALLOW_LEGACY_GET_REGISTER="true"`
- `LEGACY_GET_REGISTER_SUNSET` to the real migration deadline in valid HTTP-date form

If the date is missing or invalid, configuration fails. An enabled GET response includes `Deprecation`, the configured `Sunset`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`. Remove the switch when the deadline is reached; do not hide it behind another compatibility setting.

Existing-key rules:

| State | Result |
| --- | --- |
| New key, `ALLOW_NEW_DEVICE="true"`, policy satisfied | Create the binding |
| Existing key and same token | HTTP 200, idempotent, no rewrite |
| Existing key and different token with valid Basic Auth | Update the binding once |
| Existing key and different token without auth | HTTP 409, unchanged |
| Compat plus `ALLOW_INSECURE_DEVICE_REBIND="true"` | Temporary insecure rebind; monitor and remove |

Device keys are opaque identifiers. New keys must be 1–255 safe ASCII characters and are not silently rewritten. Lookup tries the exact value before a time-limited legacy fallback. Device tokens must be 32–160 hexadecimal characters with even length; uppercase input is accepted and stored lowercase.

### Multiple keys or aliases

Avoid directly editing D1/KV rows to copy a token: that bypasses validation, authentication, and operational evidence, and tokens can rotate. Register each desired key through authenticated `POST /register` from a client that keeps the token in the body. Before any legacy alias migration, back up storage and audit normalized-key collisions; never auto-overwrite a collision.

## Custom root path

Set `ROOT_PATH` in Wrangler `vars`, for example to an absolute mount path managed by your environment. Do not edit source code. `/` is the root default; non-root values are normalized without a trailing slash. Matching is boundary-aware, so `/app` does not also match `/apple`, and registration under a mount does not create double slashes.

When configuring Bark, use the same public base path that routes to the Worker. Keep device identifiers out of copied URLs and screenshots.

## Request and push budgets

| Boundary | Rule |
| --- | --- |
| HTTP body | At most 32 KiB, counted from the stream even if `Content-Length` is missing or false |
| Final APNs JSON | At most 4096 UTF-8 bytes |
| Batch size | At most 20 unique, non-empty keys; 21 is rejected, never truncated |
| APNs concurrency | At most 5 by default |
| Device key | 1–255 safe ASCII characters |
| Device token | 32–160 even-length hexadecimal characters |
| `url`, `icon`, `image` | Only `http:`/`https:`, at most 2048 UTF-8 bytes |
| `title`, `subtitle` | At most 512 UTF-8 bytes each |
| Other long strings | At most 4096 UTF-8 bytes; short enums/identifiers have smaller limits |

Batch results retain outer HTTP 200 for client compatibility. Inspect `success_count`, `failed_count`, `partial_failure`, and each item in `data`; a 200 batch response does not imply every notification succeeded.

## APNs failure policy

The Worker validates the final encoded APNs payload before contacting Apple. The configured timeout defaults to 10 seconds and can be set only from 1 to 30 seconds.

| Condition | HTTP behavior | Retry guidance |
| --- | --- | --- |
| Local/APNs payload too large | 413 | Fix the payload; not retryable as-is |
| APNs throttling | 429 with a bounded `Retry-After` | Retry later with backoff |
| DNS/TLS/network failure | 502, `retryable: true` | Retry later with backoff |
| APNs 5xx | 503, `retryable: true` | Retry later with backoff |
| Worker/APNs timeout | 504, `retryable: true` | Retry later; investigate latency |
| Permanent token rejection | Client/APNs error; invalid token may be cleared | Re-register the device |

There is no synchronous automatic retry. Immediate retries can duplicate a notification; callers decide whether and when to retry based on `retryable` and `Retry-After`. The Worker must not expose raw device keys, tokens, APNs JWTs, SQL, or upstream exception text in responses or logs.

The full APNs credential set is AES-256-GCM encrypted in D1 while the decryption root remains only in a Cloudflare Secret. Provider JWTs are cached only in isolate memory and are not written to D1 authorization records. An exposed signing key must be revoked and rotated in Apple Developer. Removing it from source or updating D1 without revoking the old key is incomplete incident response.

## Rate limiting is not a hard quota

The configured budgets are registration 5/60 seconds, single push 60/60 seconds, batch 10/60 seconds, MCP 60/60 seconds, and D1 Basic verification 60/60 seconds per IP/user. Cloudflare Rate Limiting binding counters are local to a data center and eventually consistent. They can allow short cross-location bursts and cannot be used for billing or a precise global limit.

Keep application hard limits in place even when a binding is present. A rate limiter never replaces body-size streaming checks, the 20-device batch cap, concurrency control, schema validation, or the 4096-byte APNs limit.

## D1 migrations, AutoMigrate, and session cleanup

Treat `migrations/` as the authoritative production schema history:

1. Back up the target D1 database.
2. Apply and verify migrations before deploying dependent code.
3. Keep migrations additive so the previous Worker can still run after a code rollback.
4. Do not manually renumber rows or alter schema in the dashboard to solve an application error.

Awaited AutoMigrate is an idempotent fallback for first-run or manually copied deployments. D1-backed routes wait for it; schema failure returns HTTP 503. It does not replace the Wrangler migration ledger.

The D1 entrypoint cleans MCP and login sessions through `scheduled()` at `0 * * * *`, once per UTC hour. Cleanup uses indexed `last_seen`, `created_at`, and `expires_at` deletes. HTTP traffic never triggers cleanup, so a quiet service is still cleaned when Cron is configured.

## MCP origin and session notes

`MCP_ALLOWED_ORIGINS` contains comma-separated exact origins (`scheme://host[:port]`) after trimming. Wildcards are unsupported. Non-browser clients may omit `Origin`; when `Origin` is present, an empty list or mismatch returns HTTP 403. MCP remains authenticated even in compat mode.

Only the D1 entrypoint provides MCP. See [MCP](mcp.md) for protocol versions, initialization, session ownership, status codes, and the explicit no-SSE boundary.

## Operational checklist

- Keep staging and production Worker, D1, and Secrets separate.
- Use interactive `wrangler secret put` for the root key and bootstrap token; never pass a secret as a shell argument.
- Run `npm run verify`, back up D1, apply migrations, deploy, then run bounded smoke checks.
- Treat HTTP 401 as an authentication failure, 409 as a protected rebind conflict, 413 as a size limit, 429 as throttling, 502/503/504 as classified infrastructure/upstream failures.
- Preserve request IDs for investigation, but redact Authorization, device data, APNs JWTs, session IDs, SQL, and private keys.
- A local test, dry run, or generated artifact is not proof of a live deployment, key rotation, or successful canary.

## KV compatibility scope

`main_kv.js` remains a manually configured legacy compatibility entrypoint and still uses `BASIC_AUTH` plus APNs Cloudflare Secrets. The checked-in Wrangler config and deployment workflow do not select it. It has no D1 user login, APNs vault, MCP, D1 migration, AutoMigrate, or D1 Cron session cleanup; do not claim full parity with the default D1 production entrypoint.
