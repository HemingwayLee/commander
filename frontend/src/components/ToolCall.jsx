import { useState } from "react";
import { Box, ButtonBase, CircularProgress, Collapse, Stack, Typography } from "@mui/material";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

function summarize(name, input = {}) {
  const value =
    input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.description;
  return value ? String(value).split("\n")[0] : "";
}

const preSx = {
  m: 0,
  p: 1,
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 280,
  overflow: "auto",
  bgcolor: "action.hover",
  borderRadius: 1,
};

export default function ToolCall({ tool, result, running }) {
  const [open, setOpen] = useState(false);
  const status = result ? (
    result.is_error ? (
      <ErrorOutlineIcon fontSize="small" color="error" />
    ) : (
      <CheckCircleOutlineIcon fontSize="small" color="success" />
    )
  ) : running ? (
    <CircularProgress size={14} />
  ) : null;

  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, my: 1, overflow: "hidden" }}>
      <ButtonBase
        onClick={() => setOpen((o) => !o)}
        sx={{ width: "100%", justifyContent: "flex-start", px: 1.5, py: 0.75 }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0, width: "100%" }}>
          <BuildOutlinedIcon fontSize="small" sx={{ color: "text.secondary" }} />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {tool.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap sx={{ flex: 1, textAlign: "left" }}>
            {summarize(tool.name, tool.input)}
          </Typography>
          {status}
          <ExpandMoreIcon
            fontSize="small"
            sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms" }}
          />
        </Stack>
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          <Typography variant="caption" color="text.secondary">
            Input
          </Typography>
          <Box component="pre" sx={preSx}>
            {JSON.stringify(tool.input, null, 2)}
          </Box>
          {result && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
                Output
              </Typography>
              <Box component="pre" sx={preSx}>
                {result.content || "(no output)"}
              </Box>
            </>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
