/**
 * The Better Auth instance: email one-time codes only, D1 sessions through the Drizzle adapter,
 * a D1-backed rate limiter and session rows that never hold a raw IP or user agent.
 *
 * Instances are built lazily and cached per isolate (per env object, surface and mailer), because
 * Worker bindings arrive with each request but stay the same object within an isolate.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { getDb } from "@server/db/client";
import { uuidv7 } from "@server/db/columns";
import { authSchema } from "@server/db/schema";
import { AUTH_BASE_PATH, COOKIE_PREFIX, OTP, RATE_LIMITS, SESSION_COOKIE_NAME, SURFACES, originForSurface } from "./config";
import { mailerFromEnv, type AuthMailer } from "./mailer";
import { scrubSessionDevice } from "./privacy";
import { d1RateLimitStorage } from "./rate-limit";
import type { AuthBindings, AuthSurface } from "./types";

export interface AuthOptions {
  surface: AuthSurface;
  mailer: AuthMailer;
  /** Tests turn the limiter off to exercise flows quickly; production always keeps it on. */
  rateLimit?: boolean;
}

export function buildAuth(env: AuthBindings, options: AuthOptions) {
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not configured");
  const surface = SURFACES[options.surface];
  const origin = originForSurface(env.APP_ORIGIN, options.surface);

  return betterAuth({
    appName: "Novus",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    // Each surface trusts only itself, so the student app cannot drive the console and vice versa.
    trustedOrigins: [origin],
    database: drizzleAdapter(getDb(env.DB), { provider: "sqlite", usePlural: true, schema: { ...authSchema } }),
    // Emailed codes are the only sign-in method through Phase 2.
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: surface.sessionSeconds,
      updateAge: surface.refreshAfterSeconds ?? surface.sessionSeconds,
      disableSessionRefresh: surface.refreshAfterSeconds === null,
    },
    verification: { storeIdentifier: "hashed" },
    rateLimit: {
      enabled: options.rateLimit ?? true,
      // D1-backed (per-isolate memory would not limit anything on Workers), with hashed keys.
      storage: "database",
      customStorage: d1RateLimitStorage(env.DB, env.BETTER_AUTH_SECRET),
      window: RATE_LIMITS.default.window,
      max: RATE_LIMITS.default.max,
      customRules: { ...RATE_LIMITS.rules },
    },
    advanced: {
      useSecureCookies: false,
      cookiePrefix: COOKIE_PREFIX,
      cookies: { session_token: { name: SESSION_COOKIE_NAME } },
      defaultCookieAttributes: { secure: true, path: "/", httpOnly: true, sameSite: surface.sameSite },
      crossSubDomainCookies: { enabled: false },
      // Cloudflare sets cf-connecting-ip and overwrites any client-sent value.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"], ipv6Subnet: 48 },
      database: { generateId: () => uuidv7() },
    },
    databaseHooks: {
      session: {
        create: { before: async (session) => ({ data: scrubSessionDevice(session) }) },
        update: { before: async (session) => ({ data: scrubSessionDevice(session) }) },
      },
    },
    telemetry: { enabled: false },
    plugins: [
      emailOTP({
        otpLength: OTP.length,
        expiresIn: OTP.expiresInSeconds,
        allowedAttempts: OTP.allowedAttempts,
        storeOTP: OTP.storage,
        // Sign-up happens through the code too: verifying a code for a new address creates the
        // account (after the client's age screen, plan 9.x).
        disableSignUp: false,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in" && type !== "email-verification") return;
          await options.mailer.sendSignInCode({
            to: email,
            code: otp,
            expiresInMinutes: Math.round(OTP.expiresInSeconds / 60),
            purpose: type,
          });
        },
      }),
    ],
  });
}

export type NovusAuth = ReturnType<typeof buildAuth>;

const defaultMailers = new WeakMap<AuthBindings, AuthMailer>();
const instances = new WeakMap<AuthBindings, WeakMap<AuthMailer, Map<string, NovusAuth>>>();

/** The cached instance for this env, surface and mailer (the env's own mailer by default). */
export function getAuth(env: AuthBindings, surface: AuthSurface, mailer?: AuthMailer, rateLimit = true): NovusAuth {
  let chosen = mailer ?? defaultMailers.get(env);
  if (!chosen) {
    chosen = mailerFromEnv(env);
    defaultMailers.set(env, chosen);
  }
  let byMailer = instances.get(env);
  if (!byMailer) {
    byMailer = new WeakMap();
    instances.set(env, byMailer);
  }
  let bySurface = byMailer.get(chosen);
  if (!bySurface) {
    bySurface = new Map();
    byMailer.set(chosen, bySurface);
  }
  const key = `${surface}:${rateLimit ? "rl" : "norl"}`;
  let auth = bySurface.get(key);
  if (!auth) {
    auth = buildAuth(env, { surface, mailer: chosen, rateLimit });
    bySurface.set(key, auth);
  }
  return auth;
}
