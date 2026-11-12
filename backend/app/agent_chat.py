"""Chats with a plugged-in agent: each message goes to the agent over MCP, and its reply comes back as an answer.

MCP servers offer tools, not a chat, so a chat is mapped onto them (chat_profile):

- The message tool is the one with a required text parameter named like a message (question, prompt, message, ...),
  e.g. info-center's start_research(question). Its other parameters are filled from earlier replies in the chat
  when the names match (e.g. conversation_id, so a follow-up has the earlier answer as context).
- If the reply is a background job (a status like "queued" or "running"), the follow-up tool is the one whose
  required parameters the reply provides and that reads (get_/check_/status..., or readOnlyHint), e.g.
  get_research(job_id). It's called every check_again_in_seconds (or a few seconds) until the status changes.
  A cancel_/stop_ tool taking the same ids is the Stop button.
- The answer is the reply's Markdown/text field (answer_markdown, content, result, ...), or its text content.

Answers run as background tasks, so closing the page doesn't stop them; on restart, answers that were waiting on
a job pick up checking again, since the job runs on the agent, not here.
"""

import asyncio
import json
import logging
import re
from typing import Any

from sqlalchemy import func, select

from app import mcp, models
from app.config import settings
from app.db import SessionLocal

logger = logging.getLogger(__name__)

RUNNING = {"queued", "pending", "running", "in_progress", "working", "started", "processing", "submitted", "accepted"}
FAILED = {"error", "failed", "failure"}
STOPPED = {"stopped", "cancelled", "canceled", "aborted"}
MESSAGE_PARAM = re.compile(r"question|prompt|message|query|text|input|content|task|instruction|request", re.I)
ANSWER_KEY = re.compile(r"answer|markdown|content|result|output|response|reply|text|message", re.I)
POLL_NAME = re.compile(r"^(get|check|poll|status|fetch|read|wait|retrieve)", re.I)
CANCEL_NAME = re.compile(r"cancel|stop|abort", re.I)

CHECK_RETRIES = 5  # failed checks in a row before giving up on an answer

_tasks: dict[int, asyncio.Task] = {}  # message id -> task, while it runs


class NoChatTool(Exception):
    """The agent has no tool that takes a message."""


# ---- Mapping a chat onto the agent's tools ---------------------------------------------------------------


def _schema(tool: dict) -> tuple[dict, list[str]]:
    schema = tool.get("inputSchema") or {}
    return schema.get("properties") or {}, list(schema.get("required") or [])


def _is_string(prop: dict) -> bool:
    types = [prop.get("type")] + [p.get("type") for p in prop.get("anyOf", []) + prop.get("oneOf", [])]
    return "string" in types or any(isinstance(t, list) and "string" in t for t in types)


def chat_profile(tools: list[dict]) -> dict[str, Any]:
    """The tool and parameter a chat message goes to: {"tool", "param", "title"}."""
    best, best_score = None, -1
    for tool in tools:
        props, required = _schema(tool)
        for param in required:
            if not (_is_string(props.get(param, {})) and MESSAGE_PARAM.search(param)):
                continue
            hints = tool.get("annotations") or {}
            score = (0 if hints.get("readOnlyHint") else 2) + (1 if len(required) == 1 else 0)
            score += 1 if re.match(r"(ask|chat|start|send|run|research|query|prompt)", tool["name"], re.I) else 0
            if score > best_score:
                best, best_score = {"tool": tool["name"], "param": param}, score
    if best is None:
        raise NoChatTool("This agent has no tool that takes a message. Use its Tools view to call its tools.")
    tool = next(t for t in tools if t["name"] == best["tool"])
    best["title"] = (tool.get("annotations") or {}).get("title") or tool.get("title") or tool["name"]
    return best


def _follow_up(tools: list[dict], data: dict, skip: str, cancel: bool) -> dict | None:
    """A tool to check on (or cancel) a job, called with ids from the reply: {"tool", "args"}."""
    for tool in tools:
        name = tool["name"]
        _, required = _schema(tool)
        if name == skip or not required or not all(r in data for r in required):
            continue
        hints = tool.get("annotations") or {}
        if cancel:
            ok = bool(CANCEL_NAME.search(name))
        else:
            ok = (hints.get("readOnlyHint") or POLL_NAME.match(name)) and not CANCEL_NAME.search(name)
        if ok:
            return {"tool": name, "args": {r: data[r] for r in required}}
    return None


def _data(result: dict) -> Any:
    if result.get("structuredContent") is not None:
        return result["structuredContent"]
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    if len(texts) == 1:
        try:
            return json.loads(texts[0])
        except ValueError:
            pass
    return None


