import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5679,
    // Polling makes file watching reliable across Docker bind mounts.
    watch: { usePolling: process.env.VITE_USE_POLLING === "true" },
    proxy: {
      "/api": process.env.API_PROXY_TARGET || "http://localhost:8766",
    },
  },
});
