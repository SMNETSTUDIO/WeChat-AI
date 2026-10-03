# Docker 部署

## 前置条件

| 依赖 | 说明 |
|------|------|
| Docker + Compose | 本机或服务器已安装 |
| Upstash Redis | `.env` 中 `REDIS_URL=rediss://...` |
| LINUX DO OAuth | Client ID/Secret + **公网回调地址** |
| 平台 LLM（主站直连） | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` |
| 工具网关（用户自定义 API + 搜索） | `TOOLS_BASE_URL` / `TOOLS_API_KEY`；镜像见 `huggingface/wechat-ai-tools` |


## 快速启动

```bash
cd /path/to/WeChat-AI

# 配置环境变量（勿提交 .env）
# 生产务必修改：
#   PUBLIC_BASE_URL=https://你的域名
#   LINUXDO_REDIRECT_URI=https://你的域名/api/v1/auth/callback
#   REDIS_URL / LLM_* / LINUXDO_CLIENT_*
# 用户自定义 API + 搜索：TOOLS_BASE_URL / TOOLS_API_KEY
#   docker compose --profile tools up -d --build
#   TOOLS_BASE_URL=http://wechat-ai-tools:7860

# 推荐：升版 + 打 OTA 包 + 构建（无需 Cookie）
pnpm docker:up
# 自定义镜像名：
pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .

# 包在 dist/release/<版本>/files.json
# 浏览器登录 /admin → 部署节点 →「上传通道包」→ 再点节点「更新」

docker compose logs -f wechat-ai
```

### 单独构建 tools 镜像

```bash
docker build -t wechat-ai-tools:latest -f huggingface/wechat-ai-tools/Dockerfile huggingface/wechat-ai-tools
docker run --rm -p 7860:7860 -e TOOLS_API_KEY=secret -e ALLOW_REQUEST_UPSTREAM=true wechat-ai-tools:latest
```

详见 `docs/ai-gateway.md`、`huggingface/wechat-ai-tools/README.md`。


> **版本与通道：** `pnpm docker:build` 默认：升版 → **本地 pack** → Docker。  
> 通道发布只走网页：`/admin` → 上传 `files.json`（无 CLI Cookie）。  
> 直接跑 `docker build` **不会**升版、也**不会**打通道包。

| 地址 | 说明 |
|------|------|
| `/` | 功能介绍落地页（OG 分享图 `/og.jpg`） |
| `/app` | 用户中心（LINUX DO 登录、加机器人） |
| `/admin` | 管理后台（仪表盘 / Token） |
| `/health` | 健康检查 |

## 仅用 Dockerfile

```bash
# 升版 + docker build -t wechat-ai .
pnpm docker:build -- --raw
# 或自定义：node scripts/docker-build.mjs -- docker build -t wechat-ai:0.2.1 .

docker run -d --name wechat-ai --restart unless-stopped \
  --env-file .env \
  -e WECHAT_AI_HOST=0.0.0.0 \
  -e WECHAT_AI_PORT=8787 \
  -p 8787:8787 \
  wechat-ai
```

Bot token 与表情包均存 **Redis**（与 `REDIS_URL` 同库），容器重建不丢；无需本地数据卷。

## 生产环境检查清单

1. **LINUX DO** 应用回调与 `.env` 完全一致：  
   `https://你的域名/api/v1/auth/callback`
2. **`PUBLIC_BASE_URL`** = `https://你的域名`（无尾斜杠）
3. **HTTPS** 时设置 `COOKIE_SECURE=true`
4. **Redis** 使用 Upstash `rediss://`，服务器能访问外网
5. Bot **token 已写入 Redis**（与 `REDIS_URL` 同库），重建容器不会丢登录

## 常用命令

```bash
docker compose ps
docker compose logs -f
docker compose restart
docker compose down          # 停服务（Bot token 在 Redis，不受影响）
docker compose down -v       # 同 down（本服务无持久化 volume）
pnpm docker:up                                # 升版+本地 pack+compose up --build
pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .
# 然后 /admin → 上传通道包 (files.json) → 更新节点
pnpm docker:build -- --no-channel             # 只升版构建，不 pack
```

## OTA 增量更新（多节点日常热修）

业务源码小改可不必每台 `docker build`：本地 pack → 管理后台上传通道包 → 对落后节点点「更新」。

```bash
# 构建顺带打通道包
pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .
# 或仅 pack：
pnpm release:pack

# 浏览器 /admin → 部署节点 →「上传通道包」选 dist/release/<ver>/files.json
# →「更新全部落后」
```

