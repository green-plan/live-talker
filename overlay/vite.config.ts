import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Proxies /overlay/* to the backend's overlay server during `npm run dev`, so
// the page works standalone without OBS or a production build.
const OVERLAY_PORT = process.env.OVERLAY_PORT ?? "3002";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/overlay": {
        target: `http://localhost:${OVERLAY_PORT}`,
        ws: true,
      },
    },
  },
});
