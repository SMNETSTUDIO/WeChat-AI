# WeChat-AI 运维手册

## 1. 首次部署清单

### 1.1 依赖

- Node.js 20+
- pnpm
- **Upstash Redis**（`rediss://...`）
- **LINUX DO OAuth** 应用
- LLM API Key（OpenAI 兼容）

### 1.2 `.env` 必填

```env
REDIS_URL=rediss://default:密码@xxxx.upstash.io:6379
LLM_API_KEY=...
LLM_BASE_URL=...
LLM_MODEL=...

LINUXDO_CLIENT_ID=...
LINUXDO_CLIENT_SECRET=...
LINUXDO_REDIRECT_URI=http://127.0.0.1:8787/api/v1/auth/callback
# 可选：数字 ID 或用户名；留空时「第一个登录的用户」自动成为管理员
LINUXDO_ADMIN_IDS=

PUBLIC_BASE_URL=http://127.0.0.1:8787
```

LINUX DO 应用回调地址必须与 `LINUXDO_REDIRECT_URI` **完全一致**。

### 1.4 多节点运维要点

| 项 | 说明 |
|----|------|
| 共享 | 所有节点同一 `REDIS_URL`、`PUBLIC_BASE_URL`（主域名）、OAuth 回调 |
| 每机 | 唯一 `WORKER_ID`；可选 `NODE_LABEL` / `NODE_REGION` |
| 入口 | 主域名 → `cloudflare-worker` 的 `ORIGINS`（源站 IP:端口） |
| 后台 | `/admin` → **节点**：进程心跳与 bot 租约；**不显示**源站 URL |
| 扫码 | 登录会话在 Redis，无需粘性会话 |
| 探活 | LB 用 `/health/ready`；Docker 可用 `/health` |
| 下线 | 从 Worker `ORIGINS` 移除并 deploy；停容器后租约 TTL 过期自动转移 |
| 扩容 | 新机起容器 + 更新 `ORIGINS`；bot 由租约自动分片 |
| 日常代码热修 | `pnpm release:pack` 或 `pnpm docker:build` → `/admin` 上传通道包 → 节点「更新」 |
| 基础镜像变更 | 仍需各机 `docker build` / 拉新镜像 |

进程内 HTTP 限流为单机计数；生产建议在 Cloudflare 对 `/api/v1/auth/*` 做 Rate Limiting。

### 1.3 启动

```powershell
cd F:\Code-Other-4\WeChat-AI
pnpm install
pnpm diag
pnpm db:seed
pnpm dev
```

| 页面 | URL |
|------|-----|
| 用户中心 | http://127.0.0.1:8787/app |
| 管理后台 | http://127.0.0.1:8787/admin |

## 2. 用户操作流程

1. 打开 `/app` → **LINUX DO 登录**
2. **扫码添加微信机器人**（ClawBot）
3. 微信好友私聊机器人 → 在用户中心 **批准**
4. 可选：分配人设（猫娘 / 女友）
5. 正常聊天（AI 会分多条气泡回复）

### 2.0 输入状态（「对方正在输入中」）

两步协议，`packages/ilink` 内部完成，无需配置：

1. `POST /ilink/bot/getconfig { ilink_user_id, context_token }` → `typing_ticket`
2. `POST /ilink/bot/sendtyping { ilink_user_id, typing_ticket, status }` — `status: 1` 开始，`status: 2` 停止

票据**按用户缓存**（服务端有效期约 24h，本地按 20h 过期后自动重取），所以每个 peer 大约一天一次 `getconfig`；并发的多次输入调用会合并成一次取票。

指示器的生命周期：收到消息立刻开始 → 调模型前再次开始 → 多气泡之间每条前再次开始 → **`handleJob` 的 `finally` 统一停止**。回复、拒绝、限流、用户互聊中继、异常，任何出口都会停止，不会把「正在输入中」留在对方屏幕上。主动联系发完也会停止。

