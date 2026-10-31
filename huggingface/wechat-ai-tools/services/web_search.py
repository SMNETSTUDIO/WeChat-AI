"""Web search backends (DDG default; optional SearXNG / Tavily / Parallel)."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx

from config import Settings

log = logging.getLogger("wechat-ai-tools.search")


class SearchError(RuntimeError):
    pass


def _clamp_max(n: int | None, settings: Settings) -> int:
    if n is None:
        return max(1, min(settings.search_max_results, 10))
    return max(1, min(int(n), settings.search_max_results, 10))


async def search_web(
    query: str,
    *,
    max_results: int | None,
    settings: Settings,
) -> list[dict[str, str]]:
    q = (query or "").strip()
    if not q:
        raise SearchError("query is required")
    if len(q) > 500:
        raise SearchError("query too long (max 500)")

    limit = _clamp_max(max_results, settings)
    provider = (settings.search_provider or "ddg").strip().lower()

    if provider == "parallel":
        return await _search_parallel(q, limit, settings)
    if provider == "tavily":
        return await _search_tavily(q, limit, settings)
    if provider == "searxng":
        return await _search_searxng(q, limit, settings)
    return await _search_ddg(q, limit, settings)


async def _search_ddg(query: str, limit: int, settings: Settings) -> list[dict[str, str]]:
    try:
        from duckduckgo_search import DDGS
    except ImportError as exc:
        raise SearchError("duckduckgo-search not installed") from exc

    results: list[dict[str, str]] = []
    timeout_s = max(1.0, settings.search_timeout_ms / 1000.0)
    try:
        # DDGS is sync; run in thread via anyio is ideal — use sync for MVP simplicity
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=limit))
    except Exception as exc:  # noqa: BLE001
        log.warning("ddg search failed: %s", type(exc).__name__)
        raise SearchError(f"search failed: {type(exc).__name__}") from exc

    for item in raw[:limit]:
        results.append(
            {
                "title": str(item.get("title") or ""),
                "url": str(item.get("href") or item.get("link") or ""),
                "snippet": str(item.get("body") or item.get("snippet") or ""),
            }
        )
    return results


async def _search_searxng(
    query: str, limit: int, settings: Settings
) -> list[dict[str, str]]:
    base = (settings.searxng_url or "").strip().rstrip("/")
    if not base:
        raise SearchError("SEARXNG_URL not configured")
    timeout = max(1.0, settings.search_timeout_ms / 1000.0)
    params = {"q": query, "format": "json", "categories": "general"}
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(base, params=params)
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
    out: list[dict[str, str]] = []
    for item in (data.get("results") or [])[:limit]:
        out.append(
            {
                "title": str(item.get("title") or ""),
                "url": str(item.get("url") or ""),
                "snippet": str(item.get("content") or item.get("snippet") or ""),
            }
        )
    return out


async def _search_tavily(
    query: str, limit: int, settings: Settings
) -> list[dict[str, str]]:
    key = (settings.tavily_api_key or "").strip()
    if not key:
        raise SearchError("TAVILY_API_KEY not configured")
    timeout = max(1.0, settings.search_timeout_ms / 1000.0)
    payload = {
        "api_key": key,
        "query": query,
        "max_results": limit,
        "include_answer": False,
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post("https://api.tavily.com/search", json=payload)
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
    out: list[dict[str, str]] = []
    for item in (data.get("results") or [])[:limit]:
        out.append(
            {
                "title": str(item.get("title") or ""),
                "url": str(item.get("url") or ""),
                "snippet": str(item.get("content") or ""),
            }
        )
    return out


async def _search_parallel(
    query: str, limit: int, settings: Settings
) -> list[dict[str, str]]:
    """Call anonymous Search MCP through the official Streamable HTTP client."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    timeout = max(1.0, settings.search_timeout_ms / 1000.0)
    try:
        # Bound the entire handshake, discovery and search, not each HTTP request.
        async with asyncio.timeout(timeout):
            async with httpx.AsyncClient(
                timeout=timeout,
                headers={"User-Agent": "wechat-ai-tools/1.0.0"},
            ) as client:
                async with streamable_http_client(
                    "https://search.parallel.ai/mcp", http_client=client
                ) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools = await session.list_tools()
                        if not any(tool.name == "web_search" for tool in tools.tools):
                            raise SearchError("Parallel web_search tool unavailable")
                        # The gateway receives independent searches, without a
                        # conversation identity. Leave optional session_id unset
                        # rather than inventing a shared or per-call identity.
                        result = await session.call_tool(
                            "web_search",
                            {"objective": query, "search_queries": [query]},
                        )
                        if result.isError:
                            raise SearchError("Parallel search returned an error")
                        data = result.structuredContent
                        if data is None:
                            text = "\n".join(
                                part.text for part in result.content if part.type == "text"
                            )
                            data = json.loads(text)
    except TimeoutError as exc:
        raise SearchError("Parallel search timed out") from exc
    except Exception as exc:  # SDK transport failures can be nested exception groups.
        log.warning("parallel search failed: %s", type(exc).__name__)
        raise SearchError("Parallel search failed") from exc

    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        raise SearchError("Invalid Parallel search response")
    out: list[dict[str, str]] = []
    for item in data["results"][:limit]:
        if not isinstance(item, dict):
            raise SearchError("Invalid Parallel search result")
        url = item.get("url")
        title = item.get("title")
        excerpts = item.get("excerpts")
        try:
            parsed = urlsplit(url) if isinstance(url, str) else None
            valid_url = parsed and parsed.scheme in {"http", "https"} and parsed.hostname
        except ValueError:
            valid_url = False
        if (
            not valid_url
            or (title is not None and not isinstance(title, str))
            or not isinstance(excerpts, list)
            or any(not isinstance(excerpt, str) for excerpt in excerpts)
        ):
            raise SearchError("Invalid Parallel search result")
        out.append({"title": title or "", "url": url, "snippet": "\n\n".join(excerpts)})
    return out
