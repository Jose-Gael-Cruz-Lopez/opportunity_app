import { useEffect, useState } from "react";

/**
 * The current time, refreshed every minute, so "3 days left" rolls over at midnight without a
 * reload while staying stable between renders (memoised lists do not re-sort on every frame).
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