排查：`getconfig` 失败时会退化成不带票据的 `sendtyping`（指示器可能不显示，但**绝不影响回复**）；票据被服务端提前失效时会强制重取并重试一次。

### 2.0.1 图片理解（入站 Vision）

默认**关闭**，且由 `apps/api/src/shipped-defaults.test.ts` 守着——`VISION_ENABLED` 只认精确的 `"true"`，`"1"` / `"yes"` / `"TRUE"` 都不算开。关闭状态下：不去 CDN 取字节、不调任何模型，收到图片直接回一句按类型区分的话。

> **出站语音 / 视频 / 文件**：`sendVoice` / `sendVideo` / `sendFile` 已在 `packages/ilink` 实现并有测试，但**没有任何调用点**，回复路径不会用到。要真正让角色发语音，还差两段：TTS 产出音频、再转成微信用的 SILK 编码（TTS 给的是 mp3/wav/opus，直接发大概率放不出来）。另外出站 voice 的 item type 只在入站验证过，需真机确认。


**关键点：人设模型不需要支持视觉。** 默认的 `caption` 模式先让一个识图端点把图片转成文字描述，只把这段**文字**交给人设模型——所以 `deepseek-v4-flash` 这类纯文本模型照样能"看图"。描述还会写进对话历史，隔几轮再问"刚那张图里的猫呢"仍然接得上。

| 模式 | 人设模型要求 | 说明 |
|------|--------------|------|
| `caption`（默认） | 无 | 识图端点出描述 → 文字进人设模型 |
| `direct` | **必须支持视觉** | 图片原样交给人设模型；不支持就直接报错 |

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `VISION_ENABLED` | `false` | 总闸。关闭时不下载、不调模型 |
| `VISION_MODE` | `caption` | 见上表 |
| `VISION_BASE_URL` / `VISION_API_KEY` | 空 | 识图端点。**env-only**（与平台 LLM 同信任级，直连不走 tools）。留空则复用 `LLM_BASE_URL` / `LLM_API_KEY` |
| `VISION_MODEL` | 空 | **必填**，留空则所有图片按「看不了」处理。对「我的模型连接」无效（那条链路只认连接里的模型名） |
| `VISION_CAPTION_MAX_TOKENS` | `300` | 描述长度上限 |
| `VISION_MAX_IMAGES` | `2` | 单条消息最多识别几张（每张都实打实花 token） |
| `INBOUND_MEDIA_MAX_BYTES` | `4194304` | 单个附件下载上限（解密后原始大小；base64 再涨约 1/3） |

`caption` 模式的成本：每张图多一次识图调用（记在机器人主人账上），人设模型那一轮只多几十个 token 的描述文字——比把 4MB base64 塞进上下文便宜得多。识图失败会降级成「看不了」，**不会让回复失败**。

行为说明：

- **只有图片会被下载**。语音/视频/文件的字节拿来也喂不进模型，所以根本不去 CDN 取——微信语音是 SILK/AMR，没有 OpenAI 兼容端点收。
- `caption` 模式下人设模型**收不到字节**，只收到方括号里的描述；提示词会要求它「当作亲眼所见，但只依据描述内容，不要往外扩写」。
- **语音靠微信自带转写**（`VOICE_TRANSCRIPT_ENABLED`，**默认开**）：转写文字随入站消息一起到，`extractText` 把它并入文本，这类语音当文字处理，不再额外列为附件（否则会告诉模型「你听不到」它正要读的内容）。这个开关与 `VISION_ENABLED` **互不相干**——用转写不花钱、不需要任何模型。设 `false` 后语音一律回「没听清，麻烦打字」。
- 模型看不到的附件仍会写进系统提示，并明确要求**不许猜测内容**——否则人设会张口就编视频里有什么。
- 整条消息只有看不了的媒体且没有文字时，直接回一句按类型区分的话（不调模型，不花钱）。
- 附件下载失败不会拖垮回复，降级成「只告知存在」。
- Chatflow 模式的人设看到的是 `[图片]` 占位符——图执行器没有多模态节点。
- 历史里存的也是 `[图片]` 占位符（字节不落库），所以下一轮追问「所以呢？」时上下文仍知道发过图。

