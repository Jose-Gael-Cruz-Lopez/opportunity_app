import type { Config } from "tailwindcss";

/**
 * Optional Tailwind preset exposing the Novus tokens as utilities (`bg-nv-surface`,
 * `text-nv-ink-2`, `font-dot`, `rounded-nv-card`). The shell itself styles through the
 * component classes in index.css and the remapped shadcn variables, so it works without this;
 * adding `presets: [novusPreset]` to tailwind.config.ts makes the utilities available to pages.
 */
export const novusPreset = {
  content: [],
  theme: {
    extend: {
      colors: {
        nv: {
          night: "var(--nv-night)",
          surface: "var(--nv-surface)",
          "surface-strong": "var(--nv-surface-strong)",
          ink: "var(--nv-ink)",
          "ink-2": "var(--nv-ink-2)",
          "ink-3": "var(--nv-ink-3)",
          "ink-dark": "var(--nv-ink-dark)",
          cream: "var(--nv-cream)",
          wheat: "var(--nv-wheat)",
          leaf: "var(--nv-leaf)",
          good: "var(--nv-good)",
          warn: "var(--nv-warn)",
          done: "var(--nv-done)",
          line: "var(--nv-line)",
          focus: "var(--nv-focus)",
        },
      },
      fontFamily: {
        dot: ["var(--nv-f-dot)"],
        nvsans: ["var(--nv-f-sans)"],
        nvmono: ["var(--nv-f-mono)"],
      },
      borderRadius: {
        "nv-card": "28px",
        "nv-panel": "34px",
        "nv-pill": "999px",
      },
      transitionTimingFunction: {
        "nv-out": "cubic-bezier(.22,1,.36,1)",
      },
    },
  },
} satisfies Config;
