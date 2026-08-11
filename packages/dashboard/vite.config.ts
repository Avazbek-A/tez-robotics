import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const PROXIED_PATHS = ["/ws", "/orders", "/robots", "/map", "/kpi", "/health"];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API || "http://localhost:8080";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: Object.fromEntries(
        PROXIED_PATHS.map((path) => [
          path,
          { target: apiTarget, changeOrigin: true, ws: path === "/ws" },
        ]),
      ),
    },
  };
});
