import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import ReplayIcon from "@mui/icons-material/Replay";
import SendIcon from "@mui/icons-material/Send";
import { api } from "./api";
import Markdown from "./components/Markdown";
import SplitLayout from "./layout/SplitLayout";
import AgentChat from "./AgentChat";

const MAX_WIDTH = 1200;
// String fields with these names get a multi-line box (questions, prompts, ...).
const LONG_TEXT = /question|prompt|message|text|content|input|body|instructions/i;

// ---- Tool input schemas -> form fields -------------------------------------------------------------------

/** The JSON Schema type of a property, looking through anyOf/oneOf (e.g. [{type: "string"}, {type: "null"}]). */
function fieldType(prop) {
  if (prop.enum) return "enum";
  const type = prop.type ?? (prop.anyOf || prop.oneOf || []).map((p) => p.type).find((t) => t && t !== "null");
  const t = Array.isArray(type) ? type.find((x) => x !== "null") : type;
  return ["string", "integer", "number", "boolean"].includes(t) ? t : "json";
}

function fieldsOf(tool) {
  const schema = tool?.inputSchema ?? {};
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
    name,
    prop,
    type: fieldType(prop),
    required: required.has(name),
    label: prop.title || name,
  }));
}

/** Form values (strings, or booleans for switches) for a tool: its defaults, then values from earlier results. */
function initialValues(tool, memory) {
  const values = {};
  for (const f of fieldsOf(tool)) {
    const fallback = f.prop.default;
    if (f.type === "boolean") values[f.name] = fallback ?? false;
    else if (memory[f.name] !== undefined) values[f.name] = String(memory[f.name]);
    else if (fallback !== undefined && fallback !== null)
      values[f.name] = f.type === "json" ? JSON.stringify(fallback) : String(fallback);
    else values[f.name] = "";
  }
  return values;
}

/** Form values -> tool arguments. Empty optional fields are left out so the tool uses its defaults. */
function toArguments(tool, values) {
  const args = {};
  for (const f of fieldsOf(tool)) {
    const raw = values[f.name];
    if (f.type === "boolean") {
      args[f.name] = Boolean(raw);
      continue;
    }
    if (raw === "" || raw === undefined) {
      if (f.required) throw new Error(`${f.label} is required`);
      continue;
    }
    if (f.type === "integer" || f.type === "number") {
      const n = Number(raw);
      if (Number.isNaN(n) || (f.type === "integer" && !Number.isInteger(n))) throw new Error(`${f.label} must be a ${f.type}`);
      args[f.name] = n;
    } else if (f.type === "json") {
      try {
        args[f.name] = JSON.parse(raw);
      } catch {
        throw new Error(`${f.label} must be JSON`);
      }
    } else {
      args[f.name] = raw;
    }
  }
  return args;
}

function Field({ field, value, onChange, onSubmit }) {
  const { name, prop, type, required, label } = field;
  if (type === "boolean") {
    return (
      <FormControlLabel
        control={<Switch checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />}
        label={label}
        title={prop.description}
      />
    );
  }
  const long = type === "string" && LONG_TEXT.test(name);
  return (
    <TextField
      size="small"
      label={label}
      required={required}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      select={type === "enum"}
      type={type === "integer" || type === "number" ? "number" : "text"}
      multiline={long || type === "json"}
      minRows={long ? 2 : undefined}
      maxRows={10}
      helperText={prop.description || (type === "json" ? "JSON" : undefined)}
      onKeyDown={(e) => {
        // Enter sends from one-line fields; Ctrl/Cmd+Enter from multi-line ones.
        if (e.nativeEvent.isComposing || e.key !== "Enter") return;
        if (!(long || type === "json") || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onSubmit();
        }
      }}
      sx={{ gridColumn: long || type === "json" ? "1 / -1" : undefined }}
    >
      {type === "enum" &&
        prop.enum.map((option) => (
          <MenuItem key={String(option)} value={option}>
            {String(option)}
          </MenuItem>
        ))}
    </TextField>
  );
}

// ---- Results ---------------------------------------------------------------------------------------------

/** A tool result's data: structuredContent, or its text parsed as JSON when it is JSON. */
function resultData(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const texts = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0]);
    } catch {
      // Not JSON: shown as text.
    }
  }
  return undefined;
}

function JsonBlock({ data }) {
  return (
    <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: "action.hover", borderRadius: 1, overflowX: "auto", fontSize: 13 }}>
      {JSON.stringify(data, null, 2)}
    </Box>
  );
}

const isMarkdownish = (value) => typeof value === "string" && (value.includes("\n") || value.length > 200);

