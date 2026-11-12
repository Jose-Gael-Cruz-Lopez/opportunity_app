/**
 * Auth-owned tables for staff second factors. Better Auth's own tables (users, sessions,
 * accounts, verifications, rate_limits) live in server/db/schema.ts as `authSchema`.
 *
 * The tables are defined in server/db/schema.ts (so drizzle-kit
 * generates their migration) and re-exported here. `SECOND_FACTOR_DDL` below is the same SQL,
 * idempotent, for tests that build a database without the migrations.
 *
 * No cascading foreign keys (the schema rule): account purge deletes these rows explicitly. The
 * session proof has no foreign key to sessions, because Better Auth deletes sessions on sign-out
 * without knowing this table exists; an orphaned proof is swept at its expiry.
 */
import { sessionSecondFactors, staffSecondFactors } from "@server/db/schema";

export { sessionSecondFactors, staffSecondFactors };

export const secondFactorSchema = { staffSecondFactors, sessionSecondFactors } as const;

/** The DDL drizzle-kit should produce for the tables above (used by tests; copy into a migration). */
export const SECOND_FACTOR_DDL = `
CREATE TABLE IF NOT EXISTS staff_second_factors (
  user_id text PRIMARY KEY NOT NULL REFERENCES users(id),
  secret_enc text NOT NULL,
  confirmed_at integer,
  last_used_step integer,
  failed_count integer DEFAULT 0 NOT NULL,
  locked_until integer,
  recovery_code_hashes text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT staff_second_factors_codes_ck CHECK (json_valid(recovery_code_hashes) AND json_type(recovery_code_hashes) = 'array')
);
CREATE TABLE IF NOT EXISTS session_second_factors (
  session_id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  method text NOT NULL,
  verified_at integer NOT NULL,
  expires_at integer NOT NULL,
  CONSTRAINT session_second_factors_method_ck CHECK (method IN ('totp', 'recovery_code'))
);
CREATE INDEX IF NOT EXISTS session_second_factors_user_idx ON session_second_factors (user_id);
CREATE INDEX IF NOT EXISTS session_second_factors_expires_idx ON session_second_factors (expires_at);
`;
