const timeoutMilliseconds = 15_000

function requiredEnvironment(name) {
    const value = process.env[name]
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('Missing required smoke configuration: ' + name)
    }
    return value
}

function optionalEnvironment(name) {
    const value = process.env[name]
    return typeof value === 'string' && value.length > 0 ? value : null
}

function buildEndpoint(baseUrl, route) {
    return new URL(route.replace(/^\/+/, ''), baseUrl).toString()
}

async function request(name, url, init, expectedStatus) {
    let response
    try {
        response = await fetch(url, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMilliseconds),
        })
    } catch {
        throw new Error(name + ' request failed')
    }

    const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
    if (!expectedStatuses.includes(response.status)) {
        throw new Error(name + ' returned unexpected HTTP status ' + response.status)
    }

    console.log('PASS ' + name + ' (HTTP ' + response.status + ')')
    return response
}

async function expectJsonCode(name, response, expectedCode) {
    let payload
    try {
        payload = await response.json()
    } catch {
        throw new Error(name + ' did not return JSON')
    }
    if (!payload || payload.code !== expectedCode) {
        throw new Error(name + ' returned an unexpected application code')
    }
    return payload
}

async function run() {
    const rawBaseUrl = requiredEnvironment('SMOKE_BASE_URL')
    const basicAuth = requiredEnvironment('SMOKE_BASIC_AUTH')
    const bootstrapToken = optionalEnvironment('SMOKE_BOOTSTRAP_TOKEN')
    const deviceKey = requiredEnvironment('SMOKE_DEVICE_KEY')
    const deviceToken = requiredEnvironment('SMOKE_DEVICE_TOKEN').toLowerCase()
    const apnsPrivateKey = optionalEnvironment('SMOKE_APNS_PRIVATE_KEY')
    const apnsTeamID = optionalEnvironment('SMOKE_APNS_TEAM_ID')
    const apnsKeyID = optionalEnvironment('SMOKE_APNS_KEY_ID')
    const apnsTopic = optionalEnvironment('SMOKE_APNS_TOPIC')

    const baseUrl = new URL(rawBaseUrl)
    if (
        baseUrl.protocol !== 'https:'
        || baseUrl.username
        || baseUrl.password
        || baseUrl.search
        || baseUrl.hash
    ) {
        throw new Error('SMOKE_BASE_URL must be a clean HTTPS origin or rooted Worker URL')
    }
    baseUrl.pathname = baseUrl.pathname.replace(/\/?$/, '/')

    if (!/^[^\r\n:]+:[^\r\n]+$/.test(basicAuth)) {
        throw new Error('SMOKE_BASIC_AUTH must use username:password format')
    }
    if (!/^[\x21-\x7e]{1,255}$/.test(deviceKey)) {
        throw new Error('SMOKE_DEVICE_KEY must be 1-255 non-space ASCII characters')
    }
    if (
        !/^[0-9a-f]{32,160}$/.test(deviceToken)
        || deviceToken.length % 2 !== 0
    ) {
        throw new Error('SMOKE_DEVICE_TOKEN must be an even-length hexadecimal APNs token')
    }

    const separator = basicAuth.indexOf(':')
    const username = basicAuth.slice(0, separator).toLowerCase()
    const password = basicAuth.slice(separator + 1)
    if (!/^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])$/.test(username)) {
        throw new Error('SMOKE_BASIC_AUTH username does not satisfy the D1 user contract')
    }
    const passwordBytes = Buffer.byteLength(password, 'utf8')
    if (passwordBytes < 12 || passwordBytes > 128) {
        throw new Error('SMOKE_BASIC_AUTH password must contain 12-128 UTF-8 bytes')
    }
    const apnsValues = [apnsPrivateKey, apnsTeamID, apnsKeyID, apnsTopic]
    if (apnsValues.some(Boolean) && !apnsValues.every(Boolean)) {
        throw new Error('SMOKE_APNS_PRIVATE_KEY, SMOKE_APNS_TEAM_ID, SMOKE_APNS_KEY_ID, and SMOKE_APNS_TOPIC must be provided together')
    }
    const basicAuthorization = 'Basic ' + Buffer.from(basicAuth, 'utf8').toString('base64')

    const pingResponse = await request(
        'public ping',
        buildEndpoint(baseUrl, 'ping'),
        { method: 'GET' },
        200,
    )
    const pingPayload = await expectJsonCode('public ping', pingResponse, 200)
    if (pingPayload.message !== 'pong') {
        throw new Error('public ping returned an unexpected message')
    }

    const healthResponse = await request(
        'readiness health check',
        buildEndpoint(baseUrl, 'healthz'),
        { method: 'GET' },
        200,
    )
    if ((await healthResponse.text()).trim().toLowerCase() !== 'ok') {
        throw new Error('readiness health check returned an unexpected body')
    }

    await request(
        'strict authentication rejection',
        buildEndpoint(baseUrl, 'info'),
        { method: 'GET' },
        401,
    )

    let loginResponse = await request(
        'D1 user login probe',
        buildEndpoint(baseUrl, 'auth/login'),
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        },
        [200, 401],
    )
    if (loginResponse.status === 401) {
        if (!bootstrapToken) throw new Error('D1 user is missing and SMOKE_BOOTSTRAP_TOKEN is not configured')
        await request(
            'one-time D1 administrator setup',
            buildEndpoint(baseUrl, 'auth/setup'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Bootstrap-Token': bootstrapToken },
                body: JSON.stringify({ username, password }),
            },
            201,
        )
        loginResponse = await request(
            'D1 user login after setup',
            buildEndpoint(baseUrl, 'auth/login'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            },
            200,
        )
    }
    const loginPayload = await expectJsonCode('D1 user login', loginResponse, 200)
    const sessionToken = loginPayload?.data?.token
    if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(sessionToken)) {
        throw new Error('D1 user login returned an invalid session token')
    }
    const authorization = 'Bearer ' + sessionToken
    const authenticatedJsonHeaders = {
        Authorization: authorization,
        'Content-Type': 'application/json',
    }

    await request(
        'D1 Basic compatibility',
        buildEndpoint(baseUrl, 'info'),
        { method: 'GET', headers: { Authorization: basicAuthorization } },
        200,
    )

    let apnsMetadataResponse = await request(
        'encrypted D1 APNs vault readiness',
        buildEndpoint(baseUrl, 'admin/apns'),
        { method: 'GET', headers: { Authorization: authorization } },
        200,
    )
    let apnsMetadata = await expectJsonCode('encrypted D1 APNs vault readiness', apnsMetadataResponse, 200)
    if (apnsMetadata?.data?.configured !== true && apnsValues.every(Boolean)) {
        const savedAPNsResponse = await request(
            'encrypted D1 APNs vault seed',
            buildEndpoint(baseUrl, 'admin/apns'),
            {
                method: 'PUT',
                headers: authenticatedJsonHeaders,
                body: JSON.stringify({
                    private_key: apnsPrivateKey,
                    team_id: apnsTeamID,
                    key_id: apnsKeyID,
                    topic: apnsTopic,
                }),
            },
            200,
        )
        await expectJsonCode('encrypted D1 APNs vault seed', savedAPNsResponse, 200)
        apnsMetadataResponse = await request(
            'encrypted D1 APNs vault readiness after seed',
            buildEndpoint(baseUrl, 'admin/apns'),
            { method: 'GET', headers: { Authorization: authorization } },
            200,
        )
        apnsMetadata = await expectJsonCode(
            'encrypted D1 APNs vault readiness after seed',
            apnsMetadataResponse,
            200,
        )
    }
    if (apnsMetadata?.data?.configured !== true) {
        throw new Error('APNs vault is not configured; seed it through PUT /admin/apns before the APNs canary')
    }

    const registerResponse = await request(
        'controlled device register',
        buildEndpoint(baseUrl, 'register'),
        {
            method: 'POST',
            headers: authenticatedJsonHeaders,
            body: JSON.stringify({
                device_key: deviceKey,
                device_token: deviceToken,
            }),
        },
        200,
    )
    await expectJsonCode('controlled device register', registerResponse, 200)

    const pushResponse = await request(
        'single-device APNs canary',
        buildEndpoint(baseUrl, 'push'),
        {
            method: 'POST',
            headers: authenticatedJsonHeaders,
            body: JSON.stringify({
                device_key: deviceKey,
                title: 'bark-worker deployment smoke',
                body: 'Production deployment ' + (process.env.GITHUB_SHA || 'unknown').slice(0, 7),
                group: 'deployment-smoke',
                isArchive: '0',
            }),
        },
        200,
    )
    await expectJsonCode('single-device APNs canary', pushResponse, 200)

    const requestedMcpProtocolVersion = '2025-06-18'
    let negotiatedMcpProtocolVersion = requestedMcpProtocolVersion
    let mcpSessionId
    try {
        const initializeResponse = await request(
            'MCP initialize',
            buildEndpoint(baseUrl, 'mcp'),
            {
                method: 'POST',
                headers: authenticatedJsonHeaders,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: requestedMcpProtocolVersion,
                        capabilities: {},
                        clientInfo: {
                            name: 'bark-worker-deploy-smoke',
                            version: '1.0.0',
                        },
                    },
                }),
            },
            200,
        )
        mcpSessionId = initializeResponse.headers.get('mcp-session-id')
        if (!mcpSessionId) {
            throw new Error('MCP initialize did not return a session ID')
        }

        let initializePayload
        try {
            initializePayload = await initializeResponse.json()
        } catch {
            throw new Error('MCP initialize did not return JSON')
        }
        if (!initializePayload?.result?.protocolVersion) {
            throw new Error('MCP initialize returned an invalid result')
        }
        negotiatedMcpProtocolVersion = initializePayload.result.protocolVersion
        if (negotiatedMcpProtocolVersion !== requestedMcpProtocolVersion) {
            throw new Error('MCP initialize negotiated an unexpected protocol version')
        }
    } finally {
        if (mcpSessionId) {
            await request(
                'MCP session cleanup',
                buildEndpoint(baseUrl, 'mcp'),
                {
                    method: 'DELETE',
                    headers: {
                        Authorization: authorization,
                        'mcp-session-id': mcpSessionId,
                        'MCP-Protocol-Version': negotiatedMcpProtocolVersion,
                    },
                },
                200,
            )
        }
    }

    await request(
        'D1 user logout',
        buildEndpoint(baseUrl, 'auth/logout'),
        { method: 'POST', headers: { Authorization: authorization } },
        200,
    )
}

run().catch((error) => {
    console.error('Production smoke failed: ' + error.message)
    process.exit(1)
})
