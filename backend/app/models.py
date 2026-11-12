from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200), default="New conversation")
    model: Mapped[str] = mapped_column(String(100))
    # Claude Code session id, used to resume the agent's context on the next turn.
    claude_session_id: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    turns: Mapped[list["Turn"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", order_by="Turn.id"
    )


class Turn(Base):
    """One question and Claude's answer."""

    __tablename__ = "turns"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    question: Mapped[str] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, default="")  # the answer as Markdown; empty while running
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    model: Mapped[str] = mapped_column(String(100))
    # Tool calls and results while answering: [{"type": "tool_use" | "tool_result", ...}]
    activity: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="running")  # running | complete | stopped | error
    error: Mapped[str | None] = mapped_column(Text)
    cost_usd: Mapped[float | None]

    conversation: Mapped[Conversation] = relationship(back_populates="turns")


class Agent(Base):
    """An MCP server plugged in from the top bar (see app/mcp.py)."""

    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Claude sees its tools as mcp__<slug>__<tool>.
    slug: Mapped[str] = mapped_column(String(50), unique=True)
    name: Mapped[str] = mapped_column(String(200))  # shown on its top bar button
    url: Mapped[str] = mapped_column(String(500))
    api_key: Mapped[str | None] = mapped_column(Text)
    # Tool names the server offered when it was plugged in.
    tools: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AgentChat(Base):
    """A chat with a plugged-in agent (see app/agent_chat.py). Removed with its agent."""

    __tablename__ = "agent_chats"

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200), default="New chat")
    # Short values from the agent's replies (e.g. conversation_id), passed to later messages' matching parameters.
    context: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    agent: Mapped[Agent] = relationship()
    messages: Mapped[list["AgentMessage"]] = relationship(
        back_populates="chat", cascade="all, delete-orphan", order_by="AgentMessage.id"
    )


class AgentMessage(Base):
    """One message to an agent and its answer."""

    __tablename__ = "agent_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_id: Mapped[int] = mapped_column(ForeignKey("agent_chats.id", ondelete="CASCADE"), index=True)
    question: Mapped[str] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, default="")  # the answer as Markdown
    # The agent's tool calls, in the chat UI's shape: [{"type": "tool_use" | "tool_result", ...}]
    activity: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="running")  # running | complete | stopped | error
    error: Mapped[str | None] = mapped_column(Text)
    # While waiting on the agent's background job: the tools (and ids) to check on it and to cancel it.
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    chat: Mapped[AgentChat] = relationship(back_populates="messages")
