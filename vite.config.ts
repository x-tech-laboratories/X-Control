import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server_port = Number(process.env.PORT ?? 7780);

// The page for a browser, with relative paths so a proxy can serve it under a folder; the phone build goes to its own folder.
export default defineConfig(({ mode }) => ({
  root: "src/web",
  base: "./",
  plugins: [react()],
  build: { outDir: mode === "android" ? "../../out/android" : "../../out/web", emptyOutDir: true },
  // The dev page reaches the API through the separately running server.
  server: { proxy: { "/api/": `http://127.0.0.1:${server_port}` } },
}));
