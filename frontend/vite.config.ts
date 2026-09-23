import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  // The Cardano browser bundle uses Buffer for CBOR and payment headers.
  plugins: [react(), nodePolyfills({ globals: { Buffer: true } })],
});