### 2.1 智能体主动找用户（空闲触发）

默认**全局关闭**。开启后，空闲一段时间的用户可被角色主动联系。

1. `.env` 设置 `PROACTIVE_ENABLED=true` 并重启服务  
2. 在 `/app` 机器人卡片中打开 **「主动找用户聊天」** 并保存参数（空闲小时 / 间隔 / 每日上限 / 安静时段）  
3. 在用户列表对该 peer 勾选 **「允许主动」**（仅已批准用户）  
4. 对方须**曾经聊过**（系统存有 iLink `context_token`）；从未发过消息的人无法冷启动主动触达  

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `PROACTIVE_ENABLED` | `false` | 全局总闸 |
| `PROACTIVE_IDLE_HOURS` | `12` | 默认空闲阈值（小时） |
| `PROACTIVE_MIN_INTERVAL_HOURS` | `24` | 两次主动最小间隔 |
| `PROACTIVE_MAX_PER_DAY` | `1` | 每用户每日上限 |
| `PROACTIVE_QUIET_HOURS` | `0-8` | 安静时段（上海时区）；空字符串关闭 |
| `PROACTIVE_SCAN_INTERVAL_SEC` | `300` | 扫描周期 |
| `PROACTIVE_MAX_PER_SCAN` | `10` | 每轮最多发送数 |

### 2.2 用户之间通过 @LINUX DO 用户名对话

机器人可中继两个已绑定用户的文字消息（**不经过 LLM**）。

1. 双方均用 LINUX DO 登录 `/app`  
2. 用户中心 → **用户对话** → 生成绑定码 → 微信给任意机器人发 `/绑定 ABC123`  
3. 双方至少各给机器人发过一次消息（写入 `context_token`，否则不可达）  
4. A 发送整条消息 `@对方用户名` → B 收到请求 → `/同意`  
5. 会话中直接发文字（前缀 `[用户名]`）；`/断开` 结束；空闲约 30 分钟自动结束  

| 命令 | 说明 |
|------|------|
| `/绑定 CODE` | 认领绑定码 |
| `/解绑` | 解除绑定 |
| `/我的身份` | 查看绑定与会话状态 |
| `@username` | 发起对话请求（整条消息） |
| `/同意` `/拒绝` | 处理入站请求 |
| `/取消请求` | 取消自己发出的请求 |
| `/断开` | 结束当前用户对话 |
| `/拉黑 用户名` | 拉黑（无法再互相 @） |
| `/取消拉黑 用户名` | 移出黑名单 |
| `/黑名单` | 查看黑名单 |

### 2.3 管理后台广播（全站 / 单 bot 推送）

管理员在 `/admin` → **广播** 可向微信用户推送**纯文本**（系统更新、通知等）。

1. 登录管理后台 → 侧栏 **广播**  
2. 撰写文本，选择范围：  
   - **全部机器人**：每个 bot 下全部有 `context_token` 的 peer（含未批准）  
   - **指定机器人**：多选 bot，再向其可触达 peer 群发  
   - **指定 Peer**：选 bot → 勾选 peers  
3. **预估人数** → 确认后创建异步任务；列表可看进度 / 取消  
4. 机器人详情页也可 **向此 bot 群发** / 对某 peer **发消息**（跳转并预填）

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `BROADCAST_INTERVAL_MS` | `200` | 两条消息间隔（限速，降低 iLink 风险） |
| `BROADCAST_MAX_TEXT` | `2000` | 文本最大长度 |
| `BROADCAST_HISTORY` | `100` | 保留的历史任务数 |

约束：

