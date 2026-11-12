/**
 * Small helpers for the readers. No DOM or Node types, so shared/ typechecks for the browser and
 * the Worker alike.
 */

/**
 * Imports an optional package by a specifier held in a variable, so bundlers do not try to
 * resolve it before it is installed. Returns null when it is missing. Integration can swap this
 * for a static `() => import("pdfjs-dist")` to get code splitting.
 */
export async function loadOptional<T>(specifier: string): Promise<T | null> {
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as { default?: T } & T;
    return ((mod as { default?: T }).default ?? mod) as T;
  } catch {
    return null;
  }
}

export function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Only http(s) and mailto links are kept (a DOCX can carry javascript: links). */
export function safeLinks(urls: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (typeof u !== "string") continue;
    const t = u.trim();
    if (!/^(?:https?:\/\/|mailto:)/i.test(t) || t.length > 300) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 20);
}

/** Rejects when the promise takes longer than `ms`; the error message is the code "timeout". */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("read-failed"));
      },
    );
  });
}
