"""Bridge between the chat API and Claude Code via the Claude Agent SDK."""

import os
from collections.abc import AsyncIterator
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

from app import mcp
from app.config import settings

MODELS = [
    {"id": "claude-opus-5-5", "name": "Claude Opus 5.5"},
    {"id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5"},
    {"id": "claude-haiku-5-5", "name": "Claude Haiku 5.5"},
    {"id": "claude-fable-5-2", "name": "Claude Fable 5.2"},
]


def ensure_credentials() -> None:
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")):
        raise RuntimeError(
            "No Claude credentials. Set CLAUDE_CODE_OAUTH_TOKEN (Pro/Max plan, from `claude setup-token`) "
            "or ANTHROPIC_API_KEY in .env, then run `docker compose -f docker-compose.dev.yml up -d backend`."
        )


def _tool_result_content(content: Any) -> str:
    """Tool output as text for the UI, truncated: Claude still sees it in full, the browser doesn't need to."""
    if content is None:
        text = ""
    elif isinstance(content, str):
        text = content
    else:
        text = "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
    limit = settings.tool_result_display_chars
    if len(text) > limit:
        text = f"{text[:limit]}\n\n… [{len(text) - limit:,} more characters not shown]"
    return text


async def run_turn(prompt: str, model: str, resume: str | None) -> AsyncIterator[dict[str, Any]]:
    """Run one chat turn through Claude Code and yield UI events.

    Event shapes:
      {"type": "session", "session_id"}
      {"type": "message_start"}                      a new assistant message begins
      {"type": "text", "text"}                       incremental text delta
      {"type": "tool_use", "id", "name", "input"}
      {"type": "tool_result", "tool_use_id", "content", "is_error"}
      {"type": "result", "session_id", "cost_usd", "is_error", "subtype", "result"}
    """
    ensure_credentials()
    # On a subscription, total_cost_usd is an API-price estimate, not what you're billed.
    uses_api_key = bool(os.environ.get("ANTHROPIC_API_KEY"))

    # Agents plugged in from the top bar (MCP servers), read now so a change applies from the next answer.
    mcp_servers, mcp_tools = mcp.active()

    options = ClaudeAgentOptions(
        model=model,
        cwd=settings.claude_workspace,
        resume=resume,
        system_prompt={"type": "preset", "preset": "claude_code"},
        allowed_tools=[*settings.claude_allowed_tools, *mcp_tools],
        mcp_servers=mcp_servers,
        # No interactive approval in the web UI: anything not in allowed_tools is denied.
        permission_mode="dontAsk",
        include_partial_messages=True,
        # Large tool results (web pages, files, subagent reports) can exceed the SDK's 1 MB default.
        max_buffer_size=settings.claude_max_buffer_bytes,
    )

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            yield {"type": "session", "session_id": message.data.get("session_id")}

        elif isinstance(message, StreamEvent) and message.parent_tool_use_id is None:
            event = message.event
            if event.get("type") == "content_block_delta":
                delta = event.get("delta", {})
                if delta.get("type") == "text_delta":
                    yield {"type": "text", "text": delta.get("text", "")}
            elif event.get("type") == "message_start":
                # Separate text from consecutive assistant messages within one turn.
                yield {"type": "message_start"}

        elif isinstance(message, AssistantMessage) and message.parent_tool_use_id is None:
            # Text already arrived via stream deltas; only surface tool calls here.
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    yield {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}

        elif (
            isinstance(message, UserMessage)
            and message.parent_tool_use_id is None  # skip subagents' internal tool results
            and isinstance(message.content, list)
        ):
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    yield {
                        "type": "tool_result",
                        "tool_use_id": block.tool_use_id,
                        "content": _tool_result_content(block.content),
                        "is_error": bool(block.is_error),
                    }

        elif isinstance(message, ResultMessage):
            yield {
                "type": "result",
                "session_id": message.session_id,
                "cost_usd": message.total_cost_usd if uses_api_key else None,
                "is_error": message.is_error,
                "subtype": message.subtype,
                "result": message.result if message.is_error else None,
            }
