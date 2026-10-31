"""Exercise the route, provider resolver, and real MCP SDK HTTP transport."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest
# Import before patching httpx.AsyncClient: SDK annotations reference its class.
import mcp.client.streamable_http  # noqa: F401
from fastapi import FastAPI
from fastapi.testclient import TestClient

from config import Settings, get_settings
from routers.search import router
from services import web_search


class McpFixture:
    def __init__(self):
        self.requests = []
        self.results = [
            {"title": "Current facts", "url": "https://example.org/news?a=1", "excerpts": ["First", "Second"]},
            {"title": None, "url": "http://example.org/next", "excerpts": []},
        ]
        self.tool_error = False
        self.http_error = False
        self.missing_tool = False
        self.text_only = False
        self.sse = False
        self.delay = False
        self.started = asyncio.Event()
        self.cancelled = False

    async def handle(self, request):
        payload = json.loads(request.content) if request.content else {}
        self.requests.append({"url": str(request.url), "method": request.method,
                              "headers": dict(request.headers), "payload": payload})
        if request.method == "GET":
            return httpx.Response(405)
        method = payload.get("method")
        if method == "initialize":
            result = {"protocolVersion": payload["params"]["protocolVersion"],
                      "capabilities": {"tools": {}},
                      "serverInfo": {"name": "fixture", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [] if self.missing_tool else [{"name": "web_search", "inputSchema": {"type": "object"}}]}
        elif method == "tools/call":
            self.started.set()
            if self.delay:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.cancelled = True
                    raise
            if self.http_error:
                return httpx.Response(503, text="unavailable")
            data = {"results": self.results}
            result = {"content": [{"type": "text", "text": json.dumps(data)}], "isError": self.tool_error}
            if not self.text_only:
                result["structuredContent"] = data
        else:
            return httpx.Response(202)
        body = {"jsonrpc": "2.0", "id": payload["id"], "result": result}
        if self.sse and method == "tools/call":
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  text="event: message\ndata: " + json.dumps(body) + "\n\n")
        return httpx.Response(200, json=body)


@pytest.fixture
def backend(monkeypatch):
    fixture = McpFixture()
    real_client = httpx.AsyncClient
    monkeypatch.setattr(web_search.httpx, "AsyncClient", lambda **kwargs: real_client(
        **kwargs, transport=httpx.MockTransport(fixture.handle)))
    return fixture


def route_client(settings):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_settings] = lambda: settings
    return TestClient(app)


def test_actual_route_anonymous_parallel(backend):
    settings = Settings(_env_file=None, SEARCH_PROVIDER=" Parallel ", TOOLS_API_KEY="gateway-only", SEARCH_MAX_RESULTS=1)
    with route_client(settings) as client:
        response = client.post("/v1/web-search", headers={"Authorization": "Bearer gateway-only"},
                               json={"query": " latest facts ", "max_results": 8})
    assert response.status_code == 200
    assert response.json() == {"query": "latest facts", "results": [
        {"title": "Current facts", "url": "https://example.org/news?a=1", "snippet": "First\n\nSecond"}]}
    assert {r["payload"].get("method") for r in backend.requests} >= {"initialize", "tools/list", "tools/call"}
    for request in backend.requests:
        assert request["url"] == "https://search.parallel.ai/mcp"
        assert request["headers"]["user-agent"] == "wechat-ai-tools/1.0.0"
        assert "authorization" not in request["headers"]
    call = next(r["payload"] for r in backend.requests if r["payload"].get("method") == "tools/call")
    assert call["params"] == {"name": "web_search", "arguments": {
        "objective": "latest facts", "search_queries": ["latest facts"]}}


@pytest.mark.asyncio
@pytest.mark.parametrize("text_only,sse", [(True, False), (False, True)])
async def test_sdk_json_text_and_sse(backend, text_only, sse):
    backend.text_only, backend.sse = text_only, sse
    hits = await web_search.search_web("facts", max_results=10, settings=Settings(_env_file=None, SEARCH_PROVIDER="parallel"))
    assert len(hits) == 2
    assert hits[1] == {"title": "", "url": "http://example.org/next", "snippet": ""}


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", [None, "ddg", "searxng", "tavily"])
async def test_existing_provider_choices(monkeypatch, provider):
    settings = Settings(_env_file=None, **({"SEARCH_PROVIDER": provider} if provider else {}))
    expected = provider or "ddg"
    for name in ["ddg", "searxng", "tavily", "parallel"]:
        stub = AsyncMock(return_value=[{"title": name, "url": "https://example.org", "snippet": "ok"}])
        monkeypatch.setattr(web_search, "_search_" + name, stub)
    result = await web_search.search_web("q", max_results=3, settings=settings)
    assert result[0]["title"] == expected
    for name in ["ddg", "searxng", "tavily", "parallel"]:
        assert getattr(web_search, "_search_" + name).await_count == (1 if name == expected else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["tool_error", "http_error", "missing_tool", "bad_shape", "bad_url", "bad_excerpts"])
async def test_parallel_failures_never_fallback(backend, monkeypatch, failure):
    fallback = AsyncMock(side_effect=AssertionError("must not fall back"))
    monkeypatch.setattr(web_search, "_search_ddg", fallback)
    if failure == "bad_shape":
        backend.results = "invalid"
    elif failure == "bad_url":
        backend.results[0]["url"] = "javascript:alert(1)"
    elif failure == "bad_excerpts":
        backend.results[0]["excerpts"] = [None]
    else:
        setattr(backend, failure, True)
    with pytest.raises(web_search.SearchError):
        await web_search.search_web("facts", max_results=3, settings=Settings(_env_file=None, SEARCH_PROVIDER="parallel"))
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_parallel_total_timeout(backend):
    backend.delay = True
    with pytest.raises(web_search.SearchError, match="timed out"):
        await web_search.search_web("facts", max_results=3, settings=Settings(_env_file=None, SEARCH_PROVIDER="parallel", SEARCH_TIMEOUT_MS=1000))
    assert backend.cancelled


@pytest.mark.asyncio
async def test_parallel_cancellation(backend):
    backend.delay = True
    task = asyncio.create_task(web_search.search_web("facts", max_results=3, settings=Settings(_env_file=None, SEARCH_PROVIDER="parallel")))
    await asyncio.wait_for(backend.started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert backend.cancelled


def test_gateway_auth_and_input_bounds(backend):
    with route_client(Settings(_env_file=None, SEARCH_PROVIDER="parallel", TOOLS_API_KEY="private")) as client:
        for headers in [{}, {"X-API-Key": "wrong"}]:
            assert client.post("/v1/web-search", headers=headers, json={"query": "facts"}).status_code == 401
        for body in [{"query": ""}, {"query": "x" * 501}, {"query": "facts", "max_results": 11}]:
            assert client.post("/v1/web-search", headers={"X-API-Key": "private"}, json=body).status_code == 422
    assert backend.requests == []


def test_gateway_reports_parallel_error(backend):
    backend.tool_error = True
    with route_client(Settings(_env_file=None, SEARCH_PROVIDER="parallel", TOOLS_API_KEY="")) as client:
        response = client.post("/v1/web-search", json={"query": "facts"})
    assert response.status_code == 400
    assert "Parallel search" in response.json()["detail"]
