# API 概览（Redis + LINUX DO OAuth）

Base: `http://127.0.0.1:8787`  
Auth: **Cookie 会话**（OAuth 登录后 `wa_session`），`credentials: include`

## 认证

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/v1/auth/config` | `{ oauthEnabled, provider, localAuthEnabled, inviteRequiredForLocal, bootstrapAvailable, passwordMinLength }`<br>`bootstrapAvailable=true` 表示库中尚无用户且未配置管理员，首个本地注册可免邀请码 |
| GET | `/api/v1/auth/login` | 跳转 LINUX DO OAuth |
| GET | `/api/v1/auth/callback` | OAuth 回调（新 OAuth 用户**不需要**邀请码） |
| POST | `/api/v1/auth/register` | 本地注册：`{ inviteCode, username, password, name? }` → cookie |
| POST | `/api/v1/auth/password-login` | 用户名密码登录：`{ username, password }` → cookie |
| GET | `/api/v1/auth/invite/:code` | 预检邀请码（不消费） |
| POST | `/api/v1/auth/logout` | 退出 |
| GET | `/api/v1/auth/me` | 当前用户（含 `authProvider`、`isSuperAdmin`，不含密码） |

## 邀请（登录用户）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/v1/me/invites` | pending 列表 + 配额 + 邀请链接 |
| POST | `/api/v1/me/invites` | 生成一次性码；受「每 X 小时 N 个」滑动窗口限制 |
| DELETE | `/api/v1/me/invites/:code` | 撤销未使用码 |

邀请链接形态：`{PUBLIC_BASE_URL}/app?invite={CODE}`（打开后自动填入注册表单）。

## 用户

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/v1/me/bots` | 我的机器人 |
| POST | `/api/v1/me/bots/login/start` | 扫码添加机器人（新建 botId） |
| POST | `/api/v1/me/bots/:botId/relogin/start` | **重新扫码绑定**（更新 token，保留 peers/记忆/分配） |
| GET | `/api/v1/me/bots/login/:sessionId` | 扫码状态 |
| DELETE | `/api/v1/me/bots/:botId` | 删除自己的机器人（含 Redis token） |
| GET | `/api/v1/me/peers` | 私聊用户 |
| POST | `/api/v1/me/peers/approve` | 批准 |
| PUT | `/api/v1/me/assignments` | 分配人设（须在库中） |
| GET | `/api/v1/me/personas` | 我的库 + 我创建的 |
| POST | `/api/v1/me/personas/:id/add` | 添加人设到库 |
| DELETE | `/api/v1/me/personas/:id` | 从库移除 |
| GET | `/api/v1/me/memories?botAccountId=&peerId=&personaId?` | 长期记忆；无 personaId 时返回 `{total,groups}` |
| POST | `/api/v1/me/memories/reset` | `{ botAccountId, peerId, personaId? }` 清空记忆 |
| DELETE | `/api/v1/me/memories` | `{ botAccountId, peerId, personaId, memoryId }` 删单条 |
| GET | `/api/v1/me/wechat-bind` | 当前 LINUX DO ↔ 微信绑定状态（`reachable` 表示是否有 context_token） |
| POST | `/api/v1/me/wechat-bind/code` | 生成 6 位绑定码（微信 `/绑定 CODE`） |
| DELETE | `/api/v1/me/wechat-bind` | 解除绑定并结束相关用户对话 |
| GET | `/api/v1/me/blocks` | 我的黑名单（LINUX DO 用户） |
| POST | `/api/v1/me/blocks` | `{ username }` 或 `{ userId }` 拉黑 |
| DELETE | `/api/v1/me/blocks/:userId` | 取消拉黑 |

## 人设广场

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/v1/square/personas?q=&page=&limit=&sort=heat\|use\|recent\|name` | 搜索公开人设（默认 sort=heat；字段含 useCount / assignCount / forkCount / heatScore / forkedFrom） |
| GET | `/api/v1/square/personas/:id` | 详情（含 systemPrompt） |
| POST | `/api/v1/square/personas` | 发布（public/private） |
| POST | `/api/v1/square/personas/:id/fork` | Fork 为当前用户私有草稿（`PERSONA_FORK_ENABLED`，默认开） |
| PUT | `/api/v1/square/personas/:id` | 作者更新 |
| DELETE | `/api/v1/square/personas/:id` | 作者软删除 |
| GET | `/api/v1/square/stickers?q=&page=&limit=&sort=use\|recent\|name` | 已审核公开表情包（默认 sort=use） |
| GET | `/api/v1/square/stickers/:id` | 详情（`imageUrl` 对公开已审为 CDN 路径） |
| GET | `/api/v1/square/stickers/:id/image` | 预览图（**鉴权**；私有/待审/作者预览） |
| GET | `/cdn/s/:id?v={content_hash}` | **公开 CDN**（无 Cookie）：仅 `public`+`approved`+`enabled`；长缓存 immutable |
| POST | `/api/v1/square/stickers` | 投稿（public→待审 / private 自用） |
| PUT | `/api/v1/square/stickers/:id` | 作者更新（公开改动回待审） |
| DELETE | `/api/v1/square/stickers/:id` | 作者软删除 |
| GET | `/api/v1/me/stickers` | 我的库 + 我创建的 |
| POST | `/api/v1/me/stickers/:id/add` | 加入表情库 |
| DELETE | `/api/v1/me/stickers/:id` | 从库移除（对称递减 use_count） |

