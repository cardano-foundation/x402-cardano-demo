import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(({ mode }) => {
  // Read masumi/.env, the same file the agent uses, so both agree on ports.
  const env = { ...loadEnv(mode, ".", ""), ...process.env };
  return {
    // The Cardano browser bundle uses Buffer for CBOR and payment headers.
    plugins: [react(), nodePolyfills({ globals: { Buffer: true } })],
    envDir: ".",
    // Expose only the Blockfrost settings from .env to the browser (never the mnemonic).
    envPrefix: ["BLOCKFROST_PROJECT_ID", "BLOCKFROST_BASE_URL"],
    server: {
      port: 5174,
      proxy: {
        // The UI calls the agent through /api so that the browser needs no CORS setup.
        "/api": { target: `http://localhost:${env.PORT || 8787}`, rewrite: path => path.replace(/^\/api/, "") },
        // Operator-only Sokosumi proxy. It accepts Host 127.0.0.1:<port> only (hence
        // changeOrigin) and checks the forwarded host and client (hence xfwd).
        "/sokosumi": { target: `http://127.0.0.1:${env.SOKOSUMI_PROXY_PORT || 8788}`, changeOrigin: true, xfwd: true },
      },
    },
  };
});
