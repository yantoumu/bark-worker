# MCP transport and security contract

> [!IMPORTANT]
> MCP is available only in the default D1 entrypoint, `main.js`. The manually deployed `main_kv.js` compatibility entrypoint has no MCP implementation. The checked-in Wrangler configuration targets D1; this document does not claim that any live MCP deployment or canary has been completed.

## Supported protocol versions

The server declares and negotiates exactly these stable MCP protocol versions:

- `2025-03-26`
- `2025-06-18`

The client requests one of them in `initialize`; the server returns the negotiated value in `result.protocolVersion`. New session IDs encode that version in their prefix; there is no separate D1 protocol-version column. Do not assume support for an undeclared version.

The repository version before this hardening work supported only `2025-03-26`, and its unprefixed March sessions remain compatible during migration. If an intermediate build from this work was manually deployed and issued unprefixed `2025-06-18` sessions, those clients must run `initialize` again after upgrading. Such sessions are still bounded by the one-hour idle and 24-hour absolute TTLs below. This is a migration boundary, not a zero-interruption claim, and it does not claim that the intermediate build was deployed.

For a session negotiated as `2025-06-18`, every follow-up POST or DELETE must carry:

```http
MCP-Protocol-Version: 2025-06-18
```

A missing or mismatched version is rejected with HTTP 400. A `2025-03-26` client may omit that header on follow-up requests for compatibility; when it sends the header, it must still match the negotiated session version.

## Endpoint and transport boundary

- `POST /mcp` handles JSON-RPC initialization, notifications, and requests.
- `DELETE /mcp` closes an existing session after session and ownership validation.
- A device-scoped endpoint may bind a session to the exact device key represented by its route. Treat that entire URL as sensitive; never paste a real key into terminal history, logs, tickets, chat, or screenshots.
- `GET /mcp` returns HTTP 405 because this implementation does not provide an SSE stream. The `Allow` header identifies supported methods.

This is a request/response Streamable HTTP implementation. Do not configure a client to expect a legacy SSE endpoint or interpret a JSON response to GET as an event stream.

All examples below use only generic `/mcp` and redacted placeholders. They deliberately do not contain a real device key, device token, credential, or session ID.

## Authentication

MCP always requires authentication, including when `SECURITY_MODE="compat"` permits selected legacy Bark behavior. Use either D1-user HTTP Basic credentials or a Bearer session returned by `/auth/login`; the D1 entrypoint no longer reads a `BASIC_AUTH` Secret.

- Missing `APP_MASTER_KEY` or `ADMIN_BOOTSTRAP_TOKEN`: HTTP 503 configuration failure.
- Missing, malformed, or wrong client credentials: HTTP 401 with `WWW-Authenticate` and `Cache-Control: no-store`.
- A session ID does not replace Basic Auth; every MCP request remains authenticated.

Do not embed credentials in an MCP URL or a copied command. Configure them through the client's protected secret/headers facility, and redact the complete `Authorization` header from logs and screenshots.

## Origin validation

Configure `MCP_ALLOWED_ORIGINS` as a comma-separated list of exact origins. Entries are trimmed and must contain the complete `scheme://host[:port]`. Wildcards are unsupported.

- A non-browser client may omit `Origin`.
- If `Origin` is present, it must exactly match one configured entry.
- A present Origin with an empty allowlist or no match returns HTTP 403.

Origin validation limits DNS-rebinding/browser abuse; it is not a replacement for Basic Auth.

## Initialization state machine

### 1. Initialize

Send a JSON-RPC request to generic `/mcp` without an `MCP-Session-Id`:

```http
POST /mcp
Authorization: Basic <redacted>
Content-Type: application/json
Origin: <exact allowed origin, only when the client sends Origin>

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"<client>","version":"<version>"}}}
```

On success the server returns HTTP 200, an `MCP-Session-Id` response header, and the negotiated `result.protocolVersion`. The new D1 session is stored with `initialized=false`; receiving `initialize` alone does not enable tools.

Capture the returned session ID inside the client's protected runtime state. It is bearer-like metadata and must not be copied to URLs, terminal commands, logs, or screenshots.

### 2. Confirm initialization

Send the `notifications/initialized` JSON-RPC notification on the same route and session:

```http
POST /mcp
Authorization: Basic <redacted>
MCP-Session-Id: <value from the initialize response>
MCP-Protocol-Version: 2025-06-18
Content-Type: application/json

{"jsonrpc":"2.0","method":"notifications/initialized"}
```

An accepted notification returns HTTP **202** with an empty body and changes the session to `initialized=true`. It is not HTTP 204, and a JSON-RPC notification has no response object.

### 3. Use tools

Only an initialized session may call `tools/list` or `tools/call`. Calls before `notifications/initialized` receive a JSON-RPC protocol error and cannot reach APNs. Every follow-up request uses the same authenticated subject, route scope, session ID, and negotiated protocol version.

The available `notify` tool reuses the normal push validator and APNs budgets. A generic `/mcp` session supplies the device key as a protected tool argument; a device-scoped session uses the key bound during initialization. Do not put either value in an example URL or diagnostic capture.

### 4. Close the session

Send DELETE on the same route with valid Basic Auth, `MCP-Session-Id`, and the required protocol header. The server first verifies that the session exists and that a device-scoped route matches the key bound when the session was created; a mismatched route cannot delete another session.

## Session ownership and expiry

The session ID is bound to the MCP route scope that created it:

- A generic `/mcp` session remains generic.
- A device-scoped session must continue on the same exact device scope.
- A different device scope is rejected with HTTP 403 or 404 without revealing the bound key.
- Missing session ID returns HTTP 400; unknown or expired session returns HTTP 404.

Sessions expire after one hour of inactivity or 24 hours of absolute age. The D1 scheduled handler removes expired rows at `0 * * * *`, once per UTC hour. HTTP requests only validate/touch their own session and never run global cleanup.

## HTTP and JSON-RPC outcomes

| HTTP status | Meaning in this implementation |
| ---: | --- |
| 200 | Successful JSON-RPC request with a `result` or `error` object |
| 202 | Accepted JSON-RPC notification; empty body |
| 400 | Missing session metadata, invalid request metadata, or required protocol header mismatch |
| 401 | Basic Auth missing/invalid when the server is correctly configured |
| 403 | Present Origin rejected or device/session ownership mismatch |
| 404 | Session unknown/expired, or ownership-hidden not found |
| 405 | Unsupported method; GET is not SSE |
| 413 | Request or validated notification payload exceeds a hard limit |
| 429 | MCP Rate Limiting binding rejected the subject/session |
| 503 | Required configuration or D1 readiness unavailable |

Transport errors use HTTP status codes. A valid JSON-RPC request returns exactly one of `result` or `error`; it never returns both. A successful notification returns no JSON-RPC body.

## Limits inherited by MCP

- MCP request body: at most 32 KiB by default.
- MCP rate binding: 60 requests per 60 seconds per authenticated subject before initialization and per session afterward.
- Final APNs JSON payload: at most 4096 UTF-8 bytes.
- APNs timeout: 10 seconds by default, configurable from 1 to 30 seconds.
- Tool arguments use the same string, URL, enum, token, and device-key validation as `/push`.

Cloudflare Rate Limiting counters are data-center-local and eventually consistent. They are an abuse-control layer, not an exact global quota and not a substitute for request, schema, or APNs hard limits.

The underlying push path classifies APNs failures as timeout 504, network failure 502, upstream 5xx mapped to 503, and throttling 429 with `Retry-After` where valid. A syntactically valid MCP tool request can remain HTTP 200 while returning `result.isError=true`; clients must inspect the JSON-RPC tool result. The Worker marks retryable outcomes but never synchronously retries a notification, avoiding accidental duplicates.

## Safe client verification

Use a trusted local or staging client first. Configure the base URL, Basic Auth, and optional Origin through protected client settings rather than command-line arguments. Verify this sequence:

1. Unsupported protocol version is rejected.
2. `initialize` returns the requested supported version and a session header.
3. Tools fail before `notifications/initialized`.
4. The notification returns 202 with an empty body.
5. A `2025-06-18` follow-up without `MCP-Protocol-Version` returns 400.
6. A present untrusted Origin returns 403.
7. GET returns 405 rather than SSE.
8. A different device scope cannot read, use, or delete the session.

Never upload production Basic Auth, a device key/token, or an MCP session ID to a public playground. Redact those values from client exports, logs, screen recordings, and screenshots. A protocol test or dry run is not evidence that a live notification canary completed.