## 网页试聊

不经微信，在 `/app` 内限量体验公开/可用人设。计入用户 Token 用量；会话存 Redis TTL。

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/v1/try-chat/sessions` | `{ personaId, botName? }` → `{ sessionId, persona, remainingToday, expiresInSec }` |
| POST | `/api/v1/try-chat/sessions/:sessionId/messages` | `{ text }` → `{ messages[], remainingToday, remainingSession, usage }` |
| DELETE | `/api/v1/try-chat/sessions/:sessionId` | 结束会话 |

环境变量：`TRY_CHAT_ENABLED`、`TRY_CHAT_MAX_USER_MSGS_PER_DAY`、`TRY_CHAT_MAX_USER_MSGS_PER_SESSION`、`TRY_CHAT_SESSION_TTL_SEC`、`TRY_CHAT_MAX_HISTORY`。

热度公式：`heatScore = use_count*2 + assign_count*5 + fork_count*3`（分配仅在 persona 变化时 +1）。

## 管理员

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/v1/admin/dashboard` | 仪表盘 + 今日 Token + **全舰队** workerStats + nodes 摘要 + Redis |
| GET | `/api/v1/admin/system` | 系统健康 / doctor / **全舰队** workerStats / nodes 摘要 |
| GET | `/api/v1/admin/nodes` | **仅超管** 部署节点列表（含 fenced） |
| POST | `/api/v1/admin/nodes/:workerId/force-offline` | **仅超管** 强制下线 |
| POST | `/api/v1/admin/nodes/:workerId/clear-fence` | **仅超管** 解除封锁 |
| POST | `/api/v1/admin/nodes/:workerId/weight` | **仅超管** 设负载权重 `{ weight: 0..500 }` |
| DELETE | `/api/v1/admin/nodes/:workerId/weight` | **仅超管** 恢复默认权重（100%） |
| POST | `/api/v1/admin/nodes/weights/prune` | **仅超管** 立即清理失效权重（平时会自动过期） |
| POST | `/api/v1/admin/workers/restart-all` | **仅超管** 批量恢复 pollable 并尝试认领（有 token 的 active bot） |
| POST | `/api/v1/admin/workers/stop-all` | **仅超管** 暂停全部可轮询 bot（写 pause 标记，不删账号） |
| POST | `/api/v1/admin/system/seed-personas` | 幂等补种官方人设 |
| GET | `/api/v1/admin/memories?botAccountId=&peerId=` | 查看 peer 长期记忆（按人设分组） |
| DELETE | `/api/v1/admin/memories` | `{ botAccountId, peerId, personaId, memoryId }` 删单条 |
| POST | `/api/v1/admin/memories/reset` | `{ botAccountId, peerId, personaId? }` 清记忆 |
| POST | `/api/v1/admin/messages/clear` | `{ botAccountId, peerId }` 清除短期对话历史（保留长期记忆） |
| GET | `/api/v1/admin/peers?status=unapproved\|approved\|all` | 全站私聊 peer（默认待批准） |
| POST | `/api/v1/admin/peers/approve` | `{ botAccountId, peerId }` 管理员代批 |
| POST | `/api/v1/admin/peers/approve-all` | 批准全部待批准 peer |
| GET | `/api/v1/admin/usage?day=` | 按日用量 |
| GET | `/api/v1/admin/usage?days=7` | 近 N 日用量列表 |
| GET | `/api/v1/admin/users` | 用户全量列表（含 botCount、isBanned、authProvider、isSuperAdmin） |
| GET | `/api/v1/admin/users/:id` | 用户详情 + 名下机器人 |
| PATCH | `/api/v1/admin/users/:id` | **仅超管** `{ isAdmin }` 授予/撤销管理员（不可撤自己/最后一位；**不可撤超管**） |
| POST | `/api/v1/admin/users/:id/ban` | `{ reason?, cascadeBots? }` 封禁（踢 session；默认级联停用 bot；**不可封超管**） |
| POST | `/api/v1/admin/users/:id/unban` | 解封（不自动启 bot） |
| DELETE | `/api/v1/admin/users/:id?confirm=username` | 删除用户（级联删 bot/session/索引；**不可删超管**） |

