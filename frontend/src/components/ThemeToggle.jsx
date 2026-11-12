import { IconButton, Tooltip, useColorScheme } from "@mui/material";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";

export default function ThemeToggle() {
  const { mode, systemMode, setMode } = useColorScheme();
  const resolved = mode === "system" ? systemMode : mode;

  return (
    <Tooltip title="Toggle theme">
      <IconButton size="small" color="inherit" onClick={() => setMode(resolved === "dark" ? "light" : "dark")}>
        {resolved === "dark" ? <LightModeOutlinedIcon /> : <DarkModeOutlinedIcon />}
      </IconButton>
    </Tooltip>
  );
}
