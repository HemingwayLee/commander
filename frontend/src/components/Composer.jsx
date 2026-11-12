import { useLayoutEffect, useRef, useState } from "react";
import { IconButton, InputBase, Paper, Tooltip } from "@mui/material";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import StopIcon from "@mui/icons-material/Stop";

/**
 * Message box. `history` is previously sent prompts, newest first: Up on the first line recalls an older
 * one, Down on the last line a newer one, and going past the newest restores what you were typing.
 */
export default function Composer({
  onSend,
  onStop,
  streaming,
  autoFocus,
  history = [],
  placeholder = "Send a message to Claude Code",
}) {
  const [value, setValue] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1); // -1: editing the draft, not browsing history
  const draftRef = useRef("");
  const inputRef = useRef(null);
  const caretToEnd = useRef(false);

  // After recalling a prompt, put the caret at its end (like a shell).
  useLayoutEffect(() => {
    if (!caretToEnd.current || !inputRef.current) return;
    caretToEnd.current = false;
    const end = inputRef.current.value.length;
    inputRef.current.setSelectionRange(end, end);
  }, [value]);

  const recall = (index) => {
    if (historyIndex === -1) draftRef.current = value;
    caretToEnd.current = true;
    setHistoryIndex(index);
    setValue(index === -1 ? draftRef.current : history[index]);
  };

  const submit = () => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue("");
    setHistoryIndex(-1);
    draftRef.current = "";
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) {
      return;
    }
    const { selectionStart, selectionEnd, value: text } = e.target;
    if (selectionStart !== selectionEnd) return;
    if (e.key === "ArrowUp") {
      // Only from the first line, so Up still moves between lines of a multi-line prompt.
      if (text.lastIndexOf("\n", selectionStart - 1) !== -1 || historyIndex >= history.length - 1) return;
      e.preventDefault();
      recall(historyIndex + 1);
    } else {
      if (historyIndex === -1 || text.indexOf("\n", selectionStart) !== -1) return;
      e.preventDefault();
      recall(historyIndex - 1);
    }
  };

  return (
    <Paper
      variant="outlined"
      sx={{ display: "flex", alignItems: "flex-end", gap: 1, p: 1, pl: 2, borderRadius: 4 }}
    >
      <InputBase
        multiline
        maxRows={10}
        autoFocus={autoFocus}
        inputRef={inputRef}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        sx={{ flex: 1, py: 0.75 }}
      />
      {streaming ? (
        <Tooltip title="Stop">
          <IconButton onClick={onStop} sx={{ bgcolor: "action.selected" }}>
            <StopIcon />
          </IconButton>
        </Tooltip>
      ) : (
        <Tooltip title="Send (Enter)">
          <span>
            <IconButton
              onClick={submit}
              disabled={!value.trim()}
              sx={{
                bgcolor: "primary.main",
                color: "primary.contrastText",
                "&:hover": { bgcolor: "primary.dark" },
              }}
            >
              <ArrowUpwardIcon />
            </IconButton>
          </span>
        </Tooltip>
      )}
    </Paper>
  );
}
