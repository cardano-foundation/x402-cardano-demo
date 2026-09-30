import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  // The Cardano browser bundle uses Buffer for CBOR and payment headers.
  plugins: [react(), nodePolyfills({ globals: { Buffer: true } })],
  // Read masumi/.env, the same file the agent uses.
  envDir: ".",
  // Expose only the Blockfrost settings from .env to the browser (never the mnemonic).
  envPrefix: ["BLOCKFROST_PROJECT_ID", "BLOCKFROST_BASE_URL"],
  server: {
    port: 5174,
    // The UI calls the agent through /api so that the browser needs no CORS setup.
    proxy: { "/api": { target: `http://localhost:${process.env.PORT ?? 8787}`, rewrite: path => path.replace(/^\/api/, "") } },
  },
});