def _text(result: dict) -> str:
    return "\n\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")


def _status(data: Any) -> str | None:
    status = data.get("status") if isinstance(data, dict) else None
    return status.lower() if isinstance(status, str) else None


def _answer(result: dict) -> str:
    data = _data(result)
    if isinstance(data, dict):
        strings = {k: v for k, v in data.items() if isinstance(v, str) and v.strip()}
        for key, value in strings.items():
            if ANSWER_KEY.search(key) and ("\n" in value or len(value) > 80):
                return value
        long = [v for v in strings.values() if "\n" in v or len(v) > 200]
        if long:
            return long[0]
        return f"```json\n{json.dumps(data, indent=2, ensure_ascii=False)}\n```"
    return _text(result)


def _scalars(data: Any) -> dict[str, Any]:
    """Short top-level values of a reply (ids, statuses), remembered for later messages in the chat."""
    if not isinstance(data, dict):
        return {}
    return {
        k: v for k, v in data.items()
        if isinstance(v, (str, int, float, bool)) and not (isinstance(v, str) and ("\n" in v or len(v) > 200))
    }


def _activity_result(call_id: str, result: dict | None, error: str | None = None) -> dict:
    text = error if error is not None else _text(result or {})
    limit = settings.tool_result_display_chars
    if len(text) > limit:
        text = f"{text[:limit]}\n\n… [{len(text) - limit:,} more characters not shown]"
    return {
        "type": "tool_result",
        "tool_use_id": call_id,
        "content": text,
        "is_error": error is not None or bool((result or {}).get("isError")),
    }


# ---- Running a message -----------------------------------------------------------------------------------


def _save(message_id: int, **fields) -> models.AgentMessage | None:
    with SessionLocal() as db:
        row = db.get(models.AgentMessage, message_id)
        if row is None:  # the chat (or the agent) was removed meanwhile
            return None
        for key, value in fields.items():
            setattr(row, key, value)
        db.commit()
        return row


def _remember(chat_id: int, data: Any) -> None:
    values = _scalars(data)
    if not values:
        return
    with SessionLocal() as db:
        chat = db.get(models.AgentChat, chat_id)
        if chat is not None:
            chat.context = {**(chat.context or {}), **values}
            db.commit()


def _finish(message_id: int, result: dict, activity: list[dict]) -> None:
    data = _data(result)
    status = _status(data)
    if result.get("isError"):
        _save(message_id, status="error", error=_text(result) or "The agent's tool failed", activity=activity)
    elif status in FAILED:
        error = data.get("error") if isinstance(data, dict) else None
        _save(message_id, status="error", content=_answer(result), error=str(error or "The agent reported an error"),
              activity=activity)
    else:
        _save(message_id, status="stopped" if status in STOPPED else "complete", content=_answer(result),
              activity=activity)


def _interval(data: Any) -> float:
    hint = data.get("check_again_in_seconds") or data.get("retry_after") if isinstance(data, dict) else None
    try:
        return min(max(float(hint), 2), 60) if hint else 5
    except (TypeError, ValueError):
        return 5


async def _poll(message_id: int, chat_id: int, url: str, key: str | None, state: dict, activity: list[dict]) -> None:
    """Check on the agent's job until it's done."""
    poll = state["poll"]
    loop = asyncio.get_running_loop()
    deadline = loop.time() + settings.agent_answer_max_seconds
    interval = state.get("interval", 5)
    use = {"type": "tool_use", "id": "check", "name": poll["tool"], "input": poll["args"]}
    failures = 0
    while True:
        await asyncio.sleep(interval)
        try:
            result = await asyncio.to_thread(mcp.call_sync, url, key, poll["tool"], poll["args"])
        except mcp.ConnectError:
            # The job runs on the agent, so a hiccup reaching it (or a restart on either side) isn't fatal.
            failures += 1
            if failures >= CHECK_RETRIES or loop.time() > deadline:
                raise
            interval = min(interval * 2, 60)
            continue
        failures = 0
        data = _data(result)
        _remember(chat_id, data)
        # Keep only the latest check in the activity, not every one.
        current = [a for a in activity if a.get("id") != "check" and a.get("tool_use_id") != "check"]
        current += [use, _activity_result("check", result)]
        if result.get("isError") or _status(data) not in RUNNING:
            _finish(message_id, result, current)
            return
        if _save(message_id, activity=current) is None:
            return
        if loop.time() > deadline:
            _save(message_id, status="error", error="Gave up waiting for the agent's answer", activity=current)
            return
        interval = _interval(data)


