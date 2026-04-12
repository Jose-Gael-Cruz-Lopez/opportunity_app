import { defineConfig, createLogger } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

/* Vite may wrap messages in ANSI colors; strip before matching. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function suppressPostcssNoise(raw: string): boolean {
  const msg = stripAnsi(raw);
  if (msg.includes("PostCSS plugin did not pass the `from` option")) return true;
  if (msg.includes("@import must precede all other statements")) return true;
  return false;
}

const logger = createLogger();
const origWarn = logger.warn.bind(logger);
logger.warn = (msg: string, opts?: object) => {
  if (typeof msg === "string" && suppressPostcssNoise(msg)) return;
  origWarn(msg, opts);
};
const warnOnce = logger.warnOnce.bind(logger);
logger.warnOnce = (msg: string, opts?: object) => {
  if (typeof msg === "string" && suppressPostcssNoise(msg)) return;
  warnOnce(msg, opts);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          config: path.resolve(import.meta.dirname, "tailwind.config.ts"),
        }),
        autoprefixer(),
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || id.includes("/react/")) {
              return "react-vendor";
            }
            if (id.includes("gsap")) {
              return "gsap";
            }
            if (id.includes("@radix-ui")) {
              return "radix-ui";
            }
            if (id.includes("lucide-react")) {
              return "icons";
            }
          }
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
