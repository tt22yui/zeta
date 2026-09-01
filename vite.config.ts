import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,

  server: {
    port: 5117,
    strictPort: true,
    watch: {
      // 忽略 Rust 目录，避免触发无谓的前端重载
      ignored: ["**/src-tauri/**"],
    },
  },
}));