- 从未给 bot 发过消息的用户**无法送达**（无 context_token）  
- 需 Worker 开启（`WORKER_ENABLED` 默认 true）；Worker 关则任务一直 `pending`  
- 已发出的消息**无法撤回**；取消只停止剩余目标  
- 不进 LLM / 人设记忆  

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `P2P_ENABLED` | `true` | 总开关（`false` 关闭） |
| `P2P_BIND_CODE_TTL_SEC` | `600` | 绑定码有效期 |
| `P2P_REQUEST_TTL_SEC` | `300` | 对话请求有效期 |
| `P2P_SESSION_IDLE_SEC` | `1800` | 会话空闲超时 |
| `P2P_RELAY_MAX_CHARS` | `500` | 单条中继最大字数 |
| `P2P_MAX_REQUESTS_PER_DAY` | `20` | 每 peer 每日发起 `@` 次数 |

跨 Bot 可用：A 绑在 Bot1、B 绑在 Bot2，中继走目标方 bot 凭证 + 其 `context_token`。

### 2.4 记忆检索与时间工具

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `MEMORY_TOP_K` | `12` | 记忆超过全量阈值时注入条数 |
| `MEMORY_FULL_INJECT_MAX` | `20` | ≤ 此数时仍全量注入（与旧行为一致） |
| `MEMORY_MAX_ITEMS` | `100` | 每个 peer+人设最多存储条数 |
| `TIME_TOOL_ENABLED` | `true` | 允许模型调用 `get_current_time` |
| `TIME_TOOL_TIMEZONE` | `Asia/Shanghai` | 默认时区 |

用户中心 → 微信用户行 → **记忆**：查看 / 删单条 / 清空。

日志关键字：`[proactive]`（`action=send|skip|lock_miss|no_ctx`）；`[broadcast]`（管理广播任务）。

### 2.5 自定义模型与联网搜索（经 HF 工具服务）

主站**只**直连管理员配置的平台 LLM；用户自定义 API 与联网搜索一律经
`huggingface/wechat-ai-tools` 出站。

| 环境变量 | 说明 |
|----------|------|
| `TOOLS_BASE_URL` | 工具服务根地址（HF Space / 自托管容器） |
| `TOOLS_API_KEY` | 与工具服务共享的调用密钥 |
| `LLM_PROVIDER_SECRET` | 加密用户保存的自定义 API Key（必填，否则无法添加连接） |
| `WEB_SEARCH_ENABLED` | 全局搜索开关；人设还需自行开启 |

用户路径：`/app` → **我的模型** 添加连接 → 人设编辑器里选择该连接 / 勾选联网搜索。

排查：
- `pnpm diag` 会探测 `TOOLS_BASE_URL/health`
- `/health/ready` 在 `WEB_SEARCH_ENABLED=true` 且 tools 不可达时返回 503（结果缓存 15s）
- 日志与审计**不记录** upstream api_key

### 2.6 Chatflow

人设可切 `chatflow` 模式，用 `/chatflow?persona=<id>` 编排流程图。

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `CHATFLOW_HTTP_ALLOWLIST` | 空 | http 节点额外允许的 host（tools host:port 始终允许）；`*` = 任意公网，内网/云元数据仍拦 |
| `CHATFLOW_MAX_STEPS` | `32` | 单次执行最大步数 |
| `CHATFLOW_MAX_NODES` | `40` | 图最大节点数 |

要点：chatflow 人设**不参与主动联系**；试聊强制走平台模型。详见 `docs/chatflow.md`。

## 3. 管理员

- 配置了 `LINUXDO_ADMIN_IDS`：名单内用户登录后为管理员
- 未配置：`FIRST_USER_IS_ADMIN` 默认 true，**首个登录用户**自动管理员
- 打开 `/admin`：今日 Token、用户数、机器人、审计、**广播**

## 4. Worker 与规模

API 与 iLink Worker **同进程**（单镜像 / 单容器）。

- 收消息：`getUpdates` 长轮询（每 bot 一路，有 `MAX_BOTS_PER_WORKER` 上限）
- 回消息：Redis 持久化 inbox + `REPLY_CONCURRENCY` 并发，同一机器人/聊天对象按序处理，避免 LLM 堵住轮询
- 日志出现 `at capacity`：提高 `MAX_BOTS_PER_WORKER`，或同镜像多副本分片