async def _run(message_id: int) -> None:
    try:
        with SessionLocal() as db:
            message = db.get(models.AgentMessage, message_id)
            chat = message.chat
            agent = chat.agent
            url, key, chat_id = agent.url, agent.api_key, chat.id
            question, state, context = message.question, dict(message.state or {}), dict(chat.context or {})
            activity = list(message.activity or [])

        if state.get("poll"):  # resumed after a restart
            await _poll(message_id, chat_id, url, key, state, activity)
            return

        tools = await asyncio.to_thread(mcp.list_tools_sync, url, key)
        profile = chat_profile(tools)
        props, _ = _schema(next(t for t in tools if t["name"] == profile["tool"]))
        args = {profile["param"]: question}
        # Carry ids from earlier replies (e.g. conversation_id) into parameters with the same name.
        args.update({p: context[p] for p in props if p != profile["param"] and p in context})

        activity = [{"type": "tool_use", "id": "send", "name": profile["tool"], "input": args}]
        _save(message_id, activity=activity)
        result = await asyncio.to_thread(mcp.call_sync, url, key, profile["tool"], args)
        activity.append(_activity_result("send", result))
        data = _data(result)
        _remember(chat_id, data)

        poll = _follow_up(tools, data, profile["tool"], cancel=False) if isinstance(data, dict) else None
        if not result.get("isError") and _status(data) in RUNNING and poll:
            state = {
                "poll": poll,
                "cancel": _follow_up(tools, data, profile["tool"], cancel=True),
                "interval": _interval(data),
            }
            if _save(message_id, state=state, activity=activity) is None:
                return
            await _poll(message_id, chat_id, url, key, state, activity)
        else:
            _finish(message_id, result, activity)
    except asyncio.CancelledError:
        raise
    except (mcp.ConnectError, NoChatTool) as exc:
        _save(message_id, status="error", error=str(exc))
    except Exception as exc:
        logger.exception("Agent message failed")
        _save(message_id, status="error", error=str(exc))
    finally:
        _tasks.pop(message_id, None)


def _start(message_id: int) -> None:
    _tasks[message_id] = asyncio.get_running_loop().create_task(_run(message_id))


# ---- API -------------------------------------------------------------------------------------------------


class Busy(Exception):
    """The chat is still waiting for an earlier answer."""


def send(chat_id: int, question: str) -> models.AgentMessage:
    with SessionLocal(expire_on_commit=False) as db:
        chat = db.get(models.AgentChat, chat_id)
        if any(m.status == "running" for m in chat.messages):
            raise Busy("This chat is still waiting for an earlier answer")
        if not chat.messages:
            chat.title = question.strip().splitlines()[0][:80] or "New chat"
        chat.updated_at = func.now()
        message = models.AgentMessage(chat_id=chat_id, question=question)
        db.add(message)
        db.commit()
        db.refresh(message)
    _start(message.id)
    return message


async def cancel(message_id: int) -> None:
    """Stop: cancel the agent's job if it has a cancel tool, and stop waiting for it either way."""
    with SessionLocal() as db:
        message = db.get(models.AgentMessage, message_id)
        if message is None or message.status != "running":
            return
        agent = message.chat.agent
        url, key, state = agent.url, agent.api_key, dict(message.state or {})
    task = _tasks.pop(message_id, None)
    if task is not None:
        task.cancel()
    note = None
    if state.get("cancel"):
        try:
            await asyncio.to_thread(mcp.call_sync, url, key, state["cancel"]["tool"], state["cancel"]["args"])
        except mcp.ConnectError as exc:
            note = f"Couldn't cancel on the agent: {exc}"
    elif state.get("poll"):
        note = "Stopped waiting; the agent has no cancel tool, so it may still finish the job"
    _save(message_id, status="stopped", error=note)


def resume_waiting() -> None:
    """On startup: keep checking on agent jobs that were being waited on; mark the rest as interrupted."""
    with SessionLocal() as db:
        rows = db.scalars(select(models.AgentMessage).where(models.AgentMessage.status == "running")).all()
        resume = []
        for row in rows:
            if (row.state or {}).get("poll"):
                resume.append(row.id)
            else:
                row.status = "error"
                row.error = "Interrupted: the server restarted while sending this message"
        db.commit()
    for message_id in resume:
        _start(message_id)


async def stop_all() -> None:
    """On shutdown: stop the background checks (they're resumed on the next start)."""
    tasks = [t for t in list(_tasks.values()) if not t.done()]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=5)
