# bark-worker 安全加固与可靠性修复计划

> 状态：生产核心服务已部署；D1 登录可用，APNs 新 Key 轮换与真机 canary 仍为 **BLOCKED**。
>
> 执行策略：systematic / security-first / backward-compatible。
>
> 当前生产入口：`main.js`（D1）；`main_kv.js` 是仍被文档承诺的手工 KV 兼容版本。

## 2026-08-19：管理前端与浏览器会话

- [x] 新增响应式 `/admin` 管理台，提供登录、退出、添加用户、APNs 状态与加密凭据写入界面。
- [x] 浏览器访问根路径时跳转到 `/admin`，`Accept: */*` 的 API 客户端仍获得原有 `ok` 响应。
- [x] 登录建立 `__Host-` 前缀、HttpOnly、Secure、SameSite=Strict 的 D1 会话 Cookie；Token 不写入浏览器存储。
- [x] Cookie 认证仅用于浏览器认证与管理路由，不能替代注册、推送、信息查询或 MCP 的 Basic/Bearer 认证。
- [x] Cookie 管理写操作强制精确同源 Origin；管理页启用 strict CSP、HSTS、noindex、no-transform 与禁止 framing。
- [x] 使用 390px 和 1440px 真实浏览器完成登录、创建用户、退出与响应式布局验证，控制台 0 error / 0 warning。
- [x] `npm run verify` 全绿：31 个 JavaScript 文件语法通过，D1/KV 两轮各 237 项测试通过，Wrangler dry-run 成功。
- [x] 部署到 `https://bark.seo9.org/admin`；生产版本 `a86a440c-8011-4c99-bd69-049f80b453c2` 为 100% 流量。
- [x] 线上验证根路径跳转、HTTPS/HSTS、安全头、管理员登录、会话探测、APNs 元数据读取、退出清除与旧会话失效。
- [ ] APNs 保险库仍为 `configured=false`；必须由用户提供新轮换的 Apple `.p8` Key 后才能完成真实推送 canary。

## 2026-08-18：D1 用户认证与 APNs 加密保险库增量

本增量替代 D1 入口的 `BASIC_AUTH` 和 APNs 明文 Secret 合同；旧 KV 入口保持手工兼容，不宣称功能等价。

- [x] `users` 仅保存独立盐、100000 次 PBKDF2-SHA256 哈希和 Secret 派生 pepper；密码不可逆。
- [x] `auth_sessions` 仅保存随机 Bearer token 的 SHA-256 哈希，并由 Cron 按 `expires_at` 索引清理。
- [x] `POST /auth/setup` 使用独立引导令牌和原子一次性 SQL 创建首个管理员。
- [x] `POST /auth/login`、`POST /auth/logout`、`GET /auth/me` 与 `POST /admin/users` 已实现角色边界。
- [x] D1 Basic Auth 兼容现有客户端，但校验来源改为 `users`，不再读取 `BASIC_AUTH` 环境变量。
- [x] APNs 完整凭据以 AES-256-GCM 单记录保存，根密钥只来自 `APP_MASTER_KEY` Cloudflare Secret。
- [x] `GET/PUT /admin/apns` 只向管理员开放，读取永不返回私钥或密文。
- [x] `migrations/005_create_auth_vault.sql` 与可等待 AutoMigrate 都只做 additive 建表/索引。
- [x] 未配置或无法解密 APNs 凭据时 fail closed，且不会联系 Apple。
- [x] 明确首次 APNs seed 的 D1 回滚边界：canary 失败时由管理员显式 `PUT /admin/apns` 修复，禁止自动恢复泄漏 Key 或隐式覆盖已有记录。
- [x] 在目标 Cloudflare D1 完成加密备份/解密一致性校验后应用 001–005；migration ledger 再查为 `No migrations to apply`。
- [x] 部署 `bark-worker` 到 `https://bark.seo9.org`，创建首个管理员并验证登录、D1 Basic、Bearer、登出失效和 APNs 元数据接口。
- [ ] 使用已撤销泄漏旧 Key 后新创建的 APNs Key 写入保险库并完成真机 canary。

### 权威执行状态（2026-08-19）

下表是本轮实际执行状态与证据；下方各 Phase 的 checkbox 保留为原始验收清单，不能单独据此声称已经上线。