function ResultView({ result }) {
  const [showJson, setShowJson] = useState(false);
  const data = resultData(result);
  const content = result?.content ?? [];

  if (result?.isError) {
    return <Alert severity="error">{content.map((c) => c.text).filter(Boolean).join("\n") || "The tool failed"}</Alert>;
  }

  if (data === undefined || data === null || typeof data !== "object") {
    // Plain content: text as Markdown, images inline.
    return (
      <Stack spacing={1}>
        {content.map((c, i) =>
          c.type === "text" ? (
            <Markdown key={i}>{c.text}</Markdown>
          ) : c.type === "image" ? (
            <Box key={i} component="img" src={`data:${c.mimeType};base64,${c.data}`} sx={{ maxWidth: "100%" }} />
          ) : (
            <Typography key={i} variant="body2" color="text.secondary">
              [{c.type}]
            </Typography>
          )
        )}
      </Stack>
    );
  }

  // Objects: short fields as chips, long text (e.g. answer_markdown) as Markdown, and the raw JSON on request.
  const entries = Array.isArray(data) ? [] : Object.entries(data);
  const short = entries.filter(([, v]) => v !== null && typeof v !== "object" && !isMarkdownish(v));
  const long = entries.filter(([, v]) => isMarkdownish(v));
  const hasNested = Array.isArray(data) || entries.some(([, v]) => v !== null && typeof v === "object");

  return (
    <Stack spacing={1.5}>
      {short.length > 0 && (
        <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1 }}>
          {short.map(([k, v]) => (
            <Chip key={k} size="small" variant="outlined" label={`${k}: ${v}`} sx={{ maxWidth: "100%" }} />
          ))}
        </Stack>
      )}
      {long.map(([k, v]) => (
        <Box key={k}>
          {long.length > 1 && (
            <Typography variant="caption" color="text.secondary">
              {k}
            </Typography>
          )}
          <Markdown>{v}</Markdown>
        </Box>
      ))}
      {/* Nested data with no text to read is shown as JSON right away; otherwise the JSON is one click away. */}
      {hasNested && long.length === 0 ? (
        <JsonBlock data={data} />
      ) : (
        <Box>
          <Button size="small" onClick={() => setShowJson((s) => !s)}>
            {showJson ? "Hide JSON" : "Show JSON"}
          </Button>
          {showJson && <JsonBlock data={data} />}
        </Box>
      )}
    </Stack>
  );
}