### 失败消息恢复

入队成功后才推进收取游标。处理租约默认 120 秒、每 40 秒续期；进程丢失后，当前机器人归属节点在租约到期后重新处理，已确认完成的生成/发送步骤会复用。
连续 3 次处理失败或中断的消息移入失败队列，后续同对象消息可继续。人工重试会把失败消息追加到该聊天对象队尾，重置尝试次数并保留检查点，因此较新的消息可能已先回复。

1. 用超管登录会话调用 `GET /api/v1/admin/bots/:botId/inbox`，读取 `pending`、`failed` 和最多 100 条 `failedJobs` 元数据。
2. 检查应用日志并修复实际原因（如 LLM/iLink 不可用、账号会话过期）。查询接口不返回正文、context token 或媒体密钥。
3. 对选中的任务调用 `POST /api/v1/admin/bots/:botId/inbox/:jobId/retry`，成功返回 `{ "ok": true }` 并记录 `admin_inbound_retry` 审计。

`INBOX_MAX_LEN` 按机器人计算，包含失败消息。满载时收取批次重试、游标不前进；留意 Redis 内存和失败数量。
队列依赖共享 Redis 的持久化且禁止逐出，ACK 后清理 payload，失败消息不会自动到期；删除机器人会一并清理队列。
发送确认丢失时会用相同 `client_id` 重试，但未经真实 iLink 去重验证，不能视为 exactly-once。
节点升级、回滚和敏感数据保护要求见 [Docker 部署文档](./docker.md#持久化回复与交付边界)。

## 5. 故障

| 现象 | 处理 |
|------|------|
| Redis Connection closed / 占位符 | 填真实 Upstash `rediss://` URL |
| OAuth redirect_uri mismatch | 控制台回调与 `.env` 一致 |
| OAuth userinfo 失败 | 确认 scope `openid profile`（已默认） |
| 无管理员 | 清空 Redis 用户或设置 `LINUXDO_ADMIN_IDS` 后重登 |
| 微信 session expired | 在用户中心删除机器人后重新扫码 |
| 无 AI 回复 | 检查 LLM_API_KEY、用户是否批准 |
| `at capacity` / 部分 bot 不 poll | 调高 `MAX_BOTS_PER_WORKER` |
| 自定义模型报 TOOLS_BASE_URL required | 部署工具服务并配置 `TOOLS_BASE_URL` / `TOOLS_API_KEY` |
| 添加模型连接 503 | 未设置 `LLM_PROVIDER_SECRET` |
| chatflow `http_blocked` | 目标域名不在 tools host / `CHATFLOW_HTTP_ALLOWLIST`；或命中内网段（报文里带 `private host blocked` 与原因）；或重定向跳进内网 |
| chatflow http 节点全部 `resolves to ...` 被拦 | 本机 DNS 在劫持解析（把所有域名答成 CGNAT/`198.18` 之类占位地址）。先 `nslookup` 确认，再排查 resolver，不要直接放宽白名单 |
| chatflow `search_disabled` | 人设未开搜索，或 `WEB_SEARCH_ENABLED` / TOOLS 未配 |
| `/health/ready` 503 但 Redis 正常 | tools 网关不可达（见 §2.5） |

## 6. 备份

- Upstash：控制台备份 / 导出（按套餐）
- Redis `wa:bot:{id}:creds`（Bot token，敏感）
- Redis `wa:bot:{id}:inbound:*`（待处理/失败消息、context token、媒体凭据、回复检查点，敏感；备份须与其余机器人数据保持一致）
- `.env`（勿提交 Git）

## 7. 文档

- Upstash：`docs/upstash-redis.md`
- OAuth：`docs/oauth-linuxdo.md`
- API：`docs/admin-api.md`
- AI 网关（主站↔HF 契约）：`docs/ai-gateway.md`
- Chatflow：`docs/chatflow.md`
