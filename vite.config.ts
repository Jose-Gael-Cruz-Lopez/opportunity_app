import { execFileSync } from "node:child_process";
import { defineConfig, createLogger } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

/* Vite may wrap messages in ANSI colors; strip before matching. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function suppressPostcssNoise(raw: string): boolean {
  const msg = stripAnsi(raw);
  if (msg.includes("PostCSS plugin did not pass the `from` option"))
    return true;
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

/**
 * The release id client crash reports carry (client/src/lib/telemetry): VITE_RELEASE when the
 * deploy sets it, else the short commit (GITHUB_SHA in CI, git locally). Builds only; the dev
 * server reports "dev". Must match /^[0-9A-Za-z._-]{1,40}$/ or reports are refused.
 */
function buildRelease(): string | null {
  const ok = (v: string | undefined | null) =>
    v && /^[0-9A-Za-z._-]{1,40}$/.test(v) ? v : null;
  const fromEnv = ok(process.env.VITE_RELEASE);
  if (fromEnv) return fromEnv;
  const sha = process.env.GITHUB_SHA?.slice(0, 7);
  if (ok(sha)) return sha!;
  try {
    return ok(
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return null;
  }
}

export default defineConfig(({ command }) => {
  const release = command === "build" ? buildRelease() : null;
  return {
    customLogger: logger,
    plugins: [react()],
    define: release
      ? { "import.meta.env.VITE_RELEASE": JSON.stringify(release) }
      : {},
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
    // Absolute: the Worker serves the same shell for every /app/* path, so a relative base would
    // resolve ./assets/x.js to /app/<deep>/assets/x.js and get HTML back.
    base: "/",
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        // Two HTML entries: the student app and the Curator console (served at /curate/* by the
        // Worker from dist/public/src/console/index.html).
        input: {
          main: path.resolve(import.meta.dirname, "client", "index.html"),
          console: path.resolve(
            import.meta.dirname,
            "client",
            "src",
            "console",
            "index.html",
          ),
        },
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
  };
});
