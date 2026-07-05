import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and ignores Vite's stdout for HMR.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    // Vite 8 ships Rolldown's native "oxc" minifier and no longer bundles
    // esbuild; "esbuild" here would require installing it as an extra dep.
    minify: !process.env.TAURI_ENV_DEBUG ? "oxc" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // streamdown (markdown renderer) is the bulk of the bundle and is
    // necessarily large; the 700 kB limit gives headroom over the current
    // ~615 kB without silencing future runaway-bundle issues.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Split heavy deps into their own chunks so the app shell stays
        // small and frequently-changed app code doesn't bust the vendor
        // cache. Vite 8's Rolldown bundler only accepts the function form
        // of manualChunks (the object form was dropped).
        manualChunks(id) {
          if (id.includes("node_modules/streamdown")) return "markdown";
          if (
            /node_modules\/(react|react-dom|scheduler)\//.test(id) ||
            /node_modules\/(react|react-dom|scheduler)$/.test(id)
          ) {
            return "react";
          }
        },
      },
    },
  },
}));