> **超管**：仍为管理员的用户中 `created_at` 最早者（系统首位管理员）。对超管的撤销管理 / 封禁 / 删除一律拒绝（`cannot_revoke_super_admin` / `cannot_ban_super_admin` / `cannot_delete_super_admin`）。
| GET | `/api/v1/admin/settings/invites` | 邀请策略（配额窗口小时 / 每窗口上限 / TTL / pending） |
| PATCH | `/api/v1/admin/settings/invites` | 更新邀请策略（Redis 覆盖 env 默认） |
| GET | `/api/v1/admin/settings/runtime` | **仅超管** 运行时配置：分组 + 全部项（当前值 / env 默认 / 是否已覆盖 / 是否需重启）+ 警告 |
| PATCH | `/api/v1/admin/settings/runtime` | **仅超管** `{ patch: {key: value}, reset: [key] }` 写 Redis 覆盖 |
| POST | `/api/v1/admin/settings/runtime/reset` | **仅超管** 删除全部覆盖，回到 `.env` |

> 运行时配置详见 [`docs/runtime-settings.md`](./runtime-settings.md)：`.env` 是默认值，Redis 存覆盖，各节点 5 秒内同步。密钥字段 GET 只返回掩码；PATCH 传空 = 不改，传 `-` = 清空。
| GET | `/api/v1/admin/bots` | 全部机器人（owner、worker、hasToken、peer 计数；前端分页，后端批量读） |
| GET | `/api/v1/admin/bots/:botId` | 机器人详情 + peers |
| PATCH | `/api/v1/admin/bots/:botId` | 改名 / `{ status: active\|inactive }` 启停 |
| POST | `/api/v1/admin/bots/:botId/stop-worker` | **仅超管** 停止 Worker 轮询 |
| POST | `/api/v1/admin/bots/:botId/start-worker` | **仅超管** 启动/重启 Worker（需已有 Redis token） |
| GET | `/api/v1/admin/bots/:botId/inbox` | **仅超管** `pending` / `failed` 计数和最多 100 条失败任务元数据，不含消息正文或凭据 |
| POST | `/api/v1/admin/bots/:botId/inbox/:jobId/retry` | **仅超管** 将失败任务追加回对应聊天对象队尾，保留检查点、重置重试次数；写审计 |
| DELETE | `/api/v1/admin/bots/:botId` | 删除机器人 |
| GET | `/api/v1/admin/bots/:botId/send-targets` | **仅超管** 该 bot 的 peers + `hasContextToken`（广播勾选） |
| POST | `/api/v1/admin/broadcast` | **仅超管** 创建广播任务或 `preview:true` 仅预估人数 |
| GET | `/api/v1/admin/broadcast?limit=` | **仅超管** 最近广播任务列表 |
| GET | `/api/v1/admin/broadcast/:id` | **仅超管** 任务详情与进度 |
| POST | `/api/v1/admin/broadcast/:id/cancel` | **仅超管** 取消 pending/running 任务 |
| GET | `/api/v1/admin/personas?q=&includeDisabled=1` | 人设列表 |
| GET | `/api/v1/admin/personas/:id` | 详情（含 prompt） |
| POST | `/api/v1/admin/personas` | 创建官方人设（可带 tags / isDefault） |
| PUT | `/api/v1/admin/personas/:id` | 更新元信息 / prompt |
| POST | `/api/v1/admin/personas/:id/publish` | 发布新版本 prompt |
| POST | `/api/v1/admin/personas/:id/takedown` | 下架非官方人设 |
| POST | `/api/v1/admin/personas/:id/restore` | 恢复已下架 |
| POST | `/api/v1/admin/personas/:id/set-default` | 设为默认人设 |
| GET | `/api/v1/admin/audit?limit=` | 审计 |
| GET | `/api/v1/admin/stream/recent?limit=&types=&full=` | **仅超管** 活动数据流 backlog（消息 / Worker / LLM；`full=1` 消息预览加长；`types=message,redis,worker,llm`） |
| GET | `/api/v1/admin/stream?types=&full=&heartbeat=` | **仅超管** SSE 实时数据流（`text/event-stream`；Redis 命令为进程内抽样，不写 Redis backlog） |
| GET | `/api/v1/admin/stickers?q=&enabled=` | 表情包列表 |
| GET | `/api/v1/admin/stickers/:id` | 表情详情 |
| GET | `/api/v1/admin/stickers/:id/image` | 预览原图（admin cookie） |
| POST | `/api/v1/admin/stickers` | 上传：`{ slug, displayName, description?, tags?, mime?, dataBase64, enabled? }` |
| PUT | `/api/v1/admin/stickers/:id` | 更新元信息 / 可选换图 |
| DELETE | `/api/v1/admin/stickers/:id` | 删除 meta + 本地文件 |

