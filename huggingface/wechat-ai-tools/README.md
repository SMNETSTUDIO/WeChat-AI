# wechat-ai-tools

WeChat-AI 的 **工具网关**（可部署到 Hugging Face Spaces 或任意 Docker 主机）。

## 职责边界

| 调用方 | 走哪里 |
|--------|--------|
| **管理员配置的平台 LLM** | **主站直连**（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`） |
| **用户自定义 OpenAI 兼容 API** | **本服务出站**（主站只请求本服务，body 带 `upstream`） |
| **联网搜索** | **本服务出站**（`POST /v1/web-search`） |

主站配置：

```env
# 平台 LLM（管理员）
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# 工具网关（用户自定义 API + 搜索）
TOOLS_BASE_URL=http://127.0.0.1:7860
TOOLS_API_KEY=change-me-shared-with-main-site
WEB_SEARCH_ENABLED=true
```

本服务：

```env
TOOLS_API_KEY=change-me-shared-with-main-site
ALLOW_REQUEST_UPSTREAM=true
UPSTREAM_DENY_PRIVATE=true
# 可选：无 upstream 时的兜底模型（演示用）
# UPSTREAM_LLM_BASE_URL=...
# UPSTREAM_LLM_API_KEY=...
# UPSTREAM_LLM_MODEL=...
```

## API

### `GET /health`

存活与配置摘要（不含密钥）。

### `POST /v1/web-search`

```json
{ "query": "微信开放平台", "max_results": 5 }
```

鉴权：`Authorization: Bearer <TOOLS_API_KEY>` 或 `X-API-Key`。

### 搜索后端 Search backends

`SEARCH_PROVIDER` defaults to `ddg`. To use [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) for free, keyless web search, set this in the **tools service** environment and restart it:

```env
SEARCH_PROVIDER=parallel
```

Anonymous search uses Fast mode and needs no Parallel account or API key. It returns the same `title`, `url`, and `snippet` fields used by the main site's search tool and Chatflow search node. Existing `ddg`, `searxng` (`SEARXNG_URL`), and `tavily` (`TAVILY_API_KEY`) selections remain available. Requests still require the configured gateway `TOOLS_API_KEY`; the main site's global and persona search switches still apply.

`SEARCH_TIMEOUT_MS` bounds the complete Parallel handshake and search; `SEARCH_MAX_RESULTS` caps returned results. Provider failures are reported without silently switching backends. The gateway's search API does not expose page fetching or conversation identifiers.

### `POST /v1/chat/completions`

OpenAI 兼容子集。用户自定义模型示例：

```json
{
  "model": "gpt-4o-mini",
  "messages": [{ "role": "user", "content": "hi" }],
  "upstream": {
    "base_url": "https://api.siliconflow.cn/v1",
    "api_key": "sk-user-key",
    "model": "Qwen/Qwen2.5-7B-Instruct"
  }
}
```

- `upstream` 由主站解密用户连接后注入；本服务**不落库**密钥。  
- 日志只记 host/model，不记 api_key。  
- `UPSTREAM_DENY_PRIVATE=true` 时拒绝指向内网的 base_url。

## 本地运行

```bash
cd huggingface/wechat-ai-tools
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 编辑 TOOLS_API_KEY 等
uvicorn app:app --host 0.0.0.0 --port 7860 --reload
```

测试：

```bash
pytest -q
```

## Dockerfile 打包镜像

在本目录：

```bash
docker build -t wechat-ai-tools:latest .
docker run --rm -p 7860:7860 --env-file .env wechat-ai-tools:latest
```

在仓库根目录：

```bash
docker build -t wechat-ai-tools:latest -f huggingface/wechat-ai-tools/Dockerfile huggingface/wechat-ai-tools
```

推送到私有仓库示例：

```bash
docker tag wechat-ai-tools:latest registry.example.com/wechat-ai-tools:1.0.0
docker push registry.example.com/wechat-ai-tools:1.0.0
```

镜像特性：

- 基础镜像 `python:3.12-slim-bookworm`
- 非 root 用户 `app` (uid 1000)
- 暴露 `7860`（HF Spaces 默认）
- `HEALTHCHECK` → `GET /health`
- 入口：`uvicorn app:app --host 0.0.0.0 --port $PORT`

## Hugging Face Spaces

1. 新建 Space，**SDK = Docker**  
2. 将本目录文件推到 Space 仓库根（或 monorepo 中指定 Dockerfile 路径）  
3. Space Secrets 设置：`TOOLS_API_KEY`、可选 `UPSTREAM_LLM_*`  
4. 主站 `TOOLS_BASE_URL=https://<your-space>.hf.space`

## 与主站 compose（可选 profile）

主站 `docker-compose` 可将本镜像作为 `tools` 服务侧车；主站容器只访问 `http://tools:7860`，**不要**把用户自定义 API 的出站放到主站容器。

## 安全清单

- [x] 共享 `TOOLS_API_KEY`  
- [x] upstream SSRF 防护（禁私网 / metadata）  
- [x] 请求体大小限制  
- [x] 上游超时  
- [x] 密钥不写日志  
- [ ] 生产建议：仅允许主站出口 IP（反代层）  
