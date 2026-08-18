<p align="center">
    <h1 align="center">Bark-Worker</h1>
</p>

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

**[English](README.md)** | 中文文档

Bark-Worker 是运行在 Cloudflare Workers 上的 [Bark 服务端](https://github.com/Finb/bark-server)实现，为 [Bark iOS App](https://github.com/Finb/Bark) 提供轻量、自托管的通知后端。

> [!IMPORTANT]
> `main.js` 是默认生产入口。仓库内的 Wrangler 配置和部署工作流都以这个 D1 版本为目标。`main_kv.js` 仍是需要手工部署的 KV 兼容入口：它不支持 MCP，也不会被默认部署路径选中。两个入口仍共同维护认证、注册、校验、APNs 和错误处理等通用安全行为。

## 接口

- `GET /ping`：公开的存活检查。
- `GET /healthz`：就绪检查，不泄露敏感配置细节。
- `GET /info`：需认证的服务信息；仅当 `ALLOW_QUERY_NUMS="true"` 时才显示设备数量。
- `POST /register`：主注册接口。支持 JSON 或表单字段 `device_key`、`device_token`，并兼容旧字段名 `key`、`devicetoken`。
- `POST /push`：JSON 或表单推送接口，支持有硬上限的批量推送。
- Bark 路径式推送：为兼容现有客户端，继续支持原有 GET 和 POST 路径。
- `POST /mcp` 和 `DELETE /mcp`：仅 D1 版本支持的 MCP Streamable HTTP 生命周期，详见 [MCP](doc/mcp.zh.md)。

当提供非空 `device_keys` 时，批量模式优先。为保持 Bark 兼容，批量响应外层仍为 HTTP 200，并提供逐项结果以及 `success_count`、`failed_count`、`partial_failure`。

## 安全默认值

仓库配置默认使用 `SECURITY_MODE="strict"`。在 strict 模式下，注册、推送、MCP 和 `/info` 都需要 HTTP Basic 认证，只有 `/ping` 保持公开。缺少 `BASIC_AUTH` 时会安全失败：受保护接口及就绪检查返回配置错误，不会退化为匿名放行。

运行时凭据必须使用 Cloudflare Secrets，不能放进 Wrangler `vars` 或源码常量：

- `BASIC_AUTH`
- `APNS_PRIVATE_KEY`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_TOPIC`

布尔配置只接受小写字符串 `"true"` 和 `"false"`；例如 `"False"` 会被视为配置错误。`SECURITY_MODE="compat"` 是需要显式开启的临时迁移模式，不是推荐的生产默认值，也绝不会关闭 MCP 认证。

注册主接口是 `POST /register`。只有设置 `ALLOW_LEGACY_GET_REGISTER="true"` 才会开放旧 GET 注册，同时还必须把 `LEGACY_GET_REGISTER_SUNSET` 设置为合法 HTTP-date；缺失或非法日期都是配置错误。开启后的响应带有 `Deprecation`、已配置的 `Sunset`、`Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。应以该 `Sunset` 值作为迁移截止时间。不要把真实 device token 或 key 放入 URL、终端历史、日志、支持工单或截图。

已有 key 的处理规则刻意保持保守：

- 相同 key 和 token 是幂等成功，不重复写入。
- 更换为不同 token 必须通过 Basic Auth。
- 未认证的重绑返回 HTTP 409。
- `ALLOW_INSECURE_DEVICE_REBIND="true"` 仅是 `SECURITY_MODE="compat"` 下的迁移逃生开关；除非执行有边界且可监控的迁移，否则必须保持关闭。

## 资源预算

| 边界 | 默认值 |
| --- | ---: |
| 请求体 | 32 KiB（`MAX_REQUEST_BYTES="32768"`） |
| 最终 APNs JSON payload | 4096 UTF-8 bytes |
| 单批设备数 | 20（`MAX_BATCH_SIZE="20"`） |
| APNs 并发数 | 5（`BATCH_CONCURRENCY="5"`） |
| APNs 超时 | 10 秒（`APNS_TIMEOUT_MS="10000"`，合法范围 1–30 秒） |

四个 Cloudflare Rate Limiting binding 分别是 `REGISTER_RATE_LIMITER`（5 次/60 秒）、`PUSH_RATE_LIMITER`（60 次/60 秒）、`BATCH_RATE_LIMITER`（10 次/60 秒）和 `MCP_RATE_LIMITER`（60 次/60 秒）。其计数按数据中心局部生效且最终一致，因此它们只是防滥用层，不是精确的全局配额，也不能替代同步执行的请求体、批量、并发和 APNs payload 硬上限。

## 存储与生命周期

`migrations/` 中的 D1 migration 是生产 schema 的权威历史；依赖新结构的代码部署前必须先应用 migration。可等待的 AutoMigrate 是首次运行或手工复制部署时的幂等兜底，不能替代 migration 记录。schema 就绪失败时，依赖 D1 的接口返回 HTTP 503。

D1 入口通过 `0 * * * *` 的 scheduled handler 清理过期 MCP Session，即每个 UTC 整点执行一次。HTTP 请求不会执行 Session 清理。

APNs 请求的 payload 上限为 4096 bytes，并有明确超时。超时映射为 HTTP 504，网络故障映射为 502，APNs 5xx 映射为 503；限流保留 429 和 `Retry-After`。响应会标记可重试错误，但 Worker 不会在同步请求内自动重试通知，因为这可能产生重复推送。任何曾经出现在源码或 Git 历史中的 APNs 签名 Key 都必须在 Apple Developer 后台撤销并轮换；仅从文件中删除不算完成处置。

## 部署

请按[安全部署指南](doc/setup_guide.zh.md)在 CI 外创建 D1、配置 `database` binding、交互式写入 Cloudflare Secrets、应用 migration、本地验证并部署。生成 bundle、dry run 或单元测试通过，都不能证明生产环境已部署或 APNs Key 已完成轮换。

更多运维和迁移说明见 [Tips](doc/tips.zh.md)。MCP 客户端连接前应先阅读 [MCP 生命周期与安全合同](doc/mcp.zh.md)。