页面：`/` 功能介绍 · `/app` 用户中心 · `/admin` 管理后台 · `/og.jpg` 社交分享图

### 表情包广场 / 回图

- **元数据 + 图片二进制均在 Redis**（`wa:sticker:{id}` / `wa:sticker:{id}:blob`）。
- Meta 含 **`content_hash`**（blob sha256 前缀）；换图会更新 hash，CDN 用 `?v=` 缓存破坏。
- **公开已审图**可走无登录 `GET /cdn/s/:id?v=hash`（`public, max-age=31536000, immutable`），供 Cloudflare 边缘缓存。
- **公开投稿必须管理员审核**（`pending` → `approve` 后进广场与 CDN）；私有仅作者 bot 可用。
- 上传强制安全扫描：禁 SVG、magic/mime 校验、脚本/PHP/polyglot 尾部检测（非杀软）。
- 运行时按 **机器人主人** 的表情库 + 自建可用表情注入 LLM；`{"messages":["文字",{"type":"sticker","slug":"..."}]}`。
- Admin：`GET /admin/stickers?status=pending`、`POST .../approve|reject|takedown|restore`。
- 环境变量：`STICKER_SEND_ENABLED`、`MAX_STICKERS_PER_REPLY`、`STICKER_MAX_BYTES`（默认 2MB）。
- Cloudflare 部署：见 `docs/cloudflare.md`。
### Worker 相关配置（与 API 同进程 / 单镜像）

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `WORKER_ENABLED` | `true` | 是否在本进程跑 iLink 轮询与回复 |
| `MAX_BOTS_PER_WORKER` | `500` | 本进程最多同时 long-poll 的 bot 数 |
| `REPLY_CONCURRENCY` | `16` | 进程内 LLM/发送并发 |
| `INBOX_MAX_LEN` | `20000` | 每机器人 Redis 入站保留消息上限（含失败任务）；满载不推进游标 |

### 管理后台广播（纯文本推送）

- **仅纯文本**；不经 LLM、不写短期对话 / 长期记忆。
- **必须有 `context_token`**（peer 曾给该 bot 发过消息）；无 token 的目标在展开时跳过。
- **不按批准过滤**：未批准但可触达的 peer 也会进入队列。
- 异步任务：`POST` 只写 Redis job；Worker 进程内 `BroadcastRunner` 限速发送（`BROADCAST_INTERVAL_MS`，默认 200ms；生产可调到 50–100ms 加速，注意 iLink 限流）。
- `scope`：
  - `all_bots` — 全部机器人下可触达 peer
  - `bots` — `botIds[]` 指定机器人
  - `targets` — 显式 `{ botId, peerId }[]`
