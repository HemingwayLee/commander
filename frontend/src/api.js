async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    // Surface FastAPI's {"detail": ...} message when there is one.
    const body = await res.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? body.detail : body?.detail?.[0]?.msg;
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  models: () => request("/models"),
  listConversations: () => request("/conversations"),
  getConversation: (id) => request(`/conversations/${id}`),
  createConversation: (model) =>
    request("/conversations", { method: "POST", body: JSON.stringify({ model }) }),
  updateConversation: (id, patch) =>
    request(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteConversation: (id) => request(`/conversations/${id}`, { method: "DELETE" }),
  promptHistory: () => request("/prompts/history"),
  // Stop an answer (the Stop button). It keeps running on the server until stopped, even if the page closes.
  cancelTurn: (id) => request(`/turns/${id}/cancel`, { method: "POST" }),
  // Agents: MCP servers plugged in from the top bar. Plugging in checks the URL and key first.
  agents: () => request("/agents"),
  agentDefaults: () => request("/agents/defaults"),
  plugInAgent: (body) => request("/agents", { method: "POST", body: JSON.stringify(body) }),
  unplugAgent: (id) => request(`/agents/${id}`, { method: "DELETE" }),
  // Talk to an agent directly: its tools (live tools/list) and one tool call (tools/call).
  agentTools: (id) => request(`/agents/${id}/tools`),
  callAgentTool: (id, name, args) =>
    request(`/agents/${id}/tools/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ arguments: args }) }),
  // Chats with an agent: a message goes to the agent's message tool; the answer is written in the background.
  agentChatProfile: (id) => request(`/agents/${id}/chat-profile`),
  agentChats: (id) => request(`/agents/${id}/chats`),
  createAgentChat: (id) => request(`/agents/${id}/chats`, { method: "POST" }),
  getAgentChat: (chatId) => request(`/agent-chats/${chatId}`),
  renameAgentChat: (chatId, title) =>
    request(`/agent-chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteAgentChat: (chatId) => request(`/agent-chats/${chatId}`, { method: "DELETE" }),
  sendAgentMessage: (chatId, content) =>
    request(`/agent-chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
  cancelAgentMessage: (messageId) => request(`/agent-messages/${messageId}/cancel`, { method: "POST" }),
};

/** Read a server-sent event stream, calling onEvent for each event; resolves when the stream ends. */
async function readEvents(res, onEvent) {
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `${res.status} ${res.statusText}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
}

/**
 * Send a chat message and stream Claude Code's reply. The first event is {type: "turn", turn_id}.
 * Aborting `signal` only stops watching: the answer keeps going on the server (use api.cancelTurn to stop it).
 */
export async function streamMessage(conversationId, content, { onEvent, signal }) {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  });
  await readEvents(res, onEvent);
}

/** Watch an answer from its start (e.g. one still running after a reload). */
export async function watchTurn(turnId, { onEvent, signal }) {
  await readEvents(await fetch(`/api/turns/${turnId}/stream`, { signal }), onEvent);
}

/** A turn being answered, before the server has saved it (no id yet). */
export const newTurn = (question, { model }) => ({
  id: null,
  question,
  model,
  content: "",
  activity: [],
  status: "running",
  error: null,
  cost_usd: null,
  newMessage: false,
});

const joinErrors = (a, b) => (a ? `${a}\n${b}` : b);

/** Fold a streamed event into the turn being answered (mirrors Answer in backend/app/jobs.py). */
export function applyEvent(turn, event) {
  switch (event.type) {
    case "text": {
      let content = turn.content;
      // Text from consecutive assistant messages (e.g. before and after a tool call) is new paragraphs.
      if (turn.newMessage && content && !content.endsWith("\n\n")) content = `${content.replace(/\n+$/, "")}\n\n`;
      return { ...turn, content: content + event.text, newMessage: false };
    }
    case "turn":
      return { ...turn, turnId: event.turn_id }; // the server's id, for Stop; `id` stays null until saved
    case "message_start":
      return { ...turn, newMessage: true };
    case "tool_use":
    case "tool_result":
      return { ...turn, activity: [...turn.activity, event] };
    case "result":
      return event.is_error
        ? { ...turn, cost_usd: event.cost_usd, status: "error", error: joinErrors(turn.error, event.result || event.subtype) }
        : { ...turn, cost_usd: event.cost_usd, status: "complete" };
    case "error":
      return { ...turn, status: "error", error: joinErrors(turn.error, event.text) };
    case "saved":
      return event.turn; // the server's copy: final status, id
    default:
      return turn;
  }
}
