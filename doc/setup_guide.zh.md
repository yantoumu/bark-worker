# 安全部署指南

本文说明如何准备一个新部署，不代表任何 Worker、数据库、Secret、APNs Key、migration 或 canary 已经创建或验证完成。

> [!IMPORTANT]
> `main.js` 是 `wrangler.jsonc` 和 GitHub Actions 工作流选中的默认 D1 生产入口。`main_kv.js` 是需要单独手工配置的 KV 兼容入口；它不支持 MCP，也不会由默认配置部署。

## 1. 前置条件

你需要：

- 具有 Workers 和 D1 权限的 Cloudflare 账户。
- 对配置 topic 有权限的 Apple Developer APNs 签名 Key。
- 与 CI 版本一致的 Node.js，以及支持 lockfile 的 npm。
- 符合客户端预期、采用准确 `username:password` 格式的强 Basic Auth 值。

安装依赖前先审查 `package.json`。本仓库使用已提交的 lockfile 和项目本地 Wrangler，应执行 `npm ci`，不要另行全局安装 Wrangler。

```sh
npm ci
npx wrangler login
```

## 2. 创建并绑定 D1

生产数据库只创建一次，并且必须在日常部署工作流之外完成：

```sh
npx wrangler d1 create database-bark
```

binding 名称必须是 `database`。已提交的 `wrangler.jsonc` 刻意只保留一个数据库 UUID 占位符。手工部署时，应把真实的规范 UUID 渲染到 `.wrangler/` 下被忽略的配置，或维护等效、未跟踪的环境专用配置；不要提交生产环境渲染文件。CI 从 GitHub Variable `CLOUDFLARE_D1_DATABASE_ID` 读取 UUID，并校验占位符恰好被替换一次。

不要在 CI 中创建 D1。staging 与 production 必须使用不同数据库。

## 3. 配置运行时 Secrets

下列值是运行时凭据，必须保存为 Cloudflare Secrets：

| Secret | 用途 |
| --- | --- |
| `BASIC_AUTH` | `username:password` 格式的准确 Basic Auth 凭据对 |
| `APNS_PRIVATE_KEY` | APNs PKCS#8 私钥 |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_KEY_ID` | APNs 签名 Key ID |
| `APNS_TOPIC` | 该 Key 有权限的 APNs topic |

通过 Wrangler 交互式提示分别写入，避免值出现在 shell 参数或命令历史中：

```sh
npx wrangler secret put BASIC_AUTH
npx wrangler secret put APNS_PRIVATE_KEY
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TOPIC
```

执行这些命令时必须选定正确环境/配置。绝不能把这些值放进 `vars`、源码、workflow input、URL、日志、Issue 或截图。本地开发可把 `.dev.vars.example` 复制为已忽略的 `.dev.vars`，再仅在本机替换占位符；不要提交该文件。

缺少 required secret 时会安全失败：受保护接口返回配置错误，`/healthz` 返回 HTTP 503，不会静默退化为匿名访问。

### APNs Key 事故处置规则

如果 APNs 私钥曾出现在源码、Git 历史、日志或共享产物中，必须按泄漏处理：在 Apple Developer 后台撤销旧 Key，创建替代 Key，更新 Cloudflare Secret，并在 staging 验证。仅删除仓库中的旧文本不等于轮换，也不能把旧 Key 重新启用作为回滚手段。

## 4. 配置非秘密变量

非秘密设置放入 Wrangler `vars`。布尔设置只接受小写字符串 `"true"` 或 `"false"`，其他拼写都会产生配置错误。

| 变量 | 安全默认值 | 含义 |
| --- | --- | --- |
| `SECURITY_MODE` | `strict` | `strict`，或显式、临时的 `compat` 迁移模式 |
| `ALLOW_NEW_DEVICE` | `true` | 允许已认证请求创建未知 key |
| `ALLOW_QUERY_NUMS` | `false` | 允许已认证 `/info` 查询设备数量 |
| `ALLOW_LEGACY_GET_REGISTER` | `false` | 仅在迁移期间开放已弃用的 GET 注册 |
| `LEGACY_GET_REGISTER_SUNSET` | 未设置 | 开放旧 GET 时必填；必须是用于 `Sunset` 响应头的合法 HTTP-date |
| `ALLOW_INSECURE_DEVICE_REBIND` | `false` | 仅 compat 使用的临时未认证重绑逃生开关 |
| `ROOT_PATH` | `/` | `/` 或绝对挂载路径；尾斜杠会被规范化 |
| `MAX_REQUEST_BYTES` | `32768` | 流式 HTTP 请求体最大字节数 |
| `MAX_BATCH_SIZE` | `20` | 单批唯一设备最大数量 |
| `BATCH_CONCURRENCY` | `5` | APNs 最大并发数 |
| `APNS_TIMEOUT_MS` | `10000` | APNs 超时；合法范围 1000–30000 ms |
| `MCP_ALLOWED_ORIGINS` | 未设置 | 逗号分隔的 MCP exact origin，见下文 |

