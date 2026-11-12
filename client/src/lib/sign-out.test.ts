import { describe, expect, it, vi } from "vitest";
import { AFTER_SIGN_OUT_HREF, SIGN_OUT_PATH, signOut } from "./sign-out";

function deps(fetcher: (input: string, init?: RequestInit) => Promise<Response>) {
  return { fetcher: vi.fn(fetcher), clearCache: vi.fn(), clearPrivateAnswers: vi.fn(), leave: vi.fn() };
}

describe("signOut", () => {
  it("posts to Better Auth, clears the cache and private answers, then reloads the app", async () => {
    const d = deps(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(signOut(d)).resolves.toEqual({ ok: true });
    const [path, init] = d.fetcher.mock.calls[0] ?? [];
    expect(path).toBe(SIGN_OUT_PATH);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(d.clearCache).toHaveBeenCalledOnce();
    expect(d.clearPrivateAnswers).toHaveBeenCalledOnce();
    expect(d.leave).toHaveBeenCalledWith(AFTER_SIGN_OUT_HREF);
    expect(AFTER_SIGN_OUT_HREF).toBe("/app");
  });

  it("treats an already-ended session as signed out", async () => {
    const d = deps(async () => new Response("{}", { status: 401 }));
    await expect(signOut(d)).resolves.toEqual({ ok: true });
    expect(d.leave).toHaveBeenCalled();
  });

  it("still clears this device when the server cannot be reached, and says so", async () => {
    const d = deps(async () => {
      throw new TypeError("offline");
    });
    await expect(signOut(d)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(d.clearPrivateAnswers).toHaveBeenCalledOnce();
    expect(d.clearCache).toHaveBeenCalledOnce();
    expect(d.leave).not.toHaveBeenCalled();
  });

  it("does not claim success on a server error", async () => {
    const d = deps(async () => new Response("", { status: 503 }));
    await expect(signOut(d)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(d.leave).not.toHaveBeenCalled();
  });
});
