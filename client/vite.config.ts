import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import viteCompression from "vite-plugin-compression";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    const envDir = path.resolve(__dirname, "..");
    const env = loadEnv(mode, envDir, "");
    const serverPort = env.SERVER_PORT || "3000";
    // When unset, the client would use `window.location.origin` (e.g. Vite :5173).
    // In dev, default to the agent URL so `pnpm start` + `pnpm start:client` work
    // without editing .env. The financial-agent backend sets CORS `*`, so direct
    // cross-origin calls from :5173 → :3000 are fine.
    const serverBaseUrl =
        (env.SERVER_BASE_URL && env.SERVER_BASE_URL.trim()) ||
        (mode === "development" ? `http://localhost:${serverPort}` : "");
    const proxyTarget = serverBaseUrl || `http://localhost:${serverPort}`;
    // /api and /health are added defensively (if BASE_URL is ever empty).
    const devProxy = {
        "/api": { target: proxyTarget, changeOrigin: true },
        "/health": { target: proxyTarget, changeOrigin: true },
    };
    return {
        plugins: [
            react(),
            viteCompression({
                algorithm: "brotliCompress",
                ext: ".br",
                threshold: 1024,
            }),
        ],
        clearScreen: false,
        envDir,
        define: {
            "import.meta.env.VITE_SERVER_PORT": JSON.stringify(
                env.SERVER_PORT || "3000"
            ),
            "import.meta.env.VITE_SERVER_URL": JSON.stringify(
                env.SERVER_URL || "http://localhost"
            ),
            "import.meta.env.VITE_SERVER_BASE_URL": JSON.stringify(serverBaseUrl)
        },
        root: '.',
        base: '/',
        build: {
            outDir: "dist",
            emptyOutDir: true,
            minify: true,
            cssMinify: true,
            sourcemap: false,
            cssCodeSplit: true,
        },
        resolve: {
            alias: {
                "@": path.resolve(__dirname, "./src"),
            },
        },
        server: {
            proxy: devProxy,
        },
        preview: {
            proxy: devProxy,
        },
    };
});
