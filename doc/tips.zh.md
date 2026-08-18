# 运维与迁移 Tips

除非小节明确提到 KV，本文默认针对 D1 入口。所有行为都通过 Cloudflare Secrets 和 Wrangler 变量配置；不要修改 `main.js` 或 `main_kv.js` 中的常量。

## D1 用户认证与安全模式

`SECURITY_MODE="strict"` 是生产默认值。注册、推送、MCP 和 `/info` 都需要 D1 用户认证；`/ping` 保持公开，`/healthz` 只说明就绪状态而不返回秘密细节。现有客户端可以继续发送 Basic `username:password`，也可以先调用 `/auth/login` 再使用 Bearer 会话。无效凭据返回 HTTP 401，并带 `WWW-Authenticate` 和 `Cache-Control: no-store`。

密码在 D1 中保存为独立盐、100000 次 PBKDF2-SHA256 和 Secret 派生 pepper 的不可逆哈希；登录令牌只保存 SHA-256 哈希。管理员通过 `/admin/users` 添加账号。不要把凭据或完整 `Authorization` Header 粘贴进命令、日志、截图、Issue 或聊天。

`SECURITY_MODE="compat"` 只用于迁移尚不能发送认证信息的客户端。每个 compat 部署都必须有责任人、监控和退出日期。Compat 绝不会关闭 MCP 认证。

## 严格配置解析

下列值都是字符串。布尔值只接受小写 `"true"` 或 `"false"`；`"False"`、`"yes"`、`"1"` 等值都会导致配置校验失败。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SECURITY_MODE` | `strict` | 只能是 `strict` 或 `compat` |
| `ALLOW_NEW_DEVICE` | `true` | 控制未知 key 的创建，不代表已有 key 的授权 |
| `ALLOW_QUERY_NUMS` | `false` | 设备数量必须认证并显式开启 |
| `ALLOW_LEGACY_GET_REGISTER` | `false` | 独立的旧注册开关 |
| `LEGACY_GET_REGISTER_SUNSET` | 未设置 | 开放旧 GET 时必须提供合法 HTTP-date |
| `ALLOW_INSECURE_DEVICE_REBIND` | `false` | 只在 compat 有效的迁移逃生开关 |
| `ROOT_PATH` | `/` | 绝对路径；除 `/` 外会规范为无尾斜杠 |
| `MAX_REQUEST_BYTES` | `32768` | 流式请求体上限 |
| `MAX_BATCH_SIZE` | `20` | 单批唯一 device key 数量 |
| `BATCH_CONCURRENCY` | `5` | APNs 并发请求数 |
| `APNS_TIMEOUT_MS` | `10000` | 1000–30000 ms |
| `MCP_ALLOWED_ORIGINS` | 未设置 | 逗号分隔的 exact origin，不支持通配符 |

未知枚举值、拼错的布尔值、缺少条件必填项或越界整数都是错误。修改配置后检查 `/healthz` 和 Worker 日志；不要反复请求一个配置错误的部署并期待它偶然启动成功。

## 安全注册

使用 `POST /register`，Content-Type 选择 JSON 或 `application/x-www-form-urlencoded`。主字段是 `device_key` 和 `device_token`，旧请求体别名 `key`、`devicetoken` 仍被接受。真实值只能放在请求体和受保护的客户端存储中，不能放进 query string、终端历史、浏览器地址栏、访问日志、支持工单或截图。

旧 GET 注册默认关闭。若执行有边界的迁移，必须同时设置：

- `ALLOW_LEGACY_GET_REGISTER="true"`
- 把 `LEGACY_GET_REGISTER_SUNSET` 设置为真实迁移截止时间，格式为合法 HTTP-date

日期缺失或非法时配置失败。开放后的 GET 响应会带 `Deprecation`、已配置的 `Sunset`、`Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。到达截止时间后删除开关；不要让它隐式跟随其他兼容配置。

已有 key 规则：

| 状态 | 结果 |
| --- | --- |
| 新 key、`ALLOW_NEW_DEVICE="true"` 且满足策略 | 创建绑定 |
| 已有 key 与相同 token | HTTP 200，幂等且不重复写入 |
| 已有 key 与不同 token，Basic Auth 有效 | 更新一次绑定 |
| 已有 key 与不同 token，未认证 | HTTP 409，保持不变 |
| compat 加 `ALLOW_INSECURE_DEVICE_REBIND="true"` | 临时不安全重绑；必须监控并移除 |

Device key 是不透明标识。新 key 必须是 1–255 个安全 ASCII 字符，不会被静默改写；查询先尝试原值精确匹配，再执行限时 legacy fallback。Device token 必须是 32–160 个十六进制字符且长度为偶数；接受大写输入，保存前转为小写。

### 多 key 或别名

不要直接编辑 D1/KV 行复制 token：这会绕过校验、认证和运维证据，而且 token 可能轮换。应由能把 token 保留在请求体中的客户端，通过已认证 `POST /register` 注册每个目标 key。进行任何旧别名迁移前，先备份存储并审计规范化 key 碰撞；绝不能自动覆盖碰撞记录。

## 自定义根路径

在 Wrangler `vars` 中设置 `ROOT_PATH`，例如环境负责路由的绝对挂载路径；不要修改源码。`/` 是默认根路径，非根值会规范为无尾斜杠。匹配具有路径边界，因此 `/app` 不会同时匹配 `/apple`，挂载路径下的注册接口也不会产生双斜杠。

配置 Bark 时，应填写确实路由到 Worker 的同一公开 base path。不要把设备标识放进复制的 URL 或截图。

## 请求与推送预算

