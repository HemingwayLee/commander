import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Stack, Typography } from "@mui/material";
import { api } from "./api";
import Composer from "./components/Composer";
import Sidebar from "./components/Sidebar";
import TurnItem from "./components/TurnItem";
import SplitLayout from "./layout/SplitLayout";

const CHAT_MAX_WIDTH = 1200;
const POLL_MS = 2000; // how often to refresh a chat while the agent is answering

/** An agent message in the shape TurnItem shows (the same as a Claude Code turn). */
const asTurn = (m) => ({ ...m, cost_usd: null });

/**
 * Chat with a plugged-in agent, like the Chat tab: each message goes to the agent over MCP (its message tool,
 * e.g. start_research), and the backend waits for the answer, checking on the agent's job if it runs one. The
 * chat refreshes while an answer is being written; reloading the page or switching away doesn't stop it.
 */
export default function AgentChat({ agent, header, onProfileError }) {
  const [profile, setProfile] = useState(null); // {tool, param, title}
  const [chats, setChats] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const currentRef = useRef(null);
  currentRef.current = currentId;
  const bottomRef = useRef(null);

  const running = messages.at(-1)?.status === "running" ? messages.at(-1) : null;

  const refreshChats = useCallback(async () => {
    setChats(await api.agentChats(agent.id));
  }, [agent.id]);

  useEffect(() => {
    api
      .agentChatProfile(agent.id)
      .then(setProfile)
      .catch((e) => onProfileError?.(e.message));
    refreshChats().catch((e) => setError(e.message));
  }, [agent.id, refreshChats, onProfileError]);

  const loadChat = useCallback(async (id) => {
    try {
      const chat = await api.getAgentChat(id);
      if (currentRef.current === id) setMessages(chat.messages);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // While the agent is answering, refresh the chat until the answer is saved.
  useEffect(() => {
    if (!running || currentId == null) return undefined;
    const timer = setInterval(async () => {
      await loadChat(currentId);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running?.id, currentId, loadChat]);

  // When an answer finishes, the chat moves to the top of the list.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) refreshChats().catch(() => {});
    wasRunning.current = Boolean(running);
  }, [running, refreshChats]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const openChat = (id) => {
    setCurrentId(id);
    currentRef.current = id;
    setMessages([]);
    setError(null);
    loadChat(id);
  };

  const newChat = () => {
    setCurrentId(null);
    currentRef.current = null;
    setMessages([]);
    setError(null);
  };

  const send = async (text) => {
    setError(null);
    let id = currentId;
    try {
      if (id == null) {
        id = (await api.createAgentChat(agent.id)).id;
        setCurrentId(id);
        currentRef.current = id;
      }
      const message = await api.sendAgentMessage(id, text);
      setMessages((list) => [...list, message]);
      refreshChats().catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  };

  const stop = async () => {
    if (!running) return;
    try {
      await api.cancelAgentMessage(running.id);
      await loadChat(currentId);
    } catch (e) {
      setError(`Couldn't stop: ${e.message}`);
    }
  };

  const renameChat = async (id, title) => {
    const previous = chats;
    setChats((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await api.renameAgentChat(id, title);
    } catch (e) {
      setChats(previous);
      setError(`Couldn't rename the chat: ${e.message}`);
    }
  };

  const deleteChat = async (id) => {
    if (id === currentId) newChat();
    try {
      await api.deleteAgentChat(id);
    } catch (e) {
      setError(`Couldn't delete the chat: ${e.message}`);
    }
    refreshChats().catch(() => {});
  };

  const empty = messages.length === 0;
  const errorAlert = error && (
    <Alert severity="error" sx={{ mb: empty ? 2 : 1 }} onClose={() => setError(null)}>
      {error}
    </Alert>
  );
  const composer = (
    <Composer
      onSend={send}
      onStop={stop}
      streaming={Boolean(running)}
      autoFocus={empty}
      placeholder={`Send a message to ${agent.name}`}
    />
  );
  const via = profile && (
    <Typography variant="caption" color="text.secondary" sx={{ display: "block", textAlign: "center", mt: 1 }}>
      Messages go to its <b>{profile.title}</b> tool (<code>{profile.tool}</code>, as <code>{profile.param}</code>) over
      MCP.
    </Typography>
  );

  return (
    <SplitLayout
      sidebar={
        <Sidebar
          conversations={chats}
          currentId={currentId}
          onSelect={openChat}
          onNew={newChat}
          onDelete={deleteChat}
          onRename={renameChat}
        />
      }
      header={header}
    >
      {empty ? (
        <Stack sx={{ flex: 1, justifyContent: "center", alignItems: "center", px: 2 }}>
          <Box sx={{ width: "100%", maxWidth: CHAT_MAX_WIDTH }}>
            <Typography variant="h4" sx={{ textAlign: "center", mb: 3, fontWeight: 600 }}>
              Ask {agent.name}
            </Typography>
            {errorAlert}
            {composer}
            {via}
          </Box>
        </Stack>
      ) : (
        <>
          <Box sx={{ flex: 1, overflowY: "auto", px: { xs: 2, md: 4 } }}>
            <Box sx={{ maxWidth: CHAT_MAX_WIDTH, mx: "auto", py: 2 }}>
              {messages.map((m) => (
                <TurnItem key={m.id} turn={asTurn(m)} streaming={m.status === "running"} />
              ))}
              <div ref={bottomRef} />
            </Box>
          </Box>
          <Box sx={{ px: { xs: 2, md: 4 }, pb: 2 }}>
            <Box sx={{ maxWidth: CHAT_MAX_WIDTH, mx: "auto" }}>
              {errorAlert}
              {composer}
            </Box>
          </Box>
        </>
      )}
    </SplitLayout>
  );
}
