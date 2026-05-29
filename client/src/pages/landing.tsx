import { useEffect } from "react";
import { useTheme } from "@/components/theme-provider";

export default function LandingPage() {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme("light");
  }, [setTheme]);

  return (
    <main className="min-h-screen w-full bg-[#f8f5f0] text-neutral-900" />
  );
}
