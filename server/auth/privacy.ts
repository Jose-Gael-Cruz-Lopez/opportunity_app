/**
 * What a session row may remember about the device that opened it (plan 9.10.5): an IPv4 /24 or
 * IPv6 /48 network instead of the address, and a coarse device class instead of the user agent.
 * Both are enough to show "signed in on a phone near X" and to spot a hijack, and neither
 * identifies a household or a browser build.
 */

export const DEVICE_CLASSES = ["phone", "tablet", "desktop", "bot", "unknown"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function truncateIpv4(ip: string): string | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const octets = m.slice(1, 4).map(Number);
  if (octets.some((o) => o > 255) || Number(m[4]) > 255) return null;
  return `${octets.join(".")}.0/24`;
}

/** Expands "::" so the first three hextets (the /48) can be read. */
function ipv6Hextets(ip: string): string[] | null {
  if (!/^[0-9a-f:]+$/i.test(ip)) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((h) => h.length === 0 || h.length > 4)) return null;
  return all.map((h) => h.toLowerCase().replace(/^0+(?=.)/, ""));
}

/**
 * Truncates an address to its /24 (IPv4) or /48 (IPv6) network. An IPv4-mapped IPv6 address is
 * treated as IPv4. Anything unparseable becomes null rather than being stored raw.
 */
export function truncateIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ip = raw.trim().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return truncateIpv4(mapped[1]);
  if (IPV4.test(ip)) return truncateIpv4(ip);
  const hextets = ipv6Hextets(ip);
  if (!hextets) return null;
  return `${hextets.slice(0, 3).join(":")}::/48`;
}

/** Already-truncated values pass through unchanged, so the hook is idempotent on updates. */
export function isTruncatedNetwork(value: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24$/.test(value) || /^[0-9a-f:]+::\/48$/.test(value);
}

/**
 * A coarse device class from a user agent. Order matters: tablets that also say "Mobile"
 * (some Android tablets) are rare enough that "phone" is an acceptable answer for them.
 */
export function deviceClass(userAgent: string | null | undefined): DeviceClass {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (/bot|crawler|spider|curl|wget|python-|httpx|headless/.test(ua)) return "bot";
  if (/ipad|tablet|kindle|silk|playbook/.test(ua) || (/android/.test(ua) && !/mobile/.test(ua))) return "tablet";
  if (/iphone|ipod|mobile|android|windows phone|blackberry|opera mini/.test(ua)) return "phone";
  if (/windows|macintosh|mac os x|linux|cros|x11/.test(ua)) return "desktop";
  return "unknown";
}

/** The fields a session hook rewrites before any session row is written. */
export function scrubSessionDevice<T extends { ipAddress?: string | null; userAgent?: string | null }>(session: T): T {
  const out = { ...session };
  if ("ipAddress" in session) {
    const ip = session.ipAddress;
    out.ipAddress = ip && isTruncatedNetwork(ip) ? ip : truncateIp(ip);
  }
  if ("userAgent" in session) {
    const ua = session.userAgent;
    out.userAgent = ua && (DEVICE_CLASSES as readonly string[]).includes(ua) ? ua : deviceClass(ua);
  }
  return out;
}
