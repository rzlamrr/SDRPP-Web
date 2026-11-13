import { defineConfig } from "vite";
import { mockBackend } from "./mock/backend";

// `npm run dev` serves the interface with a simulated backend, so the UI can be worked on without a radio.
// Set SDRPP_BACKEND=http://127.0.0.1:8080 to use a running `sdrpp --web` instead.
const backend = process.env.SDRPP_BACKEND;

export default defineConfig({
  base: "./",
  plugins: backend ? [] : [mockBackend()],
  build: {
    // Served by sdrpp from <resources directory>/web
    outDir: "../../root/res/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: backend
      ? {
          "/api": backend,
          "/res": backend,
          "/ws": { target: backend, ws: true },
        }
      : undefined,
  },
});
