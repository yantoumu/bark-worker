#!/usr/bin/env bash
set -euo pipefail

SERVER_ADDRESS="${SERVER_ADDRESS:-http://127.0.0.1:8787}"
RUN_DESTRUCTIVE_TESTS="${RUN_DESTRUCTIVE_TESTS:-0}"
BASIC_AUTH="${BASIC_AUTH:-}"
DEVICE_KEY="${DEVICE_KEY:-}"
DEVICE_TOKEN="${DEVICE_TOKEN:-}"

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

mask() {
    local value="$1"
    local length="${#value}"
    if ((length <= 5)); then
        printf '<redacted>'
    else
        printf '%s***%s' "${value:0:3}" "${value:length-2:2}"
    fi
}

case "$RUN_DESTRUCTIVE_TESTS" in
    0|1) ;;
    *) die 'RUN_DESTRUCTIVE_TESTS must be exactly 0 or 1' ;;
esac

export SERVER_ADDRESS
IFS=$'\t' read -r protocol hostname < <(node --input-type=module -e '
    const url = new URL(process.env.SERVER_ADDRESS)
    console.log(`${url.protocol}\t${url.hostname}`)
' 2>/dev/null) || die 'SERVER_ADDRESS must be an absolute HTTP(S) URL'

[[ "$protocol" == 'http:' || "$protocol" == 'https:' ]] || die 'SERVER_ADDRESS must use HTTP or HTTPS'
case "$hostname" in
    localhost|127.0.0.1|::1) ;;
    *) die 'This smoke script intentionally refuses non-local targets; use the staging pipeline for remote smoke tests' ;;
esac

server="${SERVER_ADDRESS%/}"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/bark-worker-smoke.XXXXXX")"
cleanup() {
    rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

request_number=0
response_file=''

curl_success() {
    local name="$1"
    local method="$2"
    local path="$3"
    local auth_mode="$4"
    local payload="${5:-}"
    local expected_status="${6:-200}"
    local status
    local -a arguments=(
        --silent
        --show-error
        --fail-with-body
        --request "$method"
        --output "$temporary_directory/response-$request_number"
        --write-out '%{http_code}'
        --connect-timeout 3
        --max-time 15
    )

    if [[ "$auth_mode" == 'auth' ]]; then
        [[ -n "$BASIC_AUTH" ]] || die "$name requires BASIC_AUTH"
        arguments+=(--user "$BASIC_AUTH")
    fi
    if [[ -n "$payload" ]]; then
        arguments+=(--header 'content-type: application/json' --data-binary "$payload")
    fi

    response_file="$temporary_directory/response-$request_number"
    request_number=$((request_number + 1))
    status="$(curl "${arguments[@]}" "$server$path")"
    [[ "$status" == "$expected_status" ]] || die "$name expected HTTP $expected_status, got $status"
    printf 'PASS: %s (HTTP %s)\n' "$name" "$status"
}

assert_ping_json() {
    RESPONSE_FILE="$response_file" node --input-type=module -e '
        import { readFileSync } from "node:fs"
        const body = JSON.parse(readFileSync(process.env.RESPONSE_FILE, "utf8"))
        if (body.code !== 200 || body.message !== "pong" || typeof body.timestamp !== "number") {
            throw new Error("ping response contract mismatch")
        }
    '
}

assert_nonempty_body() {
    [[ -s "$response_file" ]] || die "$1 returned an empty body"
}

printf 'Running non-destructive local smoke checks against %s://%s\n' "${protocol%:}" "$hostname"

curl_success 'GET /ping' GET '/ping' no-auth
assert_ping_json

curl_success 'GET /healthz' GET '/healthz' no-auth
assert_nonempty_body 'GET /healthz'

unauthorized_file="$temporary_directory/unauthorized"
unauthorized_status="$(curl \
    --silent \
    --show-error \
    --request GET \
    --output "$unauthorized_file" \
    --write-out '%{http_code}' \
    --connect-timeout 3 \
    --max-time 15 \
    "$server/info")"
[[ "$unauthorized_status" == '401' ]] || die "unauthenticated /info expected HTTP 401, got $unauthorized_status"
printf 'PASS: unauthenticated /info is rejected (HTTP 401)\n'

if [[ "$RUN_DESTRUCTIVE_TESTS" != '1' ]]; then
    printf 'SKIP: registration and push; set RUN_DESTRUCTIVE_TESTS=1 explicitly to enable side effects\n'
    exit 0
fi

[[ -n "$BASIC_AUTH" ]] || die 'BASIC_AUTH is required for destructive smoke tests'
[[ -n "$DEVICE_KEY" ]] || die 'DEVICE_KEY is required for destructive smoke tests'
[[ -n "$DEVICE_TOKEN" ]] || die 'DEVICE_TOKEN is required for destructive smoke tests'

export DEVICE_KEY DEVICE_TOKEN
register_payload="$(node --input-type=module -e '
    console.log(JSON.stringify({
        device_key: process.env.DEVICE_KEY,
        device_token: process.env.DEVICE_TOKEN,
    }))
')"
curl_success 'POST /register' POST '/register' auth "$register_payload"
RESPONSE_FILE="$response_file" node --input-type=module -e '
    import { readFileSync } from "node:fs"
    const body = JSON.parse(readFileSync(process.env.RESPONSE_FILE, "utf8"))
    if (body.code !== 200 || body.message !== "success" || body.data?.device_key !== process.env.DEVICE_KEY) {
        throw new Error("register response contract mismatch")
    }
'
printf 'Validated registered device %s without printing its token\n' "$(mask "$DEVICE_KEY")"

push_payload="$(node --input-type=module -e '
    console.log(JSON.stringify({
        device_key: process.env.DEVICE_KEY,
        title: "Local smoke test",
        body: "Explicit destructive Bark smoke test",
    }))
')"
curl_success 'POST /push' POST '/push' auth "$push_payload"
RESPONSE_FILE="$response_file" node --input-type=module -e '
    import { readFileSync } from "node:fs"
    const body = JSON.parse(readFileSync(process.env.RESPONSE_FILE, "utf8"))
    if (body.code !== 200 || body.message !== "success" || typeof body.timestamp !== "number") {
        throw new Error("push response contract mismatch")
    }
'

printf 'PASS: explicitly enabled destructive smoke checks completed\n'
