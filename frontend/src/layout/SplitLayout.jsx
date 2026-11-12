import { useState } from "react";
import { Box, Drawer, IconButton, Stack, Tooltip, useMediaQuery } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import MenuOpenIcon from "@mui/icons-material/MenuOpen";

const SIDEBAR_WIDTH = 260;
const COLLAPSED_KEY = "sidebarCollapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Left sidebar + right main area. On desktop the sidebar can be hidden to give the main area the
 * full width (remembered per browser); on small screens it's a slide-out drawer that closes when
 * something inside it is clicked.
 */
export default function SplitLayout({ sidebar, header, children }) {
  const isDesktop = useMediaQuery((theme) => theme.breakpoints.up("md"));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, String(!c));
      } catch {
        // Storage unavailable (private mode): the choice just isn't remembered.
      }
      return !c;
    });
  };

  return (
    <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
      {isDesktop ? (
        <Box
          component="nav"
          sx={{
            width: collapsed ? 0 : SIDEBAR_WIDTH,
            flexShrink: 0,
            borderRight: collapsed ? 0 : 1,
            borderColor: "divider",
            overflowX: "hidden",
            overflowY: "auto",
            transition: "width 150ms",
          }}
        >
          <Box sx={{ width: SIDEBAR_WIDTH, height: "100%" }}>{sidebar}</Box>
        </Box>
      ) : (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onClick={() => setDrawerOpen(false)}
          sx={{ "& .MuiDrawer-paper": { width: SIDEBAR_WIDTH } }}
        >
          {sidebar}
        </Drawer>
      )}

      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: 2, py: 1, minHeight: 48 }}>
          <Tooltip title={isDesktop ? (collapsed ? "Show side panel" : "Hide side panel") : "Open side panel"}>
            <IconButton
              edge="start"
              onClick={isDesktop ? toggleCollapsed : () => setDrawerOpen(true)}
              aria-label={isDesktop && !collapsed ? "Hide side panel" : "Open side panel"}
            >
              {isDesktop && !collapsed ? <MenuOpenIcon /> : <MenuIcon />}
            </IconButton>
          </Tooltip>
          {header}
        </Stack>
        {children}
      </Stack>
    </Box>
  );
}
