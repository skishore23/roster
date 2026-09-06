import { defineConfig } from "vite";

const tauriHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    host: tauriHost ?? "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: tauriHost
      ? {
          protocol: "ws",
          host: tauriHost,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});

