/**
 * @fileoverview Vite build configuration for the React frontend.
 *
 * Configures the React plugin with Babel and the React Compiler for optimized
 * production builds. Dev server binds to all interfaces for Tailscale access.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react({
      babel: {
        // React Compiler optimizes component re-renders automatically
        plugins: [["babel-plugin-react-compiler"]],
      },
    }),
  ],
  server: {
    // Bind to all interfaces for remote access (e.g., via Tailscale)
    host: "0.0.0.0",
    port: 6969,
  },
});