- `POST` body 带 `preview: true` 时只返回 `{ deliverable, skippedNoToken, missingBots }`，不创建任务。
- 需 `WORKER_ENABLED=true`（默认）才会实际发送；否则任务保持 `pending`。
- 环境变量：`BROADCAST_INTERVAL_MS`、`BROADCAST_MAX_TEXT`（默认 2000）、`BROADCAST_HISTORY`（默认 100）。

### `workerStats` 字段（dashboard / system）

**全舰队**租约汇总（`scope: "fleet"`）：

| 字段 | 说明 |
|------|------|
| `scope` | `fleet`（管理页）或 `local` |
| `leasedLocal` / `leasedFleet` | 全舰队正在 poll 的 bot 数（fleet 模式下两者相同） |
| `maxBots` | 全舰队容量合计（各节点 maxBots 之和） |
| `pollable` | 应被轮询的 bot（active + token + 未 pause） |
| `nodesOnline` / `nodesTotal` | 在线 / 注册部署节点数 |
| `atCapacity` | 任一点触顶或舰队已满 |
| `inboxDepth` / `inboxFailed` | 当前节点所持机器人在 Redis 的待处理 / 失败任务数（非全舰队加总） |
| `inboxPeak` | 当前节点观测到的待处理任务数峰值 |
| `inboxDropped` / `lastInboxDropAt` | 兼容旧客户端的保留字段；持久化队列不主动丢弃，分别为 `0` / `null` |

