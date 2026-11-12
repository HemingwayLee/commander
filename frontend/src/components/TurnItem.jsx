import { useState } from "react";
import { Alert, Box, Button, Stack, Tooltip, Typography } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import Markdown from "./Markdown";
import ToolCall from "./ToolCall";

function Question({ text }) {
  return (
    <Stack sx={{ alignItems: "flex-end", my: 2 }}>
      <Box
        sx={{
          maxWidth: "80%",
          bgcolor: "action.selected",
          px: 2,
          py: 1.25,
          borderRadius: 3,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </Box>
    </Stack>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(null); // null | "ok" | error message

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch (e) {
      setCopied(`Couldn't copy: ${e.message}`);
    }
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <>
      <Tooltip title="Copy the answer as Markdown">
        <Button
          size="small"
          onClick={copy}
          startIcon={copied === "ok" ? <CheckIcon /> : <ContentCopyIcon />}
          sx={{ color: "text.secondary", textTransform: "none", minWidth: 0, px: 1 }}
        >
          {copied === "ok" ? "Copied" : "Copy"}
        </Button>
      </Tooltip>
      {copied && copied !== "ok" && (
        <Typography variant="caption" color="error">
          {copied}
        </Typography>
      )}
    </>
  );
}

export default function TurnItem({ turn, streaming = false }) {
  const results = Object.fromEntries(
    turn.activity.filter((b) => b.type === "tool_result").map((b) => [b.tool_use_id, b])
  );
  const tools = turn.activity.filter((b) => b.type === "tool_use");
  const body = turn.content;

  return (
    <>
      <Question text={turn.question} />
      <Box sx={{ my: 2 }}>
        {tools.map((tool) => (
          <ToolCall key={tool.id} tool={tool} result={results[tool.id]} running={streaming} />
        ))}
        {body && <Markdown>{body}</Markdown>}
        {streaming && !body && tools.length === 0 && <Typography color="text.secondary">Thinking…</Typography>}
        {turn.error && (
          <Alert severity="error" sx={{ my: 1, whiteSpace: "pre-wrap" }}>
            {turn.error}
          </Alert>
        )}
        {turn.status === "stopped" && !streaming && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            Stopped
          </Typography>
        )}
        {!streaming && (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 1, ml: -1 }}>
            {body && <CopyButton text={body} />}
            {turn.cost_usd != null && (
              <Typography variant="caption" color="text.disabled">
                ${turn.cost_usd.toFixed(4)}
              </Typography>
            )}
          </Stack>
        )}
      </Box>
    </>
  );
}
