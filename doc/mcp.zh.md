# MCP 传输与安全合同

> [!IMPORTANT]
> 只有默认 D1 入口 `main.js` 提供 MCP。手工部署的 `main_kv.js` 兼容入口没有 MCP 实现。已提交的 Wrangler 配置以 D1 为目标；本文不宣称任何线上 MCP 部署或 canary 已经完成。

## 支持的协议版本

服务端只声明并协商以下两个稳定 MCP 协议版本：

- `2025-03-26`
- `2025-06-18`

客户端在 `initialize` 中请求其中一个版本；服务端在 `result.protocolVersion` 中返回协商结果。新 Session ID 会在前缀中编码该版本，不使用单独的 D1 protocol-version 列。不要假设未声明版本可用。

本轮安全加固前的仓库版本只支持 `2025-03-26`，其无前缀 March Session 在迁移期间仍保持兼容。如果有人曾手工部署本轮的中间构建，并由它签发无前缀的 `2025-06-18` Session，升级后这些客户端必须重新执行 `initialize`。这类 Session 仍受下文 1 小时 idle TTL 和 24 小时 absolute TTL 约束。这是明确的迁移边界，不是零中断承诺，也不表示该中间构建已实际部署。

协商为 `2025-06-18` 的 Session，在后续每次 POST 或 DELETE 中都必须携带：

```http
MCP-Protocol-Version: 2025-06-18
```

缺少 Header 或版本不匹配会返回 HTTP 400。为兼容旧客户端，`2025-03-26` 客户端在后续请求中可以省略该 Header；如果发送，也必须与 Session 已协商版本一致。

## Endpoint 与传输边界

- `POST /mcp` 处理 JSON-RPC 初始化、notification 和 request。
- `DELETE /mcp` 在完成 Session 与归属校验后关闭现有 Session。
- 设备范围 endpoint 可以把 Session 绑定到路由表示的准确 device key。应把整个 URL 视为敏感数据，绝不能把真实 key 粘贴进终端历史、日志、工单、聊天或截图。
- `GET /mcp` 返回 HTTP 405，因为本实现没有提供 SSE stream；`Allow` Header 会指出支持的方法。

这是 request/response 形式的 Streamable HTTP 实现。不要把客户端配置为等待旧式 SSE endpoint，也不要把 GET 的 JSON 响应误认为 event stream。

下文示例只使用通用 `/mcp` 和脱敏占位符，刻意不包含真实 device key、device token、凭据或 Session ID。

## 认证

MCP 始终要求认证，即使 `SECURITY_MODE="compat"` 允许部分旧 Bark 行为。可使用 D1 用户的 HTTP Basic 凭据，或 `/auth/login` 返回的 Bearer 会话；D1 入口不再读取 `BASIC_AUTH` Secret。

- 缺少 `APP_MASTER_KEY` 或 `ADMIN_BOOTSTRAP_TOKEN`：HTTP 503 配置故障。
- 客户端凭据缺失、畸形或错误：HTTP 401，并带 `WWW-Authenticate` 和 `Cache-Control: no-store`。
- Session ID 不能替代 Basic Auth；每个 MCP 请求仍需认证。

不要把凭据嵌入 MCP URL 或复制的命令。通过客户端受保护的 secret/header 功能配置，并从日志和截图中脱敏完整 `Authorization` Header。

## Origin 校验

把 `MCP_ALLOWED_ORIGINS` 配置为逗号分隔的 exact origin 列表。每项 trim 后必须包含完整 `scheme://host[:port]`，不支持通配符。

- 非浏览器客户端可以省略 `Origin`。
- 如果存在 `Origin`，必须与其中一项精确匹配。
- 请求携带 Origin，但 allowlist 为空或没有匹配项时返回 HTTP 403。

Origin 校验用于限制 DNS rebinding/浏览器滥用，不能替代 Basic Auth。

## 初始化状态机

### 1. Initialize

向通用 `/mcp` 发送不含 `MCP-Session-Id` 的 JSON-RPC request：

```http
POST /mcp
Authorization: Basic <redacted>
Content-Type: application/json
Origin: <客户端发送 Origin 时必须精确匹配 allowlist>

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"<client>","version":"<version>"}}}
```

成功时，服务端返回 HTTP 200、`MCP-Session-Id` 响应 Header 和协商后的 `result.protocolVersion`。新 D1 Session 以 `initialized=false` 保存；仅收到 `initialize` 不会开放工具。

客户端应把返回的 Session ID 保存在受保护的运行时状态中。它类似 bearer 元数据，不能复制到 URL、终端命令、日志或截图。

### 2. 确认初始化

在相同路由和 Session 上发送 `notifications/initialized` JSON-RPC notification：

