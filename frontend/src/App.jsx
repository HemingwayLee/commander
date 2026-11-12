import { useEffect, useState } from "react";
import { AppBar, Box, Button, Toolbar, Tooltip, Typography } from "@mui/material";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import { api } from "./api";
import AgentBar from "./components/AgentBar";
import ThemeToggle from "./components/ThemeToggle";
import AgentPage from "./AgentPage";
import ChatPage from "./ChatPage";

export default function App() {
  const [agents, setAgents] = useState(null); // plugged-in MCP servers, or null if the API is down
  const [view, setView] = useState("chat"); // "chat", or the id of the agent whose page is open

  useEffect(() => {
    api.agents().then(setAgents).catch(() => setAgents(null));
  }, []);

  const openAgent = agents?.some((a) => a.id === view) ? view : null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar variant="dense" sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, userSelect: "none", flexShrink: 0 }}>
            commander
          </Typography>
          {/* Left to right: Chat (Claude Code), each plugged-in agent, Add agent. */}
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 1 }}>
            <Tooltip title="Talk to Claude Code">
              <Button
                size="small"
                variant={openAgent ? "outlined" : "contained"}
                disableElevation
                startIcon={<ChatBubbleOutlineIcon />}
                onClick={() => setView("chat")}
                sx={{ flexShrink: 0, textTransform: "none", borderRadius: 5 }}
              >
                Chat
              </Button>
            </Tooltip>
            {agents && (
              <AgentBar
                agents={agents}
                activeId={openAgent}
                onOpen={setView}
                onAdded={(agent) => {
                  setAgents((list) => [...list, agent]);
                  setView(agent.id);
                }}
                onRemoved={(id) => {
                  setAgents((list) => list.filter((a) => a.id !== id));
                  setView((v) => (v === id ? "chat" : v));
                }}
              />
            )}
          </Box>
          <ThemeToggle />
        </Toolbar>
      </AppBar>
      {/* Every page stays mounted, so switching keeps a chat's live answer and each agent's call log. */}
      <Box sx={{ display: openAgent ? "none" : "flex", flex: 1, minHeight: 0 }}>
        <ChatPage />
      </Box>
      {(agents ?? []).map((agent) => (
        <Box key={agent.id} sx={{ display: agent.id === openAgent ? "flex" : "none", flex: 1, minHeight: 0 }}>
          <AgentPage agent={agent} />
        </Box>
      ))}
    </Box>
  );
}