| 范围 | 状态 | 本地证据 | 尚未满足的门禁 |
| --- | --- | --- | --- |
| Phase 0：APNs Key 事故响应 | **BLOCKED** | 仓库扫描未发现嵌入式私钥或 APNs 凭据 | 尚未确认 Apple Team/旧 Key 状态，未撤销轮换，未完成真实 APNs canary |
| Phase 1–10：代码、测试、配置、CI 与文档 | **DONE** | 31 个 JavaScript 文件语法通过；D1/KV 两轮各 237 项测试全通过；toolchain 合同 12/12 通过 | APNs 真机链路仍受 Phase 0 阻断 |
| 完整 `npm run verify` | **DONE** | exit 0；D1 line/branch/functions 94.03%/81.95%/95.00%，KV 89.55%/77.01%/96.39%；Wrangler dry-run 通过 | 本地门禁不替代下列真实线上证据 |
| Production D1 migration | **DONE** | 生产导出经 AES-256-GCM 加密后解密逐字节一致；001–005 远端应用成功，再查无待应用 migration；原 3 个设备记录未丢失 | 加密备份需与 Keychain 内独立备份密钥一同保管 |
| 配置与 CI 安全合同 | **DONE** | secret scan、YAML 解析、备份 AES-256-GCM 往返/篡改拒绝、Worker version UUID fixture、production/staging 渲染与 Wrangler dry-run 均通过；账号扫描确认 production namespace 3001–3005 不碰撞 | GitHub Environment 与 staging 的独立 namespace/Secrets 尚未配置 |
| Staging | **NOT RUN** | 仅完成 workflow 门禁和本地 staging dry-run | 未执行远程 migration/deploy/smoke，未连续观察一个真实 UTC Cron 周期 |
| Production | **CORE + ADMIN UI LIVE / APNs BLOCKED** | `https://bark.seo9.org/admin`；Worker version `a86a440c-8011-4c99-bd69-049f80b453c2` 为 100%；HTTPS ping/health 200、管理页与安全头 200、Cookie 登录/探测/APNs 元数据/退出失效均通过；D1 用户仅存 PBKDF2 元数据 | APNs vault 明确为 `configured=false`；尚缺新 Key、真实推送 canary、Cron 周期观察与 staging |

### 集中上线阻断

1. 在 Apple Developer 完成旧 APNs Key 状态确认、撤销、轮换和受控真机 canary；旧 Key 不得作为回滚手段。
2. 为 staging 预留与 production 3001–3005 不重叠的五个 Rate Limit namespace，并配置受保护的 GitHub Variables、Secrets 与 Environment 审批。
3. 完成 staging migration/deploy/smoke，并观察至少一个真实 UTC Cron 周期；production 核心登录链路已上线，但不能据此声称 APNs 推送已完成。

## 1. 目标与完成定义

本计划用于关闭已确认的 37 项安全、稳定性、协议和部署问题，同时保持 Bark 现有推送 URL、主要响应字段和旧客户端的可迁移性。

只有同时满足下列条件，才可以声明修复完成：

- [ ] 仓库当前版本和 Git 历史中暴露的 APNs Key 已在 Apple Developer 后台确认状态；仍有效的旧 Key 已撤销并轮换。
- [ ] 源码、测试、文档、构建产物和日志中不再包含 APNs 私钥或可用凭据。
- [ ] 新部署默认使用严格安全配置；任何兼容降级都必须显式开启、记录风险并设置取消期限。
- [ ] `/register` 无法被未授权调用者覆盖已有设备绑定。
- [ ] 所有入口具有方法、认证、请求大小、字段类型、批量大小和速率边界。
- [ ] APNs JWT、payload、超时和错误映射符合 Apple 约束。
- [ ] D1 migration、AutoMigrate、Cron 清理和索引均经过本地及 staging 验证。
- [ ] MCP 初始化状态、协议版本、Origin、Session 归属和 HTTP 状态符合所声明的协议版本。
- [ ] CI 使用锁定依赖和 GitHub Secrets，先验证、再迁移、再部署、最后 smoke test。
- [ ] D1、KV 两个仍受支持的入口均通过相同安全回归；否则正式弃用 KV，不能继续声称功能等价。
- [ ] 生产 canary/smoke 证据齐全；仅有单测或 dry-run 不算线上完成。

## 2. 不做的事情

- 不在本轮引入 Hono、Zod、ORM 或其他运行时框架；当前项目规模不需要。
- 不直接重写 Git 历史。凭据泄漏首先通过撤销和轮换处理；历史重写必须另行批准，因为会影响所有 clone/fork。
- 不删除 Bark 路径式推送接口；它是现有用户空间的一部分。
- 不把 Cloudflare Rate Limiting binding 当成精确计费系统；它是最终一致、按机房生效的防滥用层，硬上限仍由代码执行。
- 不在同步请求中自动重试通知。Apple 对 5xx 建议延迟重试，立即重试还可能产生重复通知；本轮返回明确的 `retryable` 和 `Retry-After`，由调用方决定。
- 不使用 MCP draft。首轮只声明并测试实际支持的稳定协议版本。

## 3. 必须先确认的决策门

这些事项不是代码可以替用户决定的。未满足对应门禁时，可以开发和本地测试，但不得生产发布。

### G0：APNs 凭据所有权

- [ ] 确认当前 Key 属于本项目、自有 Apple Team，还是复制自 Bark 上游。
- [ ] 确认新 Key 对 `APNS_TOPIC` 有权限。
- [ ] 记录旧 Key 撤销时间和新 Key ID；不要把私钥或完整 ID 写入仓库、Issue、PR 或日志。
- [ ] 若当前 Key 仍有效，按已泄漏处理；删除源码中的 Key 不能替代撤销。

### G1：兼容模式退出时间

推荐发布一个明确的安全大版本：

