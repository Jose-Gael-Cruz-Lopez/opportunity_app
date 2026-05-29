import { useEffect } from "react";
import { useTheme } from "@/components/theme-provider";

export default function LandingPage() {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme("light");
  }, [setTheme]);

  return (
    <main className="min-h-screen w-full bg-[#f8f5f0] text-neutral-900">
      <section className="flex h-screen items-end px-12 pb-16">
        <div className="max-w-[760px]">
          <div
            className="mb-6 text-[13px] uppercase tracking-[0.18em] text-neutral-500"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Novus — Product Surfaces
          </div>
          <h1
            className="text-[clamp(2.5rem,5vw,4.5rem)] leading-[1.05] text-neutral-900"
            style={{ fontFamily: "var(--font-display)", fontWeight: 500 }}
          >
            Six surfaces that work together as a single student career OS.
          </h1>
        </div>
      </section>
    </main>
  );
}
