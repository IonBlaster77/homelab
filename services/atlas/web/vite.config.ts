import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: `npm run dev` here, with the API (src/api/main.ts) on 127.0.0.1:8081.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8081" },
  },
  build: {
    // Everything bundled, nothing from a CDN: the API's CSP allows 'self' only.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
});