- `SECURITY_MODE=strict`：新部署和生产推荐值；注册、推送、MCP、`/info` 均要求 Basic Auth。
- `SECURITY_MODE=compat`：仅用于旧客户端迁移；必须显式配置，并打印一次不含秘密的安全告警。
- `ALLOW_LEGACY_GET_REGISTER`：只控制旧 GET 注册，不能隐式跟随其他变量。
- `ALLOW_INSECURE_DEVICE_REBIND`：默认 `false`；仅作为短期逃生开关，开启时必须同时有速率限制。

- [ ] 确定 compat 的停止支持日期。
- [ ] 确定现有 Bark 客户端如何携带 Basic Auth；不能假设所有客户端都已支持。

### G2：KV 版本去留

- [ ] 继续支持：所有通用安全修复必须同步进 `main_kv.js`，并新增 Fake KV 回归测试。
- [ ] 停止支持：先更新中英文文档并给出迁移期，再删除；在此之前仍按安全支持处理。

### G3：生产基础设施

- [ ] D1 数据库已在 CI 之外完成一次性创建，ID 以 GitHub Variable 提供。
- [ ] Cloudflare Account ID、API Token 使用 GitHub Secrets。
- [ ] Worker 运行时秘密使用 Cloudflare Secrets，不使用 `vars`。
- [ ] staging 与 production 使用不同 Worker/D1/Secrets。

## 4. 兼容性合同

修复过程中必须持续满足：

1. 保留 `POST /push` 和 `/{device_key}[/{title}[/{subtitle}]/{body}]`。
2. 保留现有成功响应中的 `code`、`message`、`timestamp`；新字段只能追加。
3. 批量响应暂时保留外层 HTTP 200，追加 `success_count`、`failed_count`、`partial_failure`；单项状态仍在 `data` 中，避免破坏现有客户端。
4. 上游 bark-server 已把 `POST /register` 作为主接口，同时保留 GET 作为旧请求兼容。本项目采用相同迁移方向，不直接删除 GET。
5. `notifications/initialized` 成功返回 HTTP 202 是 MCP Streamable HTTP 的正确行为；应修正文档/脚本中的 204 预期，而不是改代码为 204。
6. 数据库变更只做向前兼容的加列/加索引。旧版本必须能够忽略新结构并回滚运行。
7. `device_key` 不再静默删字符。先精确查询，再执行限时的 legacy fallback，避免让旧数据突然失效。

### 初始安全预算

以下是第一版实现和测试必须使用的明确默认值。上线后只能依据 staging/production 指标调整；扩大边界前必须补相应压力测试。

| 项目 | 默认值 | 硬性规则 |
| --- | ---: | --- |
| HTTP request body | 32 KiB | 流式计数；不得只信任 `Content-Length` |
| APNs JSON payload | 4096 bytes | 按最终 UTF-8 字节数计算 |
| 单批设备数 | 20 | 超出整批拒绝，不静默截断 |
| APNs 并发 | 5 | 不超过 Cloudflare invocation 的同时外连边界 |
| APNs 超时 | 10 秒 | 可配置范围 1–30 秒 |
| device key | 1–255 个安全 ASCII 字符 | 新写入不允许静默规范化 |
| device token | 32–160 个十六进制字符且长度为偶数 | 接受大写，保存前转小写 |
| URL 字段 | 2048 UTF-8 bytes | 只允许 `http:`/`https:` |
| title/subtitle | 各 512 UTF-8 bytes | 最终仍受 4096-byte payload 限制 |
| 其他字符串字段 | 各 4096 UTF-8 bytes | 短枚举/标识字段另限 128 bytes |
| 注册速率 | 5 次/60 秒/key | compat 匿名请求按 IP；strict 按认证主体 |
| 单设备推送速率 | 60 次/60 秒/device key | Rate Limiting binding 之外仍执行请求硬上限 |
| 批量推送速率 | 10 次/60 秒/认证主体 | 每批仍受 20 个设备硬上限 |
| MCP 速率 | 60 次/60 秒/session/主体 | initialize 前按认证主体，之后按 Session |

Rate Limiting binding 的计数按 Cloudflare 机房局部生效且最终一致，因此这些速率不是精确全局配额；批量、body 和 payload 限制必须由代码同步强制执行。

## 5. 实施阶段与任务

### Phase 0：事故响应与可恢复基线

#### T0.1 撤销并轮换 APNs Key（外部人工动作，阻塞生产）

**依赖**：G0。

- [ ] 在 Apple Developer 后台撤销仍有效的旧 Key并创建新 Key。
- [ ] 关闭使用旧 Key 的既有 APNs 连接。
- [ ] 通过交互式 `wrangler secret put` 配置：
  - `APNS_PRIVATE_KEY`
  - `APNS_TEAM_ID`
  - `APNS_KEY_ID`
  - `APNS_TOPIC`
  - `BASIC_AUTH`
- [ ] 不通过 shell 参数、URL、GitHub workflow input 或仓库文件传递秘密。
- [ ] 在 Apple Push Notification Console 或 staging 真机执行一次 canary push。

**验收证据**：旧 Key 状态、新 Key canary 的 APNs 200、Worker 日志 request ID；证据中不得包含私钥、完整设备 token 或认证头。

**回滚**：已泄漏 Key 不得重新启用。若新 Key 不可用，停止发布并创建另一枚受控 Key，而不是回退到旧 Key。