失败任务元数据为 `id`、`peerId`、`enqueuedAt`、`error`（通用分类）；重试成功为 `{ "ok": true }`，机器人或失败任务不存在返回 404。自动处理最多 3 次，之后保留供人工恢复，详见 [失败消息恢复](./runbook.md#失败消息恢复)。

### 超管（super admin）

`created_at` 最早的 `is_admin` 用户。节点管理 API 与后台「节点」页仅超管可用；普通管理员仍可看 Workers 全舰队 bot 列表。

### `nodes` / `GET /admin/nodes`（fleet）

Redis 心跳注册的**部署进程**（多机时每台一条），**不包含**源站公网 URL（用户统一走主域名；源站 IP 只在 CF Worker `ORIGINS`）。

| 字段 | 说明 |
|------|------|
| `id` | `WORKER_ID` |
| `hostname` / `pid` | 主机与进程 |
| `botCount` / `maxBots` / `leasedCount` / `leasedBotIds` | 容量与租约 |
| `label` / `region` / `version` | 可选运维标签；`version` 为进程 appVersion |
| `online` / `isSelf` | 心跳是否新鲜；是否为当前应答节点 |
| `fenced` / `fenceReason` / `fencedAt` / `fencedBy` | 管理员强制下线封锁（进程可仍在跑 HTTP，但不 poll） |
| `weight` / `weightOverride` / `weightUpdatedAt` / `weightBy` | 负载权重（百分比，默认 100）与是否管理员覆盖 |
| `weightLastSeenAt` | 舰队最后一次确认该节点存活的时间（自动过期计时起点） |
| `targetShare` | 按权重应分配的 bot 数（受 `maxBots` 约束）；离线/封锁节点为 `null` |
| `update` | OTA：`outdated` / `desiredVersion` / `status` / `progress` / `error` |
| `startedAt` / `updatedAt` | 启动与心跳时间 |

响应另含 `release`（通道当前版本摘要）、`appVersion`、`otaEnabled`、`weights`、`weightTotal`（在线节点权重和）、`weightLimits`、`weightTtlSec`（权重自动清理宽限期）、`pollableTotal`、`rebalanceEnabled`、`rebalanceIntervalSec`。

**强制下线说明：** 不停止 Docker/OS 进程；目标 `WORKER_ID` 在 fence 清除前不会 re-register / claim。租约由其他节点接管。从 CF Worker `ORIGINS` 移除源站 IP 是流量侧下线，与本 API 独立。

### 节点负载权重（Worker 负载调节，仅超管）

后台「节点」页 → **负载权重**列 → 滑杆 / 预设 / 手填百分比，保存前可预览各节点调整后的目标 bot 数。

- **相对值**：在线节点按各自权重占比分摊 `wa:bots:pollable`。A=200%、B=100% → 2:1；两个节点都是 200% 与都是 100% 等价。
- **范围** 0–500，默认 100。写入 100 等同删除覆盖（`wa:workers:weights` 只保存真正调过的节点）。
- **0% = 腾空**：节点保持在线心跳、继续处理 HTTP，但不再认领 bot，并会把已持有的租约全部释放（此时忽略 `REBALANCE_SLACK`，能真正归零）。与「强制下线」不同：不写 fence，改回非 0 即刻恢复。
- **上限仍然生效**：实际数量取 `min(权重份额, MAX_BOTS_PER_WORKER)`。权重只在容量内重新分配，不能突破单进程上限。
- **单节点例外**：只有一个在线节点时它拿全部（权重是节点之间的比例）。全舰队都设 0% 时退化为均分，避免所有 bot 停止轮询。
- **生效时机**：写入后 publish `wa:worker:wake`，各节点丢弃权重缓存；认领在下一个 `LEASE_RENEW_SEC` 生效，多余租约按 `REBALANCE_INTERVAL_SEC` / `REBALANCE_MAX_PER_TICK` 逐步释放。`REBALANCE_ENABLED=false` 时已认领的租约不迁移，权重只影响后续认领（后台会提示）。

#### 存储与自动清理

存储在 Redis，不进 env，节点重启不丢失。两个 hash 分开写，互不干扰：

| Key | 内容 | 写入方 |
|-----|------|--------|
| `wa:workers:weights` | `workerId` → JSON `{ percent, updatedAt, byUserId, byUsername }` | 仅管理员操作 |
| `wa:workers:weights:seen` | `workerId` → 最后一次确认存活的 ISO 时间 | 仅 GC |

> 拆成两个 hash 是必需的：GC 若为了盖时间戳而回写整条权重记录，会把管理员同一时刻的改动覆盖掉（read-modify-write 丢失更新）。

**节点消失后权重会自动删除**，无需人工干预：

- 判活以心跳 meta（`wa:worker:<id>`，TTL `WORKER_STALE_SEC`）为准，不看时间戳——所有版本的进程都会写 meta，因此 OTA 混版滚动期间旧版本节点不会被误判为消失。
- 任一在线节点每 5 分钟扫一次（`HSET`/`HDEL` 幂等，多节点并发无害），给还活着的节点刷新时间戳，给已消失且超过宽限期的删除记录，并顺带清掉没有对应权重的孤儿时间戳。权重 hash 为空时完全不产生 Redis 调用。
- 宽限期 `WORKER_WEIGHT_TTL_SEC`（默认 3600 秒，下限 60 秒）必须长于一次重启 / OTA 应用，否则每次发版都会重置调节。
- **已封锁（force-offline）节点永不过期**：封锁是临时的，解除后权重仍在。
- 「立即清理权重」按钮跳过宽限期，立刻删除所有无心跳且未封锁节点的权重（`POST /admin/nodes/weights/prune`）。

> **注意**：未在环境变量固定 `WORKER_ID` 时，进程每次重启都会生成新的随机 ID（`w_<host>_<pid>_<rand>`），权重不会跟随到新 ID——这也正是必须自动清理的原因，否则 hash 会随重启次数无限增长。需要权重长期生效，请为每个节点固定 `WORKER_ID`。

### OTA 发布与节点更新（仅超管）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/v1/admin/releases/current` | 通道当前 release |
| GET | `/api/v1/admin/releases` | 最近版本列表 |
| POST | `/api/v1/admin/releases` | `mode=blob\|publish\|pack` 上传/注册 |
| POST | `/api/v1/admin/releases/current` | `{ version }` 切换通道版本 |
| POST | `/api/v1/admin/nodes/:workerId/update` | 对该节点下发更新 job |
| POST | `/api/v1/admin/nodes/update-outdated` | 批量更新落后在线节点 |
| GET | `/api/v1/admin/nodes/:workerId/update-status` | 单节点进度 |

CLI 打包：`pnpm release:pack` / `pnpm docker:build`（见 `docs/docker.md`）。  
发布通道：`/admin` → 部署节点 → **上传通道包**（`files.json`，浏览器超管会话）→ 节点「更新」。

另有公开探活：`GET /health`（进程）、`GET /health/ready`（含 Redis，供 LB）。
