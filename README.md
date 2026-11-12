# commander

A chat GUI for Claude Code. React + MUI frontend, FastAPI backend, PostgreSQL.

The backend drives Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
so each chat is a real Claude Code session: it can read and edit files, run commands, and search the web
inside `./workspace`.

## Setup

```bash
cp .env.example .env
claude setup-token            # Pro/Max plan: paste the printed token into CLAUDE_CODE_OAUTH_TOKEN in .env
docker compose -f docker-compose.dev.yml up --build
```

Credentials, set one in `.env`:

- **`CLAUDE_CODE_OAUTH_TOKEN`**: uses your Claude Pro/Max subscription. `claude setup-token` creates a one-year
  token. For personal use only; keep it out of git (`.env` is ignored).
- **`ANTHROPIC_API_KEY`**: pay-as-you-go API billing. Per-reply cost is shown only in this mode.

| Service  | URL                          |
| -------- | ---------------------------- |
| Chat UI  | http://localhost:5679        |
| API      | http://localhost:8766/api    |
| API docs | http://localhost:8766/docs   |
| Postgres | localhost:5433 (app/app/app) |
| pgweb    | http://localhost:8082        |

Ports are offset by one from info-center so both can run at the same time.

## How it works

- `POST /api/conversations/{id}/messages` runs one Claude Code turn and streams it back as server-sent events
  (text deltas, tool calls, tool results, final cost).
- Each question and answer is one row in `turns`: question, answer (`content`, Markdown), tool activity, status,
  error and cost. Each conversation keeps its Claude Code session id, and the next message resumes that session.
  Session transcripts live in the `claude-config` volume.
- Answers run as background jobs (`backend/app/jobs.py`): closing the page doesn't stop one, and reopening the chat
  shows it live from the start. At most `MAX_CONCURRENT_TURNS` run at once. The Stop button cancels the answer
  (`POST /api/turns/{id}/cancel`); the partial reply is kept.
- Tools are pre-approved (`permission_mode="dontAsk"`). Default set: Read, Write, Edit, Glob, Grep, Bash, WebSearch,
  WebFetch, TodoWrite. Override with `CLAUDE_ALLOWED_TOOLS='["Read","Glob","Grep"]'`. Bash runs inside the backend
  container, not on your machine.

## Agents (MCP)

Plug in **agents**, any MCP servers over Streamable HTTP, from the top bar, as many as you like. For example,
[info-center](../info-center), whose research tools are `start_research`, `get_research`, `search_answers` and
`cancel_research`:

1. Run info-center (`http://localhost:5678`) and create an integration on its **Integrations** tab.
2. Click **Add agent** in commander's top bar, paste the key and click **Plug in**. The backend checks the URL and
   key with an MCP handshake first. The URL starts as `AGENT_MCP_URL` (default `http://host.docker.internal:8765/mcp`,
   info-center's port on the host as seen from inside the container). The API key is optional (sent as
   `Authorization: Bearer <key>`), and so is the name: by default it's the one the server reports (e.g.
   "info-center research"), with a number added if another agent already has it.

The top bar reads, from the left: **commander**, **Chat** (talk to Claude Code: the chats), a button for each
plugged-in agent, and **Add agent** (which stays, to add more):

- Clicking the agent's name opens its page, with two views (switch in its header). **Chat** goes back to the
  Claude Code chats.
  - **Chat** works like the Chat tab, with its own saved chats in the side panel, but messages go to the agent
    over MCP instead of to Claude. An MCP server has tools, not a chat, so the message goes to its message tool:
    the one with a required text parameter named like a message (`question`, `prompt`, `message`, ...), e.g.
    info-center's `start_research(question)`. If the reply is a background job (a status like `queued` or
    `running`), the backend keeps calling the tool that checks on it (one that reads and takes the reply's ids,
    e.g. `get_research(job_id)`) every `check_again_in_seconds` until it's done, then shows the answer's Markdown.
    Short values from replies (e.g. `conversation_id`) are passed to later messages' parameters of the same name,
    so follow-ups keep their context. Stop calls the agent's cancel tool (e.g. `cancel_research`) when it has one.
    Answers keep going when you close the page, and resume being checked after a backend restart (the job runs
    on the agent). An agent with no message tool opens in Tools.
  - **Tools** lists its tools in the side panel, each with a form built from the tool's input schema, and calls
    and results show up as a conversation. Values from a result (like a `job_id`) fill matching fields of the
    next tool, and ↻ repeats a call.
- Claude can use every agent's tools in chats too, as `mcp__<slug>__<tool>` (e.g.
  `mcp__info-center-research__start_research`), from the next answer on.
- The ⏻ button next to the name unplugs the agent: its button and its chats go away, and Claude's chats stop
  getting its tools.

Agents are rows in the `agents` table, their chats in `agent_chats` and `agent_messages`. API: `GET/POST
/api/agents`, `DELETE /api/agents/{id}`, `GET /api/agents/{id}/tools`, `POST /api/agents/{id}/tools/{name}`,
`GET /api/agents/{id}/chat-profile`, `GET/POST /api/agents/{id}/chats`, `GET/PATCH/DELETE /api/agent-chats/{id}`,
`POST /api/agent-chats/{id}/messages`, `POST /api/agent-messages/{id}/cancel`. Code: `backend/app/mcp.py`,
`backend/app/agent_chat.py`, `frontend/src/components/AgentBar.jsx`, `frontend/src/AgentPage.jsx`,
`frontend/src/AgentChat.jsx`.

The UI and API have no login: don't expose them beyond localhost as-is.

## Development

Both apps hot reload: edit files under `frontend/src` (Vite HMR) or `backend/app` (uvicorn `--reload`).
The frontend calls the API via `/api`, which Vite proxies to the backend.

After changing dependencies (`package.json` or `requirements.txt`), rebuild with a fresh `node_modules` volume:

```bash
docker compose -f docker-compose.dev.yml up --build -V
```

Reset the database and Claude sessions: `docker compose -f docker-compose.dev.yml down -v`
