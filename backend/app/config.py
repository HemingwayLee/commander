from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://app:app@localhost:5433/app"
    cors_origins: list[str] = ["http://localhost:5679"]

    # Claude Code (Agent SDK) settings
    claude_workspace: str = "/workspace"
    claude_default_model: str = "claude-opus-5-5"
    claude_allowed_tools: list[str] = [
        "Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "TodoWrite",
    ]
    # Largest single message accepted from the Claude Code CLI (SDK default is 1 MB).
    claude_max_buffer_bytes: int = 64 * 1024 * 1024
    # Tool output longer than this is cut off in the chat UI and database.
    tool_result_display_chars: int = 20_000

    # Answers run as background jobs; at most this many Claude Code processes run at once, the rest wait.
    max_concurrent_turns: int = 3

    # Agents (MCP servers plugged in from the top bar, app/mcp.py): the URL the "Add agent" dialog starts with.
    # Default: info-center on the host (from inside Docker, the host is host.docker.internal).
    agent_mcp_url: str = "http://host.docker.internal:8765/mcp"
    # How long a tool call from the agent's page may take.
    agent_call_timeout_seconds: float = 120
    # Agent chats: how long to keep checking on an agent's background job before giving up.
    agent_answer_max_seconds: float = 3600


settings = Settings()
