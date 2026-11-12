"""Agents: MCP servers plugged into this app from the top bar, as many as you like.

Each agent gets a button with its name in the top bar. Its page calls its tools directly (tools/list, tools/call
through /api/agents/{id}/tools), and Claude Code can use them in chats as mcp__<slug>__<tool>. Unplugging removes
it (the row is deleted).

Any system that speaks MCP over Streamable HTTP works, e.g. info-center (../info-center) at
http://host.docker.internal:8765/mcp with an integration key from its Integrations tab. The API key is optional
(sent as `Authorization: Bearer <key>` when set). Plugging in checks the URL and key with an MCP handshake first,
so a bad key fails here rather than silently in the next answer. Changes apply to chats from the next answer on;
one already running keeps the tools it started with.
"""

import json
import re
import urllib.error
import urllib.request
from typing import Any

import anyio
from sqlalchemy import select

from app import models
from app.config import settings
from app.db import SessionLocal

PROTOCOL_VERSION = "2025-06-18"


class ConnectError(Exception):
    """The server couldn't be reached, rejected the key, or didn't answer like an MCP server."""


class NotFound(Exception):
    """No plugged-in agent with that id."""


def view(row: models.Agent) -> dict[str, Any]:
    """What the UI sees: never the key itself, only whether there is one and how it starts."""
    return {
        "id": row.id,
        "slug": row.slug,
        "name": row.name,
        "url": row.url,
        "has_key": bool(row.api_key),
        "key_prefix": row.api_key[:10] if row.api_key else None,
        "tools": row.tools or [],
    }


def defaults() -> dict[str, Any]:
    """Starting values for the "Add agent" dialog."""
    return {"url": settings.agent_mcp_url}


def list_agents() -> list[dict[str, Any]]:
    with SessionLocal() as db:
        return [view(r) for r in db.scalars(select(models.Agent).order_by(models.Agent.id))]


def _headers(key: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"} if key else {}


class _Client:
    """One MCP session over Streamable HTTP: initialize, then requests (with the session id if the server gives one)."""

    def __init__(self, url: str, key: str | None, timeout: float = 15) -> None:
        self.url, self.key, self.timeout = url, key, timeout
        self.session_id: str | None = None
        self._next_id = 0

    def _send(self, body: dict) -> dict | None:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
            **_headers(self.key),
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(), method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as res:
                self.session_id = res.headers.get("Mcp-Session-Id") or self.session_id
                text = res.read().decode()
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise ConnectError("The server rejected the API key (missing, wrong or disabled)") from None
            raise ConnectError(f"The server answered HTTP {exc.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise ConnectError(f"Can't reach {self.url}: {reason}. Is the server running?") from None
        if "id" not in body or not text.strip():
            return None  # a notification: no reply expected
        return self._reply(text, body["id"])

    @staticmethod
    def _reply(text: str, request_id: int) -> dict:
        """The JSON-RPC reply to request_id, from a JSON body or an SSE stream of events."""
        if text.lstrip().startswith(("event:", "data:", "id:", ":")):
            candidates = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
        else:
            candidates = [text]
        for candidate in candidates:
            try:
                message = json.loads(candidate)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("id") == request_id:
                if "error" in message:
                    error = message["error"]
                    raise ConnectError(f"MCP error: {error.get('message', error) if isinstance(error, dict) else error}")
                return message.get("result", {})
        raise ConnectError("The URL didn't answer like an MCP server")

    def request(self, method: str, params: dict) -> dict:
        self._next_id += 1
        return self._send({"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params})

    def initialize(self) -> dict:
        result = self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "commander", "version": "1"},
        })
        if "serverInfo" not in result:
            raise ConnectError("The URL didn't answer like an MCP server")
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return result

    def list_tools(self) -> list[dict]:
        tools, cursor = [], None
        while True:
            page = self.request("tools/list", {"cursor": cursor} if cursor else {})
            tools += [t for t in page.get("tools", []) if isinstance(t, dict) and "name" in t]
            cursor = page.get("nextCursor")
            if not cursor:
                return tools


def _handshake(url: str, key: str | None) -> tuple[str | None, list[str]]:
    """Initialize, then list tools. Returns the server's name and the tool names this key may use."""
    client = _Client(url, key)
    info = client.initialize()["serverInfo"]
    return info.get("title") or info.get("name"), [t["name"] for t in client.list_tools()]


def _slug(name: str, taken: set[str]) -> str:
    """A unique id for Claude's tool names (mcp__<slug>__<tool>): lowercase letters, digits, - and _."""
    base = re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-")[:40] or "agent"
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    return slug


def _target(agent_id: int) -> tuple[str, str | None]:
    with SessionLocal() as db:
        row = db.get(models.Agent, agent_id)
        if row is None:
            raise NotFound("No such agent: it may have been unplugged")
        return row.url, row.api_key


def list_tools_sync(url: str, key: str | None) -> list[dict]:
    client = _Client(url, key)
    client.initialize()
    return client.list_tools()


def call_sync(url: str, key: str | None, name: str, arguments: dict) -> dict:
    """Call a tool. Returns the MCP result: content, structuredContent, isError."""
    client = _Client(url, key, timeout=settings.agent_call_timeout_seconds)
    client.initialize()
    return client.request("tools/call", {"name": name, "arguments": arguments})


async def tools(agent_id: int) -> list[dict]:
    """An agent's tools, live: name, title, description, inputSchema."""
    return await anyio.to_thread.run_sync(list_tools_sync, *_target(agent_id))


async def call_tool(agent_id: int, name: str, arguments: dict) -> dict:
    """Call one of an agent's tools. Returns the MCP result: content, structuredContent, isError."""
    return await anyio.to_thread.run_sync(call_sync, *_target(agent_id), name, arguments)


async def plug_in(url: str, api_key: str | None, name: str | None) -> dict[str, Any]:
    """Check the server with this URL and key, then add it as a new agent.

    Its name is the one given, or else the name the server reports (e.g. "info-center research").
    """
    url = url.strip()
    key = (api_key or "").strip() or None
    if not url:
        raise ConnectError("An MCP URL is needed")
    server_name, tool_names = await anyio.to_thread.run_sync(_handshake, url, key)
    display = ((name or "").strip() or server_name or url)[:190]
    with SessionLocal() as db:
        names = set(db.scalars(select(models.Agent.name)))
        base, n = display, 2
        while display in names:  # two buttons with the same name would be confusing
            display, n = f"{base} ({n})", n + 1
        taken = set(db.scalars(select(models.Agent.slug)))
        row = models.Agent(slug=_slug(base, taken), name=display, url=url, api_key=key, tools=tool_names)
        db.add(row)
        db.commit()
        return view(row)


def unplug(agent_id: int) -> None:
    """Remove an agent and its chats: its button goes away, and Claude's chats stop getting its tools."""
    with SessionLocal() as db:
        row = db.get(models.Agent, agent_id)
        if row is None:
            raise NotFound("No such agent")
        db.delete(row)
        db.commit()


def active() -> tuple[dict[str, dict], list[str]]:
    """For a Claude Code run: every agent's MCP config, and the tool permissions that allow their tools."""
    with SessionLocal() as db:
        rows = db.scalars(select(models.Agent)).all()
        servers = {r.slug: {"type": "http", "url": r.url, "headers": _headers(r.api_key)} for r in rows}
    # "mcp__<server>" allows every tool of that server.
    return servers, [f"mcp__{slug}" for slug in servers]