```http
POST /mcp
Authorization: Basic <redacted>
MCP-Session-Id: <initialize 响应返回的值>
MCP-Protocol-Version: 2025-06-18
Content-Type: application/json

{"jsonrpc":"2.0","method":"notifications/initialized"}
```

接受 notification 后返回 HTTP **202** 和空 body，并把 Session 切换为 `initialized=true`。它不是 HTTP 204，而且 JSON-RPC notification 没有 response object。

### 3. 使用工具

只有已初始化 Session 才能调用 `tools/list` 或 `tools/call`。在 `notifications/initialized` 前调用会得到 JSON-RPC 协议错误，且无法到达 APNs。每个后续请求都要使用相同的认证主体、路由范围、Session ID 和协商协议版本。

可用的 `notify` 工具复用普通 push validator 和 APNs 预算。通用 `/mcp` Session 通过受保护的 tool argument 提供 device key；设备范围 Session 使用初始化时绑定的 key。不要把任何真实值写入示例 URL 或诊断截图。

### 4. 关闭 Session

在相同路由上发送 DELETE，并携带有效 Basic Auth、`MCP-Session-Id` 和所需协议 Header。服务端会先验证 Session 存在，并确认设备范围路由与 Session 创建时绑定的 key 一致；不匹配的路由不能删除其他 Session。

## Session 归属与过期

Session ID 绑定到创建它的 MCP 路由范围：

- 通用 `/mcp` Session 始终保持通用。
- 设备范围 Session 必须继续使用完全相同的设备范围。
- 不同设备范围返回 HTTP 403 或 404，且不会泄露已绑定 key。
- 缺少 Session ID 返回 HTTP 400；未知或过期 Session 返回 HTTP 404。

Session 在空闲一小时或绝对存活 24 小时后过期。D1 scheduled handler 按 `0 * * * *` 清理过期行，即每个 UTC 整点一次。HTTP 请求只校验/更新自己的 Session，绝不会执行全局清理。

## HTTP 与 JSON-RPC 结果

| HTTP 状态 | 本实现中的含义 |
| ---: | --- |
| 200 | 成功处理 JSON-RPC request，body 中有 `result` 或 `error` |
| 202 | 接受 JSON-RPC notification，body 为空 |
| 400 | 缺少 Session 元数据、请求元数据非法或必需协议 Header 不匹配 |
| 401 | 服务端配置正确时，Basic Auth 缺失/非法 |
| 403 | 请求携带的 Origin 被拒绝，或设备/Session 归属不匹配 |
| 404 | Session 未知/过期，或为隐藏归属而返回 not found |
| 405 | 方法不支持；GET 不是 SSE |
| 413 | 请求或校验后的通知 payload 超过硬上限 |
| 429 | MCP Rate Limiting binding 拒绝主体/Session |
| 503 | required 配置或 D1 就绪不可用 |

传输错误使用 HTTP 状态码。合法 JSON-RPC request 只会返回 `result` 或 `error` 之一，绝不会同时返回。成功 notification 不返回 JSON-RPC body。

## MCP 继承的限制

- MCP 请求体：默认最大 32 KiB。
- MCP Rate binding：初始化前每个认证主体 60 次/60 秒，初始化后每个 Session 60 次/60 秒。
- 最终 APNs JSON payload：最大 4096 UTF-8 bytes。
- APNs 超时：默认 10 秒，可配置范围 1–30 秒。
- Tool argument 与 `/push` 复用字符串、URL、枚举、token 和 device key 校验。

Cloudflare Rate Limiting 计数按数据中心局部生效且最终一致。它只是防滥用层，不是精确全局配额，也不能替代请求、schema 或 APNs 硬上限。

底层 push 路径仍对 APNs 故障分类：超时 504、网络故障 502、上游 5xx 映射为 503、限流 429 并在合法时保留 `Retry-After`。语法合法的 MCP tool request 可以保持 HTTP 200，同时返回 `result.isError=true`；客户端必须检查 JSON-RPC tool result。Worker 会标记可重试结果，但绝不在同步请求中重试通知，避免意外重复。

## 安全客户端验证

先使用可信本地或 staging 客户端。通过客户端受保护设置配置 base URL、Basic Auth 和可选 Origin，而不是作为命令行参数。验证以下顺序：

1. 不支持的协议版本被拒绝。
2. `initialize` 返回请求的受支持版本和 Session Header。
3. `notifications/initialized` 前工具不可用。
4. notification 返回 202 和空 body。
5. `2025-06-18` 后续请求缺少 `MCP-Protocol-Version` 时返回 400。
6. 请求携带不可信 Origin 时返回 403。
7. GET 返回 405，而不是 SSE。
8. 不同设备范围无法读取、使用或删除该 Session。

绝不能把 production Basic Auth、device key/token 或 MCP Session ID 上传到公开 playground。客户端导出、日志、录屏和截图都必须脱敏这些值。协议测试或 dry run 不能证明线上通知 canary 已完成。
