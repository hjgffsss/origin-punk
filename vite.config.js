import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    // WalletConnect / Coinbase Wallet SDK expect a few Node.js globals
    // (Buffer, global, process) that Vite doesn't provide in the browser
    // by default — without this, the app crashes on load with a blank
    // white screen before React even mounts.
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
});
