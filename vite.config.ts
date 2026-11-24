import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// Vite config tailored for Tauri v2 desktop development and bundling
export default defineConfig({
  plugins: [react()],
  define: {
    // Expose package version at build time so UI labels stay synced with package.json
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