#### T0.2 备份与基线快照

**文件**：不提交生产备份；新增 `.backups/` 到 `.gitignore`。

- [ ] 记录当前 Worker deployment/version ID。
- [ ] 使用锁定版本 Wrangler 导出 production D1：
  `npx wrangler d1 export database --remote --output=.backups/bark-before-hardening.sql`
- [ ] 将备份放入受控、安全且不被 Git 跟踪的位置。
- [ ] 记录当前 `/ping`、`/healthz`、注册、单推送、批量、MCP 的响应契约。

**验收**：备份非空，可在独立本地 D1 导入；`git status` 不出现备份或秘密。

---

### Phase 1：先建立失败测试和安全门禁

#### T1.1 扩展测试夹具

**文件**：

- `test/helpers/fake-d1.js`（新增）
- `test/helpers/fake-kv.js`（新增）
- `test/helpers/worker-context.js`（新增）
- `test/helpers/apns.js`（新增）
- `test/push-compatibility.test.js`

- [ ] Fake D1 必须记录 `exec/prepare/bind/run` 调用和顺序，不能只返回固定 token。
- [ ] Fake KV 覆盖 get/put/delete/list 及 TTL。
- [ ] APNs stub 支持成功、空 JSON、非法 JSON、400/403/410/413/429/500/503、超时和网络拒绝。
- [ ] 每个测试恢复 `globalThis.fetch`，不得并行污染其他测试。
- [ ] 给每个当前漏洞先添加一个能稳定失败的回归测试，再修改生产代码。

#### T1.2 建立统一验证命令

**文件**：`package.json`、新 `package-lock.json`。

- [ ] 实施前再次检查 `package.json` lifecycle scripts；不得盲目安装依赖。
- [ ] Wrangler 使用精确版本且不低于 4.36.0（Rate Limiting binding 要求），不使用 `^`，生成并提交 lockfile。
- [ ] 增加脚本：`check:syntax`、`test:coverage`、`deploy:dry-run`、`verify`。
- [ ] `verify` 至少执行语法检查、全部单测、覆盖率和 Wrangler dry-run。
- [ ] 覆盖率门槛：变更代码分支 100%；整体行覆盖不低于 80%、分支不低于 75%、函数不低于 85%。

**禁止**：为了达到覆盖率而忽略错误分支、跳过测试或仅测试 helper。

---

### Phase 2：秘密、配置与认证边界

#### T2.1 移除源码凭据并验证配置

**文件**：`main.js`、`main_kv.js`、`wrangler.jsonc`、`.gitignore`、`.dev.vars.example`（新增）。

- [ ] APNs 类只从 `env` 接收 Key、Team ID、Key ID、topic。
- [ ] `BASIC_AUTH` 只允许来自 Secret binding。
- [ ] 在 Wrangler 配置中声明 required secrets；部署缺失时失败。
- [ ] `.dev.vars`、`.env`、`.backups/` 加入忽略；只提交无真实值的 `.dev.vars.example`。
- [ ] 增加静态 secret scan：源码中不得出现 `BEGIN PRIVATE KEY` 或已知旧凭据指纹。
- [ ] 日志和错误响应不得输出 `env`、Authorization、device token、APNs JWT。

**验收**：秘密缺失时受保护接口 fail closed，并由 `/healthz` 返回 503 配置错误；不能退化为匿名放行。

#### T2.2 严格配置解析

**文件**：`main.js`、`main_kv.js`。

- [ ] 实现纯函数配置解析；布尔值只接受字符串 `true`/`false`。
- [ ] 未知值、拼写错误、越界整数返回清晰配置错误，不能转成 truthy。
- [ ] 解析并限制：`MAX_REQUEST_BYTES`、`MAX_BATCH_SIZE`、`BATCH_CONCURRENCY`、`APNS_TIMEOUT_MS`。
- [ ] 推荐默认值：32 KiB 请求体、20 个设备/批、并发 5、APNs 超时 10 秒。
- [ ] `ALLOW_QUERY_NUMS` 安全默认值为 `false`。
- [ ] 配置对象在一次请求内只解析一次。

**理由**：Cloudflare 单请求可远大于 APNs 4 KiB，且每次 Worker invocation 同时仅允许有限的出站连接；代码硬上限不可省略。

#### T2.3 统一认证策略

**文件**：`main.js`、`main_kv.js`。

- [ ] `strict` 模式下，注册、推送、MCP、`/info` 全部要求 Basic Auth。
- [ ] 未配置 `BASIC_AUTH` 时返回 503 配置错误，而不是认证成功。
- [ ] 认证失败统一返回 401、`WWW-Authenticate`、`Cache-Control: no-store`。
- [ ] 保留常量时间比较；测试正确、错误、缺失、畸形、大小写错误的 Header。
- [ ] `/ping` 保持无认证；`/healthz` 不泄漏详情，但配置或 D1 不可用时返回 503。
- [ ] `/info` 默认不返回设备数；需要认证且 `ALLOW_QUERY_NUMS=true` 才查询。

---

### Phase 3：注册接口安全与 Bark 兼容

