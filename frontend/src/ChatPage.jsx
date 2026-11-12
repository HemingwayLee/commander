import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, MenuItem, Select, Stack, Typography } from "@mui/material";
import { api, applyEvent, newTurn, streamMessage, watchTurn } from "./api";
import Composer from "./components/Composer";
import TurnItem from "./components/TurnItem";
import Sidebar from "./components/Sidebar";
import SplitLayout from "./layout/SplitLayout";

// Width of the message column and composer.
const CHAT_MAX_WIDTH = 1200;

export default function ChatPage() {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [conversations, setConversations] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [turns, setTurns] = useState([]); // saved questions and answers in this chat
  const [draft, setDraft] = useState(null); // turn being answered right now
  const [error, setError] = useState(null);
  const [promptHistory, setPromptHistory] = useState([]); // sent prompts, newest first (Up/Down recall)

  const abortRef = useRef(null); // stops watching the answer in progress (it keeps running on the server)
  const currentRef = useRef(null); // the open chat, for callbacks that outlive a switch
  currentRef.current = currentId;
  const bottomRef = useRef(null);
  const streaming = draft !== null;

  const refreshConversations = useCallback(async () => {
    setConversations(await api.listConversations());
  }, []);

  useEffect(() => {
    api
      .models()
      .then(({ models, default: def }) => {
        setModels(models);
        setModel(def);
      })
      .catch((e) => setError(`Cannot reach the API: ${e.message}`));
    refreshConversations().catch(() => {});
    api
      .promptHistory()
      .then(setPromptHistory)
      .catch(() => {});
  }, [refreshConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, draft]);

  /** Stop watching the answer in progress without stopping it: it keeps running on the server. */
  const detach = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDraft(null);
  };

  /**
   * Show an answer as it's written: `run(onEvent, signal)` streams its events into `initial`. When it ends, the
   * server's saved copy joins the chat; if we switched away (detach), nothing changes here.
   */
  const follow = async (conversationId, initial, run) => {
    let final = initial;
    setDraft(final);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await run((event) => {
        final = applyEvent(final, event);
        if (!controller.signal.aborted) setDraft(final);
      }, controller.signal);
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    }
    if (controller.signal.aborted) return;
    abortRef.current = null;
    setDraft(null);
    if (currentRef.current === conversationId) {
      if (final.id != null) setTurns((prev) => [...prev, final]);
      else loadConversation(conversationId); // the stream broke before the answer was saved: ask the server
    }
    refreshConversations();
  };

  const loadConversation = async (id) => {
    try {
      const convo = await api.getConversation(id);
      if (currentRef.current !== id) return;
      setModel(convo.model);
      const last = convo.turns.at(-1);
      if (last?.status === "running") {
        // Still being written (e.g. after a reload): watch it from the start.
        setTurns(convo.turns.slice(0, -1));
        const initial = { ...newTurn(last.question, { model: last.model }), turnId: last.id };
        follow(id, initial, (onEvent, signal) => watchTurn(last.id, { onEvent, signal }));
      } else {
        setTurns(convo.turns);
      }
    } catch (e) {
      setError(e.message);
    }
  };

  const openConversation = (id) => {
    detach();
    setCurrentId(id);
    currentRef.current = id;
    setTurns([]);
    loadConversation(id);
  };

  const newChat = () => {
    detach();
    setCurrentId(null);
    currentRef.current = null;
    setTurns([]);
  };

  const renameChat = async (id, title) => {
    // Show the new title right away; roll back if the save fails.
    const previous = conversations;
    setConversations((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await api.updateConversation(id, { title });
    } catch (e) {
      setConversations(previous);
      setError(`Couldn't rename the conversation: ${e.message}`);
    }
  };

  const deleteChat = async (id) => {
    if (id === currentId) newChat();
    try {
      await api.deleteConversation(id); // also stops its answer if one is being written
    } catch (e) {
      setError(`Couldn't delete the conversation: ${e.message}`);
    }
    refreshConversations();
  };

  const changeModel = async (value) => {
    setModel(value);
    if (currentId) await api.updateConversation(currentId, { model: value });
  };

  const send = async (text) => {
    setError(null);
    let id = currentId;
    try {
      if (!id) {
        id = (await api.createConversation(model)).id;
        setCurrentId(id);
        currentRef.current = id;
      }
    } catch (e) {
      setError(e.message);
      return;
    }

    setPromptHistory((prev) => (prev[0] === text ? prev : [text, ...prev]));
    await follow(id, newTurn(text, { model }), (onEvent, signal) => streamMessage(id, text, { signal, onEvent }));
  };

  // Stop asks the server to stop; the stream then ends with the partial answer, saved as "stopped".
  const stop = async () => {
    if (!draft?.turnId) return;
    try {
      await api.cancelTurn(draft.turnId);
    } catch (e) {
      setError(`Couldn't stop: ${e.message}`);
    }
  };

  const empty = turns.length === 0 && !streaming;
  const errorAlert = error && (
    <Alert severity="error" sx={{ mb: empty ? 2 : 1 }} onClose={() => setError(null)}>
      {error}
    </Alert>
  );
  const composer = (
    <Composer onSend={send} onStop={stop} streaming={streaming} history={promptHistory} autoFocus={empty} />
  );

  return (
    <SplitLayout
      sidebar={
        <Sidebar
          conversations={conversations}
          currentId={currentId}
          onSelect={openConversation}
          onNew={newChat}
          onDelete={deleteChat}
          onRename={renameChat}
        />
      }
      header={
        <Select
          size="small"
          variant="standard"
          disableUnderline
          value={models.length ? model : ""}
          onChange={(e) => changeModel(e.target.value)}
          disabled={streaming}
          sx={{ fontWeight: 600 }}
        >
          {models.map((m) => (
            <MenuItem key={m.id} value={m.id}>
              {m.name}
            </MenuItem>
          ))}
        </Select>
      }
    >
      {empty ? (
        <Stack sx={{ flex: 1, justifyContent: "center", alignItems: "center", px: 2 }}>
          <Box sx={{ width: "100%", maxWidth: CHAT_MAX_WIDTH }}>
            <Typography variant="h4" sx={{ textAlign: "center", mb: 3, fontWeight: 600 }}>
              What can Claude Code do for you?
            </Typography>
            {errorAlert}
            {composer}
          </Box>
        </Stack>
      ) : (
        <>
          <Box sx={{ flex: 1, overflowY: "auto", px: { xs: 2, md: 4 } }}>
            <Box sx={{ maxWidth: CHAT_MAX_WIDTH, mx: "auto", py: 2 }}>
              {turns.map((t, i) => (
                <TurnItem key={t.id ?? `local-${i}`} turn={t} />
              ))}
              {draft && <TurnItem turn={draft} streaming />}
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