function CallItem({ call, onRepeat }) {
  return (
    <Box sx={{ my: 2 }}>
      <Stack sx={{ alignItems: "flex-end" }}>
        <Box sx={{ maxWidth: "80%", bgcolor: "action.selected", px: 2, py: 1.25, borderRadius: 3 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, fontFamily: "monospace" }}>
            {call.tool}
          </Typography>
          {Object.entries(call.args).map(([k, v]) => (
            <Typography key={k} variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              <Box component="span" sx={{ color: "text.secondary" }}>
                {k}:
              </Box>{" "}
              {typeof v === "string" ? v : JSON.stringify(v)}
            </Typography>
          ))}
        </Box>
      </Stack>
      <Box sx={{ mt: 1.5 }}>
        {call.status === "pending" ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: "text.secondary" }}>
            <CircularProgress size={16} />
            <Typography variant="body2">Calling {call.tool}…</Typography>
          </Stack>
        ) : call.error ? (
          <Alert severity="error">{call.error}</Alert>
        ) : (
          <ResultView result={call.result} />
        )}
        {call.status !== "pending" && (
          <Tooltip title="Call again with the same arguments">
            <IconButton size="small" onClick={() => onRepeat(call)} sx={{ mt: 0.5 }}>
              <ReplayIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
}

// ---- Page ------------------------------------------------------------------------------------------------

/**
 * Tools view: call one plugged-in agent's tools directly: pick one of its tools, fill in the form built from its input schema,
 * and see the results as a conversation. Values from results (e.g. a job_id) fill matching fields of the next
 * tool, so multi-step tools (start a job, then check on it) flow without copying ids by hand.
 */
function ToolsView({ agent, header }) {
  const [tools, setTools] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState({});
  const [formError, setFormError] = useState(null);
  const [calls, setCalls] = useState([]);
  const memory = useRef({}); // top-level values from results, by name
  const bottomRef = useRef(null);
  const nextId = useRef(0);

  const selectTool = (tool) => {
    setSelected(tool);
    setValues(initialValues(tool, memory.current));
    setFormError(null);
  };

  useEffect(() => {
    setTools(null);
    setLoadError(null);
    api
      .agentTools(agent.id)
      .then((list) => {
        setTools(list);
        if (list.length) selectTool(list[0]);
      })
      .catch((e) => setLoadError(e.message));
  }, [agent.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [calls]);

  const run = async (tool, args) => {
    const id = nextId.current++;
    setCalls((list) => [...list, { id, tool, args, status: "pending" }]);
    let patch;
    try {
      const result = await api.callAgentTool(agent.id, tool, args);
      const data = resultData(result);
      if (!result.isError && data && typeof data === "object" && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) {
          if (v !== null && typeof v !== "object" && !isMarkdownish(v)) memory.current[k] = v;
        }
      }
      patch = { status: "done", result };
    } catch (e) {
      patch = { status: "done", error: e.message };
    }
    setCalls((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const submit = () => {
    if (!selected) return;
    let args;
    try {
      args = toArguments(selected, values);
    } catch (e) {
      setFormError(e.message);
      return;
    }
    setFormError(null);
    run(selected.name, args);
    // Clear long text (the question) for the next message; keep ids and options.
    setValues((v) =>
      Object.fromEntries(
        Object.entries(v).map(([k, val]) => [k, typeof val === "string" && LONG_TEXT.test(k) ? "" : val])
      )
    );
  };

  const sidebar = (
    <Box sx={{ py: 1 }}>
      <Typography variant="overline" sx={{ px: 2, color: "text.secondary" }}>
        Tools
      </Typography>
      {tools === null && !loadError && <CircularProgress size={20} sx={{ mx: 2, display: "block" }} />}
      <List dense disablePadding>
        {(tools ?? []).map((t) => (
          <ListItemButton key={t.name} selected={selected?.name === t.name} onClick={() => selectTool(t)}>
            <ListItemText
              primary={t.annotations?.title || t.title || t.name}
              secondary={t.name}
              slotProps={{ secondary: { sx: { fontFamily: "monospace", fontSize: 12 } } }}
            />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );

  const fields = fieldsOf(selected);
  return (
    <SplitLayout
      sidebar={sidebar}
      header={header}
    >
      <Box sx={{ flex: 1, overflowY: "auto", px: { xs: 2, md: 4 } }}>
        <Box sx={{ maxWidth: MAX_WIDTH, mx: "auto", py: 2 }}>
          {loadError && <Alert severity="error">Couldn&apos;t list the agent&apos;s tools: {loadError}</Alert>}
          {calls.length === 0 && !loadError && (
            <Typography color="text.secondary" sx={{ textAlign: "center", mt: 6 }}>
              Pick a tool, fill it in and send. Results show up here.
            </Typography>
          )}
          {calls.map((c) => (
            <CallItem key={c.id} call={c} onRepeat={(call) => run(call.tool, call.args)} />
          ))}
          <div ref={bottomRef} />
        </Box>
      </Box>

      {selected && (
        <Box sx={{ px: { xs: 2, md: 4 }, pb: 2 }}>
          <Box
            component="form"
            onSubmit={(e) => (e.preventDefault(), submit())}
            sx={{ maxWidth: MAX_WIDTH, mx: "auto", border: 1, borderColor: "divider", borderRadius: 3, p: 2 }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", mb: 1.5 }}>
              <Typography sx={{ fontWeight: 600 }}>{selected.annotations?.title || selected.title || selected.name}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
                {selected.name}
              </Typography>
            </Stack>
            {selected.description && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 1.5, whiteSpace: "pre-line", maxHeight: 96, overflowY: "auto" }}
              >
                {selected.description.replace(/^[ \t]+/gm, "").trim()}
              </Typography>
            )}
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5 }}>
              {fields.map((f) => (
                <Field
                  key={`${selected.name}.${f.name}`}
                  field={f}
                  value={values[f.name]}
                  onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
                  onSubmit={submit}
                />
              ))}
            </Box>
            {formError && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                {formError}
              </Alert>
            )}
            <Stack direction="row" sx={{ justifyContent: "flex-end", mt: 1.5 }}>
              <Button type="submit" variant="contained" endIcon={<SendIcon />}>
                Send
              </Button>
            </Stack>
          </Box>
        </Box>
      )}
    </SplitLayout>
  );
}

/**
 * A plugged-in agent's page. Chat (like the Chat tab): messages go to the agent's message tool over MCP. Tools:
 * call any of its tools with a form. Agents without a tool that takes a message open in Tools.
 */
export default function AgentPage({ agent }) {
  const [mode, setMode] = useState("chat");
  const [noChat, setNoChat] = useState(null); // why chat isn't available, if it isn't

  const onProfileError = useCallback((message) => {
    setNoChat(message);
    setMode("tools");
  }, []);

  const header = (
    <Stack direction="row" spacing={2} sx={{ alignItems: "center", minWidth: 0, flex: 1 }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600 }} noWrap>
          {agent.name}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap component="div">
          {agent.url}
        </Typography>
      </Box>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={mode}
        onChange={(_, value) => value && setMode(value)}
        sx={{ "& .MuiToggleButton-root": { textTransform: "none", px: 1.5, py: 0.25 } }}
      >
        <Tooltip title={noChat || "Chat with the agent"}>
          <span>
            <ToggleButton value="chat" disabled={Boolean(noChat)} selected={mode === "chat"}>
              Chat
            </ToggleButton>
          </span>
        </Tooltip>
        <Tooltip title="Call its tools directly">
          <ToggleButton value="tools" selected={mode === "tools"}>
            Tools
          </ToggleButton>
        </Tooltip>
      </ToggleButtonGroup>
    </Stack>
  );

  // Both views stay mounted, so switching keeps the chat and the tool call log.
  return (
    <>
      <Box sx={{ display: mode === "chat" ? "flex" : "none", flex: 1, minHeight: 0 }}>
        <AgentChat agent={agent} header={header} onProfileError={onProfileError} />
      </Box>
      <Box sx={{ display: mode === "tools" ? "flex" : "none", flex: 1, minHeight: 0 }}>
        <ToolsView agent={agent} header={header} />
      </Box>
    </>
  );
}