#### T3.1 新增主注册接口并限制旧接口

**文件**：`main.js`、`main_kv.js`、中英文文档。

- [ ] `POST /register` 接受 JSON/form：`device_key`、`device_token`，并兼容旧字段 `key`、`devicetoken`。
- [ ] GET 只在 `ALLOW_LEGACY_GET_REGISTER=true` 时开放。
- [ ] GET 响应添加 `Deprecation`、`Sunset`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`。
- [ ] GET、POST 之外返回 405 和正确的 `Allow` Header。
- [ ] 注册请求应用独立 Rate Limiting binding；匿名兼容请求按来源 IP，认证请求按不含秘密的主体指纹计数。
- [ ] URL 和日志中不再记录 device token；文档不再推荐 GET。

#### T3.2 防止已有 Key 被未授权覆盖

- [ ] 新 Key：仅在 `ALLOW_NEW_DEVICE=true` 且通过认证/兼容策略时创建。
- [ ] 已有 Key + 相同 token：作为幂等注册返回 200，不重复写库。
- [ ] 已有 Key + 不同 token：strict 模式必须通过 Basic Auth，否则返回 409。
- [ ] `ALLOW_INSECURE_DEVICE_REBIND=true` 只能在 compat 模式使用，并输出安全告警与指标。
- [ ] 不实现复杂的两阶段挑战或新客户端 registration token，除非 Bark 客户端先增加对应支持。

**关键验收**：知道 `device_key` 但没有 Basic Auth 的请求无法改变已绑定 token；合法 token 更新路径有明确迁移说明和测试。

---

### Phase 4：请求解析、Schema、限流和批量控制

#### T4.1 统一请求读取与大小边界

**文件**：`main.js`、`main_kv.js`。

- [ ] 读取 body 前检查可信的 `Content-Length`，并在流式读取时累计字节，处理缺失或伪造长度。
- [ ] 超过 `MAX_REQUEST_BYTES` 立即返回 413，不继续 JSON/form 解析。
- [ ] POST 只接受声明支持的 Content-Type；其他类型返回 415。
- [ ] Query/Form 使用平台已解码值，不再次 `decodeURIComponent`。
- [ ] 仅路径 segment 执行一次安全解码；畸形 `%` 返回 400，不返回 500。

#### T4.2 Push Schema 校验

- [ ] 编写小型纯函数 validator，不引入新运行时依赖。
- [ ] 字符串字段拒绝 object/array/number，布尔/数字兼容值只做显式转换。
- [ ] `level` 只接受 `passive|active|timeSensitive|critical`。
- [ ] `badge` 为非负整数；`ttl` 为非负整数；`volume` 为合法数字范围。
- [ ] `url`、`icon`、`image` 仅接受有长度上限的 `http:`/`https:` URL。
- [ ] `sound`、`title`、`subtitle`、`body`、`markdown`、`ciphertext` 按“初始安全预算”执行明确字节上限。
- [ ] 组装 APNs JSON 后使用 `TextEncoder` 验证总 payload 不超过 4096 字节；超限返回 413。
- [ ] 未识别字段保持忽略，避免不必要破坏上游扩展。

#### T4.3 批量硬上限与受控并发

- [ ] `device_keys` 仅接受 JSON 数组或旧接口逗号字符串。
- [ ] 校验每个 key、去重、拒绝空值。
- [ ] 超过 `MAX_BATCH_SIZE` 返回 413/422，不截断后静默执行。
- [ ] 用固定大小 worker pool 替换无限 `Promise.all`；默认并发 5。
- [ ] 每项捕获异常，单项失败不能 reject 整个批次。
- [ ] 保留 HTTP 200 兼容响应，同时追加成功数、失败数和部分失败标志。
- [ ] 注册、单推送、批量、MCP 分别使用 Rate Limiting binding；硬批量上限不能依赖 rate limiter。

**验收边界**：20 个设备可执行；21 个被拒绝；任一 APNs/D1 异常只影响对应项；同时打开的 APNs 请求不超过配置值。

---

### Phase 5：APNs 正确性与故障隔离

#### T5.1 正确生成并缓存 JWT

**文件**：`main.js`、`main_kv.js`。

- [ ] 建立唯一 `base64UrlEncode(bytes|string)` helper，使用全局替换或等价可靠实现。
- [ ] JWT header、claims、signature 全部通过同一 helper。
- [ ] 验证 `alg=ES256`、Key ID、Team ID、`iat`，测试 token 三段均只含 Base64URL 字符。
- [ ] provider token 在 isolate 内存中缓存并在约 50 分钟刷新，符合 Apple 20–60 分钟窗口。
- [ ] 停止把新 APNs JWT 写入 D1/KV；旧 `authorization` 表/键先停止使用，延后一个兼容版本再清理。
- [ ] 并发冷启动使用同一 promise，避免同一 isolate 重复签名。

#### T5.2 安全处理 APNs 响应

- [ ] 空 body、非 JSON、JSON 无 `reason`、`reason` 非字符串都必须得到稳定错误对象。
- [ ] 不再对可能为 `undefined` 的值调用 `.includes()`。
- [ ] 仅对 `410`、`BadDeviceToken`、`Unregistered` 等明确永久失效响应清空 token。
- [ ] `413` 映射为 payload 错误；`429` 透传合理的 `Retry-After`；5xx 标记 `retryable: true`。
- [ ] 对外不回显内部 D1 语句、device key 或 APNs token。

#### T5.3 超时和重试政策

- [ ] 使用 `AbortController` 实施可配置超时，始终清理 timer。
- [ ] 超时返回 504；DNS/TLS/网络异常返回 502；APNs 5xx 返回 503。
- [ ] 不在当前同步请求里自动重试 5xx；Apple 建议延迟退避，立即重试可能重复通知。
- [ ] 为未来 Queue 重试保留明确接口，但本轮不引入 Queue。
- [ ] 记录结构化日志：request ID、route、APNs status/reason、latency、retryable；不记录秘密。

---

### Phase 6：D1、AutoMigrate 与 Session Cron

#### T6.1 保留但修正 AutoMigrate

**文件**：`main.js`。

- [ ] `Database` 构造函数不得执行异步 I/O。
- [ ] 新增可等待的 `ensureSchema()`，使用 isolate 级 promise 保证每个 binding 初始化一次。
- [ ] AutoMigrate 只执行幂等、向前兼容的建表/建索引；失败时清除 promise 以允许后续重试。
- [ ] 所有依赖 D1 的路由先 `await ensureSchema()`；失败统一返回 503。
- [ ] `/ping` 和根路径不触发 D1；`/healthz` 只做可观测的轻量 readiness 检查。
- [ ] Wrangler migrations 仍是权威生产迁移路径；AutoMigrate 是首次部署/手工复制场景的兜底，不替代迁移记录。

#### T6.2 新增向前兼容 migration

**文件**：

- `migrations/004_add_session_indexes.sql`（新增）
- `migrations/005_add_mcp_protocol_version.sql`（若 MCP 任务需要）

- [ ] 为 `last_seen`、`created_at` 建独立索引。
- [ ] migration 只新增索引/列，不删除表列，保证代码回滚安全。
- [ ] 本地空库执行一次、重复执行 migration 命令一次、从生产导出副本升级一次。
- [ ] 使用 `EXPLAIN QUERY PLAN` 证明清理查询使用索引。

#### T6.3 把 Session 清理移到 Cron

**文件**：`main.js`、`wrangler.jsonc`。

- [ ] 从 HTTP fetch 路径删除 `cleanupExpiredSessions()`。
- [ ] 添加 Module Worker `scheduled(controller, env, ctx)` handler。
- [ ] 配置 UTC Cron，推荐每小时一次。
- [ ] 将 `OR` 清理拆成两条可使用独立索引的 DELETE，保持幂等。
- [ ] 使用 Wrangler 本地 scheduled endpoint 测试成功、空表和 D1 失败。
- [ ] 记录删除行数和耗时，不记录 session ID。

**回滚**：保留索引和新增列；旧代码可以继续运行。回滚 Worker 不回滚 D1 schema。

---

### Phase 7：Key、路由和统一异常

#### T7.1 修复 device key/token 规范化

- [ ] device key 视为不透明标识，不再静默删除字符。
- [ ] 查询顺序：原值精确查询 → legacy 清理值 fallback；命中 fallback 时记录去标识化迁移指标。
- [ ] 新写入只接受明确字符集和长度；不合法直接 400。
- [ ] 上线前运行碰撞审计，列出会被 legacy 规范化成同一值的记录，必须人工解决，禁止自动覆盖。
- [ ] device token 必须为规定长度范围内、偶数长度的十六进制；接受大写但统一转小写。
- [ ] 清理后的 token 为空时注册必须失败，不能返回成功。

#### T7.2 修复 ROOT_PATH 和方法路由

- [ ] ROOT_PATH 规范成 `/` 或无尾斜杠的绝对路径。
- [ ] 只匹配路径本身或 `ROOT_PATH + '/'`，`/app` 不得匹配 `/apple`。
- [ ] `/bark/register` 规范成 `/register`，不得产生双斜杠。
- [ ] 为每条路由定义 Allow 方法并统一返回 405。
- [ ] 路径式 push 为兼容保留 GET/POST；其他写接口优先 POST。

#### T7.3 顶层异常边界和信息最小化

- [ ] `fetch` 顶层生成/传播 request ID，并捕获未处理异常。
- [ ] 统一 JSON 错误结构，不返回 stack、SQL、device key、token 或原始认证信息。
- [ ] 未知 key 对外只返回 `invalid device key`。
- [ ] validation/auth/rate-limit/upstream/internal 分别使用稳定状态码。
- [ ] 使用结构化 `console.error/warn/log`，便于 Workers Logs 查询。

---

### Phase 8：MCP 协议与 Session 隔离

#### T8.1 明确协议支持范围

**文件**：`main.js`、`doc/mcp.md`、`doc/mcp.zh.md`。

- [ ] 首轮只声明实际测试通过的稳定版本，建议 `2025-03-26` 与 `2025-06-18`。
- [ ] initialize 根据客户端请求协商版本；不再无条件返回固定值。
- [ ] 2025-06-18 后续请求校验 `MCP-Protocol-Version`；旧客户端缺失 Header 时按 2025-03-26 兼容。
- [ ] 不宣称支持 2025-11-25 或 draft，直到完成对应 conformance 测试。
- [ ] GET `/mcp` 在未实现 SSE 时返回 405，而不是 JSON-RPC 200。
- [ ] notification 成功返回 202 空 body；同步修正 `test.sh` 的 204 注释。

#### T8.2 严格初始化状态机

- [ ] `initialize` 创建 Session 时 `initialized=false` 并保存 negotiated protocol version。
- [ ] 只有 `notifications/initialized` 可以切换为 true。
- [ ] `tools/list`、`tools/call` 在初始化完成前返回协议错误。
- [ ] 缺少 Session ID 返回 400；过期/不存在 Session 返回 404。
- [ ] DELETE 先验证 Session 存在，并校验 `/mcp/{deviceKey}` 与 Session 绑定 key 一致。
- [ ] JSON-RPC notification 不得带 response body；request 必须返回 result 或 error，不能同时返回。

#### T8.3 MCP HTTP 安全

- [ ] MCP 始终要求 strict 认证。
- [ ] 校验存在的 `Origin` Header；不在 allowlist 时返回 403，防止 DNS rebinding。
- [ ] MCP 请求应用独立 body、速率和超时上限。
- [ ] Tool 参数复用 push validator，不能建立第二套宽松输入路径。

---

### Phase 9：CI/CD 可复现与最小权限

#### T9.1 锁定工具链

**文件**：`package.json`、`package-lock.json`、`.github/workflows/deploy.yml`。

- [ ] Wrangler 使用本地、精确版本；不再全局安装，也不在 Action 中指定另一版本。
- [ ] CI 使用 `npm ci`。
- [ ] 依赖安装前再次审查 lifecycle scripts。
- [ ] 固定 Node LTS；第三方 Action 固定到审核过的 commit SHA。
- [ ] `permissions: contents: read`。

#### T9.2 分离基础设施初始化与日常部署

- [ ] workflow 监听实际生产分支 `master`，或先完成一次受控分支迁移；不能两者不一致。
- [ ] CI 不再自动创建 D1；创建数据库是一次性 bootstrap 操作。
- [ ] D1 ID 作为 GitHub Variable 注入临时 Wrangler 配置；脚本必须验证 UUID 和“恰好替换一次”。
- [ ] 临时配置写入被忽略目录，并在 dry-run 后验证不存在 placeholder。
- [ ] Account ID/API Token 使用 GitHub Secrets；不再使用普通 workflow inputs。

#### T9.3 建立单向部署流水线

顺序不得调整：

1. `npm ci`
2. secret scan / syntax / unit / coverage
3. 本地 D1 migration + AutoMigrate 测试
4. `wrangler deploy --dry-run`
5. staging migration
6. staging deploy + smoke
7. production D1 备份
8. production migration
9. production deploy
10. production smoke 和日志检查

- [ ] 任一步失败立即停止；不能在失败后继续 deploy。
- [ ] workflow 设置 timeout、concurrency，避免同一环境并发部署。
- [ ] production 使用 GitHub Environment 审批。
- [ ] smoke 至少验证 `/ping`、`/healthz`、认证拒绝、受控 register、单推送 canary、MCP initialize。
- [ ] 发布前记录旧 Worker version ID；异常时执行 `wrangler rollback <version-id>`。

**注意**：Worker 回滚不回滚 D1，所以本计划只允许 additive migration。

---

### Phase 10：文档、运维与最终验证

#### T10.1 同步更新 EN/ZH 文档

**文件**：`README.md`、`README.zh.md`、`doc/setup_guide*.md`、`doc/tips*.md`、`doc/mcp*.md`。

- [ ] 删除“直接修改源码变量”的过时说明。
- [ ] 文档统一使用 Cloudflare Secrets、严格布尔变量和安全模式。
- [ ] 说明 POST 注册、GET 兼容期限、已有 key 重绑规则。
- [ ] 说明 D1 migration、AutoMigrate 兜底和 Cron UTC 行为。
- [ ] 说明 Rate Limiting binding 是本地、最终一致，不能替代硬上限。
- [ ] 说明 APNs 4 KiB、错误分类、无同步自动重试。
- [ ] 说明 MCP 支持版本、202 notification 和 SSE 不支持边界。
- [ ] 文档示例不得把 token/key 放在 URL、命令历史或截图中。

#### T10.2 把 `test.sh` 变成可判定 smoke test

- [ ] 使用 `set -euo pipefail`、`curl --fail-with-body` 和明确断言。
- [ ] 默认只跑无副作用检查。
- [ ] 真实注册/推送必须通过显式 `RUN_DESTRUCTIVE_TESTS=1` 开启。
- [ ] 所有 URL、认证和 device key 从环境读取，输出时脱敏。
- [ ] 对每个 HTTP 状态和关键 JSON 字段做断言。

#### T10.3 上线门禁

- [ ] `npm run verify` 全绿。
- [ ] 无秘密扫描命中。
- [ ] D1 migration 空库、现有库、重复执行均通过。
- [ ] D1 cleanup 的 `EXPLAIN QUERY PLAN` 使用索引。
- [ ] D1、KV 安全回归均通过，或 KV 已正式弃用。
- [ ] staging 连续运行至少一个 Cron 周期，无未捕获异常。
- [ ] 速率限制、批量 20/21 边界、32 KiB body、4096-byte APNs payload 边界均有测试。
- [ ] 生产 canary 后检查 401/409/413/429/5xx、APNs latency、D1 writes、Cron 删除数。
- [ ] 未发现回归后再全量；保留回滚版本和 D1 备份。

## 6. 建议的提交边界

每个提交必须能独立审查和回退：

1. `test: add security regression harness`
2. `security: move APNs and auth credentials to secrets`
3. `security: harden registration and authentication policy`
4. `fix: validate requests and bound batch push concurrency`
5. `fix: harden APNs token and response handling`
6. `fix: make AutoMigrate awaited and move session cleanup to cron`
7. `fix: normalize routing and device identifiers safely`
8. `fix: enforce MCP lifecycle and session isolation`
9. `ci: make verification and deployment reproducible`
10. `docs: publish secure migration and operations guide`

禁止把所有修改压成一个不可审查的大提交。

## 7. 问题覆盖矩阵

| 原编号 | 修复任务 | 验收重点 |
| --- | --- | --- |
| 1 | T0.1、T2.1 | 旧 Key 撤销；源码/历史泄漏不再被误认为“删除即修复” |
| 2–4 | T2.2、T2.3、T3.1 | strict fail closed；register 认证；旧 GET 显式兼容 |
| 5 | T3.1、T4.3 | Rate Limiting binding + 代码硬上限 |
| 6 | T3.1、T7.2 | POST 主接口；GET 兼容及 method 约束 |
| 7 | T2.3、T3.2 | device key 不再是唯一保护层 |
| 8–9 | T6.2、T6.3 | Cron 清理；两个时间索引；查询计划证明 |
| 10–11 | T6.1、T6.2 | AutoMigrate 保留但 awaited/once；migration 权威 |
| 12 | T5.1 | 统一 Base64URL helper 和随机签名测试 |
| 13–14 | T5.2、T5.3 | 空/非法 APNs 错误、超时和状态映射 |
| 15 | T4.3 | 批量大小、去重、受控并发、单项隔离 |
| 16–17 | T4.1、T4.2 | body/payload/type/schema 边界 |
| 18–19 | T7.1 | 精确 key、legacy fallback、碰撞审计、token hex 校验 |
| 20 | T2.2 | 严格布尔解析和配置错误 |
| 21 | T4.1 | Query/Form 不重复解码；path 单次安全解码 |
| 22–23 | T7.2 | ROOT_PATH 边界和 405/Allow |
| 24 | T4.3 | 保持 200 兼容并追加明确统计 |
| 25–26 | T2.3、T7.3 | 错误最小化；info 认证及默认不查数量 |
| 27 | T5.1 | JWT 改为 isolate 缓存，停止新 D1/KV 明文写入 |
| 28–29 | T8.1、T8.2 | Session 归属、初始化门禁、协议版本 |
| 30 | T7.3 | 顶层异常、request ID、结构化日志 |
| 31–36 | T9.1–T9.3 | 分支、配置、Secrets、权限、工具版本统一 |
| 37 | T1.2、T9.1 | 精确依赖版本和 lockfile |
| 测试缺口 | T1.1、T10.2、T10.3 | 每条高风险链均有自动化和 staging 证据 |

## 8. 官方约束依据

- Cloudflare Secrets：<https://developers.cloudflare.com/workers/configuration/secrets/>
- Cloudflare Rate Limiting binding：<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- Cloudflare Cron Triggers：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- Cloudflare D1 migrations：<https://developers.cloudflare.com/d1/reference/migrations/>
- Cloudflare D1 indexes：<https://developers.cloudflare.com/d1/best-practices/use-indexes/>
- Cloudflare Workers limits：<https://developers.cloudflare.com/workers/platform/limits/>
- Cloudflare GitHub Actions：<https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/>
- Cloudflare rollbacks：<https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>
- Apple APNs token authentication：<https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns>
- Apple APNs request/payload：<https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns>
- Apple APNs responses：<https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns>
- MCP 2025-06-18 lifecycle：<https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle>
- MCP 2025-06-18 transport：<https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>
- Bark 上游注册兼容实现：<https://github.com/Finb/bark-server/blob/master/route_register.go>

## 9. 执行纪律

- 每开始一个 Phase，先把相应失败测试落地，再改实现。
- 每完成一个任务，立即运行最小相关测试；每个 Phase 完成后运行 `npm run verify`。
- 任何“完成”声明必须附命令输出、staging/production 证据和工作树差异。
- 不使用真实生产 token 做单元测试；真实 APNs 仅在明确 canary 阶段执行一次。
- 遇到兼容冲突时优先保留旧行为的显式开关，不添加隐藏 fallback。
- 发现计划外高风险问题时先更新本文件的依赖和验收，再继续实现。