`SECURITY_MODE="strict"` 要求注册、推送、MCP 和 `/info` 都通过 Basic Auth。`compat` 只能用于有指标、责任人和退出日期的迁移；它绝不会关闭 MCP 认证。

如果设置 `ALLOW_LEGACY_GET_REGISTER="true"`，还必须把 `LEGACY_GET_REGISTER_SUNSET` 设置为合法 HTTP-date；缺失或非法值都是配置错误。不要在自动化中虚构日期，应选择并记录真实迁移截止时间。GET 响应会携带该 `Sunset` 值以及弃用和禁止缓存响应头。

`MCP_ALLOWED_ORIGINS` 是 trim 后以逗号分隔的 exact origin 列表。每项格式为 `scheme://host[:port]`，不支持通配符。非浏览器客户端可以不发送 `Origin`；如果请求携带 `Origin`，allowlist 为空或未精确匹配都会返回 HTTP 403。

## 5. 配置防滥用与硬上限

D1 Wrangler 配置声明了四个 Rate Limiting binding：

| Binding | 预算 |
| --- | ---: |
| `REGISTER_RATE_LIMITER` | 每个注册主体 5 次/60 秒 |
| `PUSH_RATE_LIMITER` | 每个 device key 60 次/60 秒 |
| `BATCH_RATE_LIMITER` | 每个认证主体 10 次/60 秒 |
| `MCP_RATE_LIMITER` | 每个 Session/主体 60 次/60 秒 |

Cloudflare 在各数据中心局部计数，并以最终一致方式传播。它们能减少滥用，但不是精确全局配额。必须继续执行同步硬上限：32 KiB 请求体、单批 20 个设备、最多五个 APNs 并发，以及最终 APNs JSON payload 4096 UTF-8 bytes。

Rate Limiting namespace ID 的作用域是 Cloudflare 账户。仓库中的 `1001` 到 `1004` 只是本地 dry-run 默认值，不能证明它们在目标账户中空闲。必须预留两段互不重叠的连续四个 ID，分别把 base 配置为 `STAGING_RATE_LIMIT_NAMESPACE_BASE` 和 `PRODUCTION_RATE_LIMIT_NAMESPACE_BASE`；渲染脚本会分配 `base+1` 到 `base+4`。CI 会拒绝这两段渲染区间重叠，但无法发现其他 Worker 已使用的 ID；部署前必须记录两段预留并确认账户内全局唯一。

## 6. 应用 D1 migration

`migrations/` 下的 SQL 文件是权威 schema 历史。先在本地应用并验证：

```sh
npm run db:migrate
npm run verify
```

远程 production migration 前，先把可恢复的 D1 备份导出到已忽略的 `.backups/`，立即加密并删除明文，再使用与部署相同的生产渲染配置应用 migration。`D1_BACKUP_ENCRYPTION_KEY` 必须预先通过受保护环境提供，其格式为恰好 32 个随机字节的规范 Base64；绝不能把它粘贴到命令行。验证期间不要打印含设备数据的数据库行。

```sh
mkdir -p .backups
umask 077
npx wrangler d1 export database --remote --config .wrangler/wrangler.production.jsonc --output=.backups/bark-before-migration.sql
node .github/scripts/encrypt-d1-backup.mjs .backups/bark-before-migration.sql .backups/bark-before-migration.sql.enc
rm -f -- .backups/bark-before-migration.sql
npx wrangler d1 migrations apply database --remote --config .wrangler/wrangler.production.jsonc
```

必须在独立受控位置保存加密 key 的恢复副本，因为 GitHub Environment Secret 无法回读。下载 artifact 后，先通过获批的秘密管理器把恢复 key 加载到环境，再执行：

```sh
node .github/scripts/decrypt-d1-backup.mjs \
  .backups/bark-before-migration.sql.enc \
  .backups/bark-restored.sql
```

解密会校验 AES-256-GCM authentication tag；认证失败时会删除任何不完整明文。任何受控恢复前，都必须先在隔离的本地 D1 中检查并演练恢复出的 SQL；CI 绝不会自动恢复 production D1。

