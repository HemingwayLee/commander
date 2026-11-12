import { useState } from "react";
import {
  Box,
  Button,
  IconButton,
  InputBase,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";

const MAX_TITLE = 200; // matches the backend's ConversationUpdate limit

/** Inline title editor: Enter or clicking away saves, Esc cancels. */
function TitleEditor({ initial, onSave, onCancel }) {
  const [value, setValue] = useState(initial);
  const save = () => {
    const title = value.trim();
    if (title && title !== initial) onSave(title);
    else onCancel();
  };

  return (
    <InputBase
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      inputProps={{ maxLength: MAX_TITLE, "aria-label": "Conversation title" }}
      sx={{
        flex: 1,
        fontSize: 14,
        px: 0.75,
        my: "2px",
        borderRadius: 1,
        bgcolor: "background.paper",
        outline: 2,
        outlineColor: (theme) => theme.palette.primary.main,
      }}
    />
  );
}

export default function Sidebar({ conversations, currentId, onSelect, onNew, onDelete, onRename }) {
  const [editingId, setEditingId] = useState(null);

  return (
    <Stack sx={{ height: "100%", p: 1.5 }}>
      <Button variant="outlined" startIcon={<AddIcon />} onClick={onNew} sx={{ mb: 1 }}>
        New conversation
      </Button>

      <Box sx={{ flex: 1, overflowY: "auto", mx: -0.5 }}>
        <List dense>
          {conversations.map((c) => {
            const editing = c.id === editingId;
            const active = c.id === currentId;
            return (
              <ListItemButton
                key={c.id}
                selected={active}
                // While editing, clicks belong to the text field (and must not close the mobile drawer).
                onClick={(e) => (editing ? e.stopPropagation() : onSelect(c.id))}
                onDoubleClick={() => setEditingId(c.id)}
                disableRipple={editing}
                sx={{
                  borderRadius: 1,
                  gap: 0.25,
                  "&:hover .actions, &:focus-within .actions": { visibility: "visible" },
                }}
              >
                {editing ? (
                  <TitleEditor
                    initial={c.title}
                    onSave={(title) => {
                      setEditingId(null);
                      onRename(c.id, title);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <ListItemText
                      primary={c.title}
                      title={c.title}
                      slotProps={{ primary: { noWrap: true } }}
                    />
                    <Box
                      className="actions"
                      sx={{ display: "flex", flexShrink: 0, visibility: active ? "visible" : "hidden" }}
                    >
                      <Tooltip title="Rename">
                        <IconButton
                          size="small"
                          aria-label="Rename conversation"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(c.id);
                          }}
                        >
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton
                          size="small"
                          aria-label="Delete conversation"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(c.id);
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </>
                )}
              </ListItemButton>
            );
          })}
        </List>
        {conversations.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>
            No conversations yet.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
