/**
 * Secret hygiene for a PUBLIC repository: no local secret files committed, no credential-shaped
 * strings in any committed text, and `.dev.vars.example` holds placeholders only.
 */
import { lineOf, type Finding } from "./files";

const CHECK = "secrets";

/** Files that must never be committed, whatever they contain. */
const FORBIDDEN_FILES: readonly RegExp[] = [
  /(^|\/)\.dev\.vars$/,
  /(^|\/)\.dev\.vars\.(?!example$)[^/]+$/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /(^|\/)\.wrangler\//,
  /\.(pem|p12|pfx|key)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/,
  /(^|\/)service-account[^/]*\.json$/,
  /(^|\/)private[^/]*\.jwk(\.json)?$/,
];

/** Credential shapes. Kept specific to avoid noise; each one names the provider it detects. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}/g },
  { name: "Sentry DSN with key", re: /https:\/\/[0-9a-f]{32}@[a-z0-9.-]*sentry\.io\/\d+/g },
  { name: "Modal token", re: /\b(?:ak|as)-[A-Za-z0-9]{22,}\b/g },
  { name: "JWK private exponent", re: /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/g },
];

/** Lock files and vendored output hold integrity hashes that can look random but are not secrets. */
const SKIP_CONTENT: readonly RegExp[] = [/(^|\/)package-lock\.json$/, /(^|\/)uv\.lock$/, /\.min\.js$/, /(^|\/)dist\//];

export function checkForbiddenFiles(files: readonly string[]): Finding[] {
  return files
    .filter((f) => FORBIDDEN_FILES.some((re) => re.test(f)))
    .map((file) => ({ check: CHECK, file, message: "local secret or state file must not be committed" }));
}

export function scanTextForSecrets(file: string, text: string): Finding[] {
  if (SKIP_CONTENT.some((re) => re.test(file))) return [];
  const findings: Finding[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      findings.push({ check: CHECK, file, line: lineOf(text, m.index ?? 0), message: `looks like a ${name}` });
    }
  }
  return findings;
}

/** Keys in .dev.vars.example whose values are not secret and may hold a real default. */
const NON_SECRET_KEYS = new Set(["APP_ORIGIN", "ENVIRONMENT", "GEMINI_MODEL", "AI_DISABLED"]);
const PLACEHOLDER = /^(?:|your-[a-z0-9-]+|REPLACE[_A-Z0-9-]*|changeme|placeholder|example[a-z0-9-]*|\{\}|\{"[a-z0-9-]+":"your-[a-z0-9-]+"\})$/i;

/** Every secret in the example file must be an obvious placeholder. */
export function checkDevVarsExample(text: string, file = ".dev.vars.example"): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq < 0) {
      findings.push({ check: CHECK, file, line: i + 1, message: "expected KEY=value" });
      return;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (NON_SECRET_KEYS.has(key)) return;
    if (!PLACEHOLDER.test(value)) {
      findings.push({ check: CHECK, file, line: i + 1, message: `${key} must be a placeholder such as your-${key.toLowerCase().replace(/_/g, "-")}` });
    }
  });
  return findings;
}