AutoMigrate 保留为可等待、幂等的首次运行/手工复制场景兜底。所有依赖 D1 的请求都会等待 schema 就绪，失败时返回 HTTP 503。AutoMigrate 不能替代 Wrangler migration ledger，也不能作为常规生产迁移机制。

默认 D1 部署还注册了 `0 * * * *`。Cloudflare Cron 使用 UTC，因此 scheduled handler 会在每个 UTC 整点清理过期 MCP Session。HTTP 请求路径不会执行 Session 清理。

## 7. 验证、部署、再 smoke test

最低本地门禁是：

```sh
npm run verify
```

它检查语法、带覆盖率阈值的完整测试套件，以及本地 Wrangler dry run；CI 还会额外执行仓库秘密扫描。dry run 通过只能证明本地产物/配置可构建，不能证明已部署到 production。

远程操作保持单向顺序：

1. 验证并 dry-run 完全相同的渲染配置。
2. 备份目标 D1。
3. 应用 additive D1 migration。
4. 部署 Worker。
5. 执行有边界的 smoke 检查并查看日志，同时避免暴露凭据和设备数据。

先执行公开、无副作用的检查：

```sh
curl --fail-with-body "$BARK_BASE_URL/ping"
curl --fail-with-body "$BARK_BASE_URL/healthz"
```

注册、推送和 MCP smoke 检查有副作用或需要认证，只能通过仓库中受门禁控制的 smoke 工具执行，并由环境提供秘密。不要把真实 device key、token、Basic Auth 值或 MCP Session ID 输入 URL 或终端命令，也不要把它们截进截图。

### 注册迁移

使用 Bark App 或能把敏感值保留在请求体中的客户端调用 `POST /register`。请求结构为：

```http
POST /register
Authorization: Basic <redacted>
Content-Type: application/json

{"device_key":"<从受保护客户端存储读取>","device_token":"<从受保护客户端存储读取>"}
```

旧请求体字段 `key` 和 `devicetoken` 仍被接受。不要再使用已弃用的 GET query 形式。对于已有 key，相同 token 是幂等成功；更换 token 必须认证。未认证的更换返回 HTTP 409，除非有意开启了仅 compat 可用的不安全重绑逃生开关。

## 8. GitHub Actions 生产门禁

分别创建受保护的 `staging` 与 `production` GitHub Environment，并要求 production 经过审批人批准。配置：

- Repository-level GitHub Variables：`STAGING_RATE_LIMIT_NAMESPACE_BASE` 和 `PRODUCTION_RATE_LIMIT_NAMESPACE_BASE`。必须保持单一事实来源，不能在 staging 或 production Environment 级覆盖任一值，否则隔离比较可能读到不同配置。
- Staging Environment Variables：`STAGING_WORKER_NAME`、`STAGING_D1_DATABASE_ID` 和 `STAGING_SMOKE_URL`。
- Production Environment Variables：`CLOUDFLARE_D1_DATABASE_ID` 和 `PRODUCTION_SMOKE_URL`。
- 对应 Environment 的 GitHub Secrets：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`，以及 workflow 引用的 smoke 凭据；production 还必须配置 `D1_BACKUP_ENCRYPTION_KEY`。
- Cloudflare Worker Secrets：上文五个运行时 Secret，各环境分别配置。

门禁保持 production 位于 verify → staging migration → staging deploy → staging smoke → production Secret 名称检查/旧版本记录 → 加密备份 → production migration → production deploy → production smoke 之后。artifact 仅上传密文并保留一天；明文会立即删除，并由 `always()` cleanup 再次清理。workflow 使用 `npm ci`、仓库本地锁定的 Wrangler、只读仓库权限以及 `master` 分支。创建 production D1 是一次性 bootstrap 动作，绝不能加入 CI。

## 9. 手工部署 KV 兼容入口

如需继续使用 `main_kv.js`，应创建独立 Worker 配置，把入口设为 `main_kv.js`，并把 KV namespace binding 命名为 `database`。同时复用适用的 Secrets、strict 变量、注册/推送限流、请求硬上限和环境隔离规则。

这是手工兼容路径，不是已提交 Wrangler 配置或 workflow 可选择的替代项。它不提供 MCP、D1 migration、D1 AutoMigrate 或 D1 Session Cron。不要把 KV 部署描述成与默认 D1 生产服务完全等价。

## 10. 回滚边界

部署前记录上一个 Worker version。部署后的 production smoke 失败时，workflow 会把 Worker 回滚到该版本，但绝不会恢复 D1；因此 migration 必须保持 additive 且兼容旧 Worker。绝不能回滚到已撤销或已泄漏的 APNs Key。