| 项 | 说明 |
|----|------|
| 差量 | 按文件 sha256 比对，只下发变更文件 |
| 重启 | 节点 `process.exit(0)`，依赖 `restart: unless-stopped` 拉起**同一容器**（可写层保留补丁） |
| 版本 | 心跳 `version`：`.wa-version`（OTA 写入）→ `APP_VERSION` → 根 `package.json` |
| 仍需镜像 | Node 基础镜像、系统包、Dockerfile、`OTA_ALLOW_INSTALL=false` 时的依赖大变 |

环境变量：`OTA_ENABLED`（默认 true）、`OTA_ALLOW_INSTALL`、`APP_VERSION`（无 OTA 戳时可选）、`OTA_STAGING_DIR`。  
**注意：** OTA 只改文件、不改环境变量；版本靠 `/app/.wa-version` 上报，无需、也不应靠 `APP_VERSION` 跟版。  
`docker compose up --build` / 重建容器会丢掉仅靠 OTA 写入的补丁；长期仍以镜像为 source of truth。

## 反代示例

生产推荐把域名挂在 **Cloudflare**（橙云代理 + Cache Rules），见 **`docs/cloudflare.md`**（Business 缓存规则、忽略 Cookie、Purge 清单）。

### Caddy（无 CF 时）

```caddy
your.domain.com {
  reverse_proxy 127.0.0.1:8787
}
```

### Nginx（无 CF 时，或 CF → Nginx → Node）

```nginx
server {
  listen 443 ssl;
  server_name your.domain.com;
  # ssl_certificate ...;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Cloudflare 还原真实 IP 时可用：
    # proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
  }
}
```

源站已输出 `Cache-Control` / `Cloudflare-CDN-Cache-Control`、HTML ETag、公开表情 `/cdn/s/:id?v=`。反代层**不必**再写 `proxy_cache`，除非你不用 Cloudflare。
## 镜像说明

- 基础镜像：`node:22-bookworm-slim`
- 包管理：pnpm monorepo
- 启动：`pnpm db:seed`（幂等）→ `pnpm --filter @wechat-ai/api start`（**API + Worker 同进程**）
- 非 root 用户 `appuser` 运行
- 健康检查：`GET /health`

## Worker 规模（单镜像）

默认仍是 **一个容器跑全部**：HTTP + iLink 长轮询 + AI 回复。

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `MAX_BOTS_PER_WORKER` | `500` | 本进程最多同时 long-poll 的 bot 数 |
| `REPLY_CONCURRENCY` | `16` | 同时进行的 LLM/发送任务数 |
| `LEASE_TTL_SEC` | `45` | 租约 TTL（同镜像多副本时防重复 poll） |

机器人很多时优先调高 `MAX_BOTS_PER_WORKER` 与系统 `ulimit -n`（注意内存与出站连接数）。  
默认 **单副本一体部署** 即可；同镜像多副本已支持（Redis 租约分片 poll）。

租约续期与释放使用 Redis Lua 原子检查归属，避免旧节点在接管期间覆盖或删除新节点的租约。
Redis 账号需要允许 `EVAL` 及脚本使用的字符串、Hash、List、Set、Sorted Set、`TIME` 命令；批量操作仍通过 pipeline 合并往返。

### 多节点回归测试

CI 在 Node 22 / 24 上使用独立 Redis 服务运行租约和消息恢复测试。本地将
`WECHAT_AI_TEST_REDIS_URL` 指向**专用测试 Redis**，并将 `REDIS_URL` 指向另一个测试库（旧有核心测试使用），然后运行 `pnpm -r test`；未设置时对应集成测试会明确跳过。
测试覆盖租约竞态、消息再平衡交接、处理超时恢复、逐片段重试、关闭排空、入队失败不推进游标，以及失败任务接口的鉴权和脱敏。
各包测试命令的文件通配符须保留引号，交由 Node 展开；否则 Linux shell 可能只匹配子目录，遗漏顶层测试。

### 持久化回复与交付边界

入站消息先写 Redis，再推进 iLink 游标。队列按机器人保存，同一聊天对象 FIFO，不同聊天对象可并发。
机器人迁移后，新节点从共享队列继续处理；旧节点已开始的回复使用独立的 120 秒处理租约（每 40 秒续期），可以完成并 ACK，后续同对象消息等待它结束或超时。
正常退出和 OTA 最多等待 25 秒排空在途回复；未开始或未 ACK 的消息仍保留，崩溃后由当前机器人归属节点恢复。容器停止宽限期建议至少 30 秒。

