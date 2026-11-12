/**
 * The viewer's clock: the current instant (refreshed each minute so countdowns roll over at
 * midnight), their time zone and today's date in it. The zone comes from the profile when the
 * student set one, else from the browser.
 */
import { useEffect, useState } from "react";
import { todayIn, viewerTimeZone } from "./format";
import { useSession } from "./data";

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export interface Viewer {
  readonly now: number;
  readonly tz: string;
  readonly today: string;
  readonly signedIn: boolean | null;
}

export function useViewer(): Viewer {
  const session = useSession();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const tz = viewerTimeZone(session.data?.data.profile?.timeZone, browserZone());
  const signedIn = session.data ? session.data.data.user !== null || session.data.sample : null;
  return { now, tz, today: todayIn(now, tz), signedIn };
}
