/**
 * GitHub Actions hygiene: third-party actions pinned to a full commit SHA, no
 * `pull_request_target` (it runs fork code with a write token), explicit least-privilege
 * `permissions`, and no `secrets.` references (CI runs without secrets).
 */
import { lineOf, type Finding } from "./files";

const CHECK = "workflows";

export function checkWorkflow(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const at = (index: number, message: string): void => {
    findings.push({ check: CHECK, file, line: lineOf(text, index), message });
  };

  for (const m of text.matchAll(/^\s*-?\s*uses:\s*["']?([^\s"'#]+)/gm)) {
    const ref = m[1] ?? "";
    if (ref.startsWith("./")) continue;
    if (ref.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref)) at(m.index ?? 0, `${ref} must be pinned by digest`);
      continue;
    }
    if (!/@[0-9a-f]{40}$/.test(ref)) at(m.index ?? 0, `${ref} must be pinned to a full commit SHA`);
  }
  for (const m of text.matchAll(/pull_request_target/g)) at(m.index ?? 0, "pull_request_target is banned");
  for (const m of text.matchAll(/\$\{\{\s*secrets\./g)) at(m.index ?? 0, "CI holds no secrets; do not reference secrets.*");
  if (!/^permissions:/m.test(text)) at(0, "declare top-level permissions (least privilege)");
  return findings;
}