| 边界 | 规则 |
| --- | --- |
| HTTP body | 最大 32 KiB；即使 `Content-Length` 缺失或伪造也按流计数 |
| 最终 APNs JSON | 最大 4096 UTF-8 bytes |
| 批量大小 | 最多 20 个唯一、非空 key；21 个会拒绝，绝不静默截断 |
| APNs 并发 | 默认最多 5 |
| Device key | 1–255 个安全 ASCII 字符 |
| Device token | 32–160 个偶数长度十六进制字符 |
| `url`、`icon`、`image` | 仅 `http:`/`https:`，最大 2048 UTF-8 bytes |
| `title`、`subtitle` | 各最大 512 UTF-8 bytes |
| 其他长字符串 | 最大 4096 UTF-8 bytes；短枚举/标识另有更小上限 |

为保持客户端兼容，批量结果外层仍为 HTTP 200。必须检查 `success_count`、`failed_count`、`partial_failure` 和 `data` 中的每项；批量响应为 200 不表示每条通知都成功。

## APNs 故障策略

Worker 在联系 Apple 前校验最终编码后的 APNs payload。配置超时默认 10 秒，只允许 1–30 秒范围。

| 条件 | HTTP 行为 | 重试建议 |
| --- | --- | --- |
| 本地/APNs payload 过大 | 413 | 修改 payload，原样不可重试 |
| APNs 限流 | 429，带有边界的 `Retry-After` | 延迟并退避重试 |
| DNS/TLS/网络故障 | 502，`retryable: true` | 延迟并退避重试 |
| APNs 5xx | 503，`retryable: true` | 延迟并退避重试 |
| Worker/APNs 超时 | 504，`retryable: true` | 延迟重试并调查延迟 |
| 永久 token 拒绝 | 客户端/APNs 错误；无效 token 可能被清空 | 重新注册设备 |

同步请求内不会自动重试。立即重试可能产生重复通知；调用方根据 `retryable` 和 `Retry-After` 决定是否及何时重试。Worker 的响应或日志不得泄露原始 device key、token、APNs JWT、SQL 或上游异常文本。

APNs 完整凭据使用 AES-256-GCM 加密后保存在 D1；解密根密钥只存在 Cloudflare Secret。provider JWT 只缓存在 isolate 内存，新 token 不写入 D1 的 authorization 记录。暴露过的签名 Key 必须在 Apple Developer 后台撤销并轮换；只从源码删除或更新 D1、却不撤销旧 Key，事故处置仍未完成。

## Rate Limiting 不是硬配额

配置预算是注册 5 次/60 秒、单推送 60 次/60 秒、批量 10 次/60 秒、MCP 60 次/60 秒，以及每个 IP/用户名的 D1 Basic 校验 60 次/60 秒。Cloudflare Rate Limiting binding 按数据中心局部计数并最终一致，可能允许短时跨地域突发，不能用于计费或精确全局限额。

即使 binding 存在，也必须保留应用硬上限。Rate limiter 不能替代请求体流式检查、20 设备批量上限、并发控制、schema 校验或 APNs 4096-byte 限制。

## D1 migration、AutoMigrate 与 Session 清理

把 `migrations/` 视为权威生产 schema 历史：

1. 备份目标 D1。
2. 在部署依赖新结构的代码前应用并验证 migration。
3. migration 保持 additive，确保代码回滚后旧 Worker 仍可运行。
4. 不要在 Dashboard 中手工重排 ID 或改 schema 来掩盖应用错误。

可等待的 AutoMigrate 是首次运行或手工复制部署的幂等兜底。依赖 D1 的接口会等待它，schema 失败返回 HTTP 503；它不能替代 Wrangler migration ledger。

D1 入口通过 `scheduled()` 在 `0 * * * *` 清理 MCP 与登录 Session，即每个 UTC 整点一次。清理使用带索引的 `last_seen`、`created_at` 和 `expires_at` DELETE。HTTP 流量不会触发清理，因此正确配置 Cron 后，即使服务空闲也能执行。

## MCP Origin 与 Session 提示

`MCP_ALLOWED_ORIGINS` 是 trim 后、逗号分隔的 exact origin（`scheme://host[:port]`），不支持通配符。非浏览器客户端可以省略 `Origin`；若请求携带 `Origin`，空列表或不匹配会返回 HTTP 403。即使在 compat 模式，MCP 仍然需要认证。

只有 D1 入口提供 MCP。协议版本、初始化、Session 归属、状态码和明确不支持 SSE 的边界见 [MCP](mcp.zh.md)。

## 运维检查清单

- staging 与 production 的 Worker、D1 和 Secrets 分离。
- 使用交互式 `wrangler secret put` 配置根密钥与引导令牌；绝不把秘密作为 shell 参数传入。
- 依次执行 `npm run verify`、备份 D1、应用 migration、部署、受控 smoke 检查。
- HTTP 401 表示认证失败，409 表示受保护的重绑冲突，413 表示大小越界，429 表示限流，502/503/504 表示已分类的基础设施/上游故障。
- 调查时保留 request ID，但必须脱敏 Authorization、设备数据、APNs JWT、Session ID、SQL 和私钥。
- 本地测试、dry run 或生成产物都不能证明已真实部署、已轮换 Key 或 canary 成功。

## KV 兼容范围

`main_kv.js` 仍是手工配置的旧兼容入口，继续使用 `BASIC_AUTH` 与 APNs Cloudflare Secrets。已提交的 Wrangler 配置和部署工作流不会选择它。它没有 D1 用户登录、APNs 保险库、MCP、D1 migration、AutoMigrate 或 D1 Cron Session 清理，不能宣称与默认 D1 生产入口完全等价。
