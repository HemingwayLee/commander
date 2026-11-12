import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import PowerOffOutlinedIcon from "@mui/icons-material/PowerOffOutlined";
import { api } from "../api";

/** Dialog for a new agent: MCP URL, optional API key and name. The backend checks them with an MCP handshake. */
function PlugDialog({ onClose, onPlugged }) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .agentDefaults()
      .then((d) => setUrl((current) => current || d.url || ""))
      .catch(() => {});
  }, []);

  const plug = async () => {
    setBusy(true);
    setError(null);
    try {
      onPlugged(await api.plugInAgent({ url: url.trim(), api_key: key.trim() || null, name: name.trim() || null }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={() => !busy && onClose()} fullWidth maxWidth="sm">
      <DialogTitle>Add an agent</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Plug in any MCP server (Streamable HTTP). It gets its own button in the top bar: call its tools from its page,
          and Claude can use them in chats. For info-center, create a key on its <b>Integrations</b> tab.
        </Typography>
        <Box component="form" onSubmit={(e) => (e.preventDefault(), plug())} sx={{ display: "grid", gap: 2, pt: 0.5 }}>
          <TextField
            label="MCP URL"
            size="small"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            helperText="From inside Docker, your machine is host.docker.internal"
          />
          <TextField
            label="API key (optional)"
            size="small"
            type="password"
            autoFocus
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            helperText="Sent as Authorization: Bearer <key>"
          />
          <TextField
            label="Name (optional)"
            size="small"
            value={name}
            onChange={(e) => setName(e.target.value)}
            helperText="Shown on its button. Default: the name the server reports"
          />
          {error && <Alert severity="error">{error}</Alert>}
          <button type="submit" hidden />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={plug} disabled={busy || !url.trim()}>
          {busy ? "Checking…" : "Plug in"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** One plugged-in agent: its name opens its page; the power button unplugs it. */
function AgentButton({ agent, active, onOpen, onUnplugged }) {
  const [busy, setBusy] = useState(false);

  const unplug = async () => {
    setBusy(true);
    try {
      await api.unplugAgent(agent.id);
      onUnplugged();
    } catch {
      setBusy(false); // still plugged in; the button stays
    }
  };

  return (
    <ButtonGroup
      size="small"
      variant={active ? "contained" : "outlined"}
      disableElevation
      sx={{ flexShrink: 0, "& .MuiButton-root": { textTransform: "none" } }}
    >
      <Tooltip title={`Talk to ${agent.name} (${agent.url})`}>
        <Button startIcon={<HubOutlinedIcon />} onClick={onOpen} sx={{ borderRadius: "20px 0 0 20px", maxWidth: 220 }}>
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {agent.name}
          </Box>
        </Button>
      </Tooltip>
      <Tooltip title={`Unplug ${agent.name}`}>
        <Button onClick={unplug} disabled={busy} aria-label={`Unplug ${agent.name}`} sx={{ borderRadius: "0 20px 20px 0", px: 1 }}>
          {busy ? <CircularProgress size={16} color="inherit" /> : <PowerOffOutlinedIcon fontSize="small" />}
        </Button>
      </Tooltip>
    </ButtonGroup>
  );
}

/**
 * Top bar, after the Chat button: a button for each plugged-in agent (an MCP server), then "Add agent".
 * `activeId` is the agent whose page is open, if any.
 */
export default function AgentBar({ agents, activeId, onOpen, onAdded, onRemoved }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, overflowX: "auto", py: 0.5 }}>
      {agents.map((agent) => (
        <AgentButton
          key={agent.id}
          agent={agent}
          active={agent.id === activeId}
          onOpen={() => onOpen(agent.id)}
          onUnplugged={() => onRemoved(agent.id)}
        />
      ))}
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        startIcon={<AddIcon />}
        onClick={() => setDialogOpen(true)}
        sx={{ flexShrink: 0, textTransform: "none", borderRadius: 5 }}
      >
        Add agent
      </Button>
      {dialogOpen && (
        <PlugDialog
          onClose={() => setDialogOpen(false)}
          onPlugged={(agent) => {
            setDialogOpen(false);
            onAdded(agent);
          }}
        />
      )}
    </Box>
  );
}
