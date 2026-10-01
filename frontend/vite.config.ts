import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  // The Cardano browser bundle uses Buffer for CBOR and payment headers.
  plugins: [react(), nodePolyfills({ globals: { Buffer: true } })],
  // The Masumi tab imports browser-safe modules from ../masumi/src. Resolve
  // their packages from this app so the bundle holds one copy of each.
  resolve: { dedupe: ["@x402/cardano", "@x402/core", "@evolution-sdk/evolution", "@noble/hashes"] },
});