每条消息最多自动处理 3 次；仍失败则保留原消息和检查点供超管查看、重试（见 [运维手册](./runbook.md#失败消息恢复)）。
`INBOX_MAX_LEN` 现在是**每机器人**保留消息总数，包括失败队列；满载时保留游标并重试收取，不丢弃新消息。
已保存的生成结果和成功发送片段会复用；重试发送使用稳定的 `client_id`。这是有重试上限的至少一次处理：
如果 iLink 已接受请求但确认丢失，是否去重仍取决于服务端；生成、P2P 状态变更完成但检查点尚未保存的崩溃窗口也可能重做。**不承诺端到端 exactly-once**。

各节点必须使用同一份支持 Lua 的共享 Redis（当前实现不支持 Redis Cluster 分片）。
队列包含消息正文、上下文 token、媒体下载凭据与回复检查点，属于与 Bot token 相同的敏感数据；限制 Redis 访问权限，远程连接使用 TLS，保护备份。
消息 ACK 后删除队列 payload；失败消息保留直到成功重试或删除机器人，删除机器人也清理其队列并废止处理 token。
为 Redis 启用符合业务容灾要求的持久化与备份，并配置 `noeviction` 或托管服务等效的禁止逐出策略；恢复保证以 Redis 已保存数据仍在为前提。
容量不足时应先处理失败消息或增加 Redis 容量，不要使用会随机逐出队列键的策略。

**升级：** 旧进程内存中的消息不能由新队列恢复。先停止新的入站流量并等待旧进程在途工作结束，再统一升级所有节点；避免与旧租约/内存队列版本混跑。
回滚前先排空新队列，旧版本不会消费这些持久化任务。

## 多节点同构部署（10+ 台）

每台服务器跑**同一镜像**（API + Worker），共用一个 Upstash Redis；用户只访问**主域名**。

### 应用 env（全站一致）

```env
PUBLIC_BASE_URL=https://你的主域名
LINUXDO_REDIRECT_URI=https://你的主域名/api/v1/auth/callback
REDIS_URL=rediss://...
COOKIE_SECURE=true
WORKER_ENABLED=true
```

### 每节点不同

```env
WORKER_ID=node-01          # 必填且唯一
NODE_LABEL=cn-east-1a      # 可选，管理后台展示
NODE_REGION=cn-east        # 可选
```

**不要**给每台设不同的 `PUBLIC_BASE_URL`。源站直连地址（IP:8787）只写在 Cloudflare Worker 的 `ORIGINS`，见 `cloudflare-worker/README.md`。

### 部署步骤摘要

1. 各机：`docker run ... --env-file .env -e WORKER_ID=node-0N -p 8787:8787 wechat-ai`  
2. 配置并部署 `cloudflare-worker`，`ORIGINS=http://ip1:8787,http://ip2:8787,...`  
3. 主域名绑到 Worker  
4. 打开 `/admin` → **节点**：应看到各 `WORKER_ID` 心跳与租约 bot 数  

| 探活 | 路径 |
|------|------|
| Docker / 轻量 | `GET /health` |
| LB 就绪（含 Redis） | `GET /health/ready` |

管理 API：`GET /api/v1/admin/nodes`（Cookie 管理员）。

扫码加机器人会话状态在 Redis，HTTP 无需粘性会话。

### 租约自动再平衡（rebalance）

多节点默认 **开启**：租约偏多的进程会周期性 **主动释放** 多余 lease（不 pause bot），空闲节点下一轮 `claim` 捡走，使各节点 bot 数接近均分。

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `REBALANCE_ENABLED` | `true` | 设为 `false` 关闭（租约粘在首占节点） |
| `REBALANCE_INTERVAL_SEC` | `60` | 同一进程两次 shed 最小间隔 |
| `REBALANCE_SLACK` | `2` | 允许高出均分多少个再释放 |
| `REBALANCE_MAX_PER_TICK` | `50` | 每次最多释放数（避免瞬间空窗过大） |

日志关键字：`[worker] rebalance shed N bot(s)`。约 `ceil(超额 / 50)` 分钟内收敛。

### 强制下线节点

管理后台 **节点** 页 → **强制下线**：

1. 写入 Redis fence（`wa:worker:{id}:fence`）  
2. 释放该 WORKER_ID 下全部 bot 租约  
3. 从 `wa:workers:reg` 移除  

目标进程下一轮 reconcile 发现 fence 后停止认领；其他节点 claim 这些 bot。  
**解除下线** 后该节点可重新加入。  

这**不会** `docker stop`；若要从 LB 摘流量，还要从 Cloudflare Worker `ORIGINS` 去掉该源站。
