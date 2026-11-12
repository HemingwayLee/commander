from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ConversationCreate(BaseModel):
    model: str | None = None


class ConversationUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    model: str | None = None


class ConversationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    model: str
    created_at: datetime
    updated_at: datetime


class TurnRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    question: str
    content: str
    created_at: datetime
    model: str
    activity: list[dict[str, Any]]
    status: str
    error: str | None
    cost_usd: float | None


class ConversationDetail(ConversationRead):
    turns: list[TurnRead]


class ChatRequest(BaseModel):
    content: str = Field(min_length=1)


class AgentCreate(BaseModel):
    url: str = Field(min_length=1, max_length=500)
    api_key: str | None = None
    name: str | None = Field(default=None, max_length=200)  # default: the name the server reports


class McpToolCall(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)


class AgentChatRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    agent_id: int
    title: str
    created_at: datetime
    updated_at: datetime


class AgentMessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    question: str
    content: str
    activity: list[dict[str, Any]]
    status: str
    error: str | None
    created_at: datetime


class AgentChatDetail(AgentChatRead):
    messages: list[AgentMessageRead]
