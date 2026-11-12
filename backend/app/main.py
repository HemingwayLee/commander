import json
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app import agent_chat, jobs, mcp, models, schemas
from app.claude import MODELS
from app.config import settings
from app.db import Base, engine, get_db

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Dev convenience: create tables on startup. Swap for Alembic migrations later.
    Base.metadata.create_all(bind=engine)
    if count := jobs.recover_interrupted():
        logger.warning("Marked %d answers interrupted by a restart as errors", count)
    agent_chat.resume_waiting()  # keep checking on agents' background jobs
    yield
    await jobs.cancel_all()  # save partial answers of anything still running
    await agent_chat.stop_all()


app = FastAPI(title="commander API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _get_conversation(db: Session, conversation_id: int) -> models.Conversation:
    conversation = db.get(models.Conversation, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "ok"}


@app.get("/api/models")
def list_models():
    return {"models": MODELS, "default": settings.claude_default_model}


@app.get("/api/agents")
def list_agents():
    """Plugged-in agents (MCP servers), each a button in the top bar."""
    return mcp.list_agents()


@app.get("/api/agents/defaults")
def agent_defaults():
    """Starting values for the "Add agent" dialog."""
    return mcp.defaults()


@app.post("/api/agents", status_code=201)
async def plug_in_agent(payload: schemas.AgentCreate):
    """Plug in an agent: check the URL and key with an MCP handshake, then add it."""
    try:
        return await mcp.plug_in(payload.url, payload.api_key, payload.name)
    except mcp.ConnectError as exc:
        raise HTTPException(400, str(exc)) from None


@app.delete("/api/agents/{agent_id}", status_code=204)
def unplug_agent(agent_id: int):
    """Unplug an agent: it leaves the top bar, and chats stop getting its tools."""
    try:
        mcp.unplug(agent_id)
    except mcp.NotFound as exc:
        raise HTTPException(404, str(exc)) from None


@app.get("/api/agents/{agent_id}/tools")
async def agent_tools(agent_id: int):
    """An agent's tools (name, description, inputSchema), for its page."""
    try:
        return await mcp.tools(agent_id)
    except mcp.NotFound as exc:
        raise HTTPException(404, str(exc)) from None
    except mcp.ConnectError as exc:
        raise HTTPException(400, str(exc)) from None


@app.post("/api/agents/{agent_id}/tools/{name}")
async def call_agent_tool(agent_id: int, name: str, payload: schemas.McpToolCall):
    """Call one of an agent's tools directly. Returns the MCP result (content, structuredContent, isError)."""
    try:
        return await mcp.call_tool(agent_id, name, payload.arguments)
    except mcp.NotFound as exc:
        raise HTTPException(404, str(exc)) from None
    except mcp.ConnectError as exc:
        raise HTTPException(400, str(exc)) from None


# ---- Agent chats: messages go to an agent over MCP (app/agent_chat.py) ----


def _get_agent_chat(db: Session, chat_id: int) -> models.AgentChat:
    chat = db.get(models.AgentChat, chat_id)
    if chat is None:
        raise HTTPException(404, "Chat not found")
    return chat


@app.get("/api/agents/{agent_id}/chat-profile")
async def agent_chat_profile(agent_id: int):
    """Which of the agent's tools a chat message goes to ({tool, param, title}); 400 if none takes a message."""
    try:
        return agent_chat.chat_profile(await mcp.tools(agent_id))
    except mcp.NotFound as exc:
        raise HTTPException(404, str(exc)) from None
    except (mcp.ConnectError, agent_chat.NoChatTool) as exc:
        raise HTTPException(400, str(exc)) from None


@app.get("/api/agents/{agent_id}/chats", response_model=list[schemas.AgentChatRead])
def list_agent_chats(agent_id: int, db: Session = Depends(get_db)):
    stmt = select(models.AgentChat).where(models.AgentChat.agent_id == agent_id)
    return db.scalars(stmt.order_by(models.AgentChat.updated_at.desc())).all()


@app.post("/api/agents/{agent_id}/chats", response_model=schemas.AgentChatRead, status_code=201)
def create_agent_chat(agent_id: int, db: Session = Depends(get_db)):
    if db.get(models.Agent, agent_id) is None:
        raise HTTPException(404, "No such agent: it may have been unplugged")
    chat = models.AgentChat(agent_id=agent_id)
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return chat


@app.get("/api/agent-chats/{chat_id}", response_model=schemas.AgentChatDetail)
def get_agent_chat(chat_id: int, db: Session = Depends(get_db)):
    return _get_agent_chat(db, chat_id)


@app.patch("/api/agent-chats/{chat_id}", response_model=schemas.AgentChatRead)
def rename_agent_chat(chat_id: int, payload: schemas.ConversationUpdate, db: Session = Depends(get_db)):
    chat = _get_agent_chat(db, chat_id)
    if payload.title:
        # Setting updated_at to itself skips its onupdate, so renaming doesn't reorder the chat list.
        db.execute(
            update(models.AgentChat)
            .where(models.AgentChat.id == chat_id)
            .values(title=payload.title, updated_at=models.AgentChat.updated_at)
        )
        db.commit()
        db.refresh(chat)
    return chat


@app.delete("/api/agent-chats/{chat_id}", status_code=204)
async def delete_agent_chat(chat_id: int, db: Session = Depends(get_db)):
    chat = _get_agent_chat(db, chat_id)
    for message in chat.messages:  # stop waiting on an answer; there's nowhere to save it
        if message.status == "running":
            await agent_chat.cancel(message.id)
    db.delete(chat)
    db.commit()


# Async because it starts a background task on the event loop.
@app.post("/api/agent-chats/{chat_id}/messages", response_model=schemas.AgentMessageRead, status_code=201)
async def send_agent_message(chat_id: int, payload: schemas.ChatRequest, db: Session = Depends(get_db)):
    """Send a message to the agent. The answer is written in the background: poll the chat until it's done."""
    _get_agent_chat(db, chat_id)
    try:
        return agent_chat.send(chat_id, payload.content)
    except agent_chat.Busy as exc:
        raise HTTPException(409, str(exc)) from None


@app.post("/api/agent-messages/{message_id}/cancel", status_code=202)
async def cancel_agent_message(message_id: int):
    """Stop: cancels the agent's job if it has a cancel tool, and stops waiting for it."""
    await agent_chat.cancel(message_id)
    return {"stopping": True}


@app.get("/api/prompts/history")
def prompt_history(limit: int = 200, db: Session = Depends(get_db)):
    """Recently sent prompts across all chats, newest first, for Up/Down recall in the composer."""
    stmt = select(models.Turn.question).order_by(models.Turn.id.desc()).limit(min(max(limit, 1), 1000))
    prompts: list[str] = []
    for question in db.scalars(stmt):
        if question and (not prompts or prompts[-1] != question):  # drop consecutive repeats
            prompts.append(question)
    return prompts


@app.get("/api/conversations", response_model=list[schemas.ConversationRead])
def list_conversations(db: Session = Depends(get_db)):
    return db.scalars(select(models.Conversation).order_by(models.Conversation.updated_at.desc())).all()


@app.post("/api/conversations", response_model=schemas.ConversationRead, status_code=201)
def create_conversation(payload: schemas.ConversationCreate, db: Session = Depends(get_db)):
    conversation = models.Conversation(model=payload.model or settings.claude_default_model)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


@app.get("/api/conversations/{conversation_id}", response_model=schemas.ConversationDetail)
def get_conversation(conversation_id: int, db: Session = Depends(get_db)):
    return _get_conversation(db, conversation_id)


@app.patch("/api/conversations/{conversation_id}", response_model=schemas.ConversationRead)
def update_conversation(
    conversation_id: int, payload: schemas.ConversationUpdate, db: Session = Depends(get_db)
):
    conversation = _get_conversation(db, conversation_id)
    data = payload.model_dump(exclude_unset=True)
    if data:
        # Setting updated_at to itself skips its onupdate, so renaming doesn't reorder the chat list.
        db.execute(
            update(models.Conversation)
            .where(models.Conversation.id == conversation_id)
            .values(**data, updated_at=models.Conversation.updated_at)
        )
        db.commit()
        db.refresh(conversation)
    return conversation


@app.delete("/api/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: int, db: Session = Depends(get_db)):
    conversation = _get_conversation(db, conversation_id)
    for turn in conversation.turns:  # stop an answer still being written; there's nowhere to save it
        if turn.status == "running":
            jobs.cancel(turn.id)
    db.delete(conversation)
    db.commit()


def _event_stream(turn_id: int) -> StreamingResponse:
    """Server-sent events for an answer, from its start. Disconnecting stops the stream, not the answer."""

    async def stream():
        async for event in jobs.watch(turn_id):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Async because it starts a background job on the event loop.
@app.post("/api/conversations/{conversation_id}/messages")
async def send_message(conversation_id: int, payload: schemas.ChatRequest, db: Session = Depends(get_db)):
    """Ask a question in a chat and stream the answer. The first event is {"type": "turn", "turn_id"}."""
    conversation = _get_conversation(db, conversation_id)
    try:
        turn = jobs.start_turn(db, conversation, payload.content)
    except jobs.Busy as exc:
        raise HTTPException(409, str(exc)) from None
    return _event_stream(turn.id)


@app.get("/api/turns/{turn_id}/stream")
def watch_turn(turn_id: int, db: Session = Depends(get_db)):
    """Watch an answer from its start: a running one live, a finished one as its saved copy."""
    if db.get(models.Turn, turn_id) is None:
        raise HTTPException(404, "Answer not found")
    return _event_stream(turn_id)


@app.post("/api/turns/{turn_id}/cancel", status_code=202)
async def cancel_turn(turn_id: int, db: Session = Depends(get_db)):
    """Stop a running answer (the Stop button). The partial answer is saved as "stopped"."""
    turn = db.get(models.Turn, turn_id)
    if turn is None:
        raise HTTPException(404, "Answer not found")
    return {"stopping": jobs.cancel(turn_id), "status": turn.status}
