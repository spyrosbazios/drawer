/**
 * Which addresses the importer may connect to: public unicast only. Everything a server on the owner's
 * network could be reached by is refused: loopback, private and carrier-grade NAT ranges (Tailscale lives
 * in 100.64/10), link-local (cloud metadata at 169.254.169.254), multicast, reserved and documentation
 * ranges, and every IPv6 form that embeds or translates an IPv4 address (mapped, compatible, NAT64, 6to4,
 * Teredo), since those could lead back to one of the IPv4 ranges.
 *
 * Inputs are what the WHATWG URL parser and the resolver produce: the parser already turns `127.1`,
 * `2130706433`, `0177.0.0.1` and `0x7f.0.0.1` into `127.0.0.1` and keeps IPv6 in brackets.
 */
import { isIP } from "node:net";

/** [first address as a 32-bit number, prefix length] */
const IPV4_REFUSED: [number, number][] = [
  [ip4("0.0.0.0"), 8], // "this network"
  [ip4("10.0.0.0"), 8], // private
  [ip4("100.64.0.0"), 10], // carrier-grade NAT (Tailscale)
  [ip4("127.0.0.0"), 8], // loopback
  [ip4("169.254.0.0"), 16], // link-local, cloud metadata
  [ip4("172.16.0.0"), 12], // private
  [ip4("192.0.0.0"), 24], // IETF protocol assignments
  [ip4("192.0.2.0"), 24], // documentation
  [ip4("192.88.99.0"), 24], // 6to4 relay anycast
  [ip4("192.168.0.0"), 16], // private
  [ip4("198.18.0.0"), 15], // benchmarking
  [ip4("198.51.100.0"), 24], // documentation
  [ip4("203.0.113.0"), 24], // documentation
  [ip4("224.0.0.0"), 4], // multicast
  [ip4("240.0.0.0"), 4], // reserved, broadcast
];

function ip4(text: string): number {
  const parts = text.split(".").map(Number);
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

function inV4(value: number, [base, bits]: [number, number]): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === base;
}

/** Eight 16-bit groups of a valid IPv6 address (with or without an embedded IPv4 tail). */
function ip6Groups(text: string): number[] {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = ip4(last);
    tail.push(v4 >>> 16, v4 & 0xffff);
    // Keep a "::" that ends right before the IPv4 part; drop a single separating ":".
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const [head, rest] = s.includes("::") ? (s.split("::") as [string, string]) : [s, null];
  const parse = (part: string): number[] => (part === "" ? [] : part.split(":").filter((g) => g !== "").map((g) => parseInt(g, 16)));
  const left = parse(head);
  const right = rest === null ? [] : parse(rest);
  const missing = 8 - tail.length - left.length - right.length;
  return [...left, ...(rest === null ? [] : new Array<number>(Math.max(0, missing)).fill(0)), ...right, ...tail];
}

function isPublicV4(address: string): boolean {
  const value = ip4(address);
  return !IPV4_REFUSED.some((range) => inV4(value, range));
}

function isPublicV6(address: string): boolean {
  const g = ip6Groups(address);
  const [a = 0, b = 0] = g;
  // Global unicast is 2000::/3; everything else (::, ::1, mapped/compatible IPv4, NAT64 64:ff9b::/96 and
  // 64:ff9b:1::/48, discard 100::/64, ULA fc00::/7, link-local fe80::/10, multicast ff00::/8) is outside it.
  if ((a & 0xe000) !== 0x2000) return false;
  if (a === 0x2001 && b < 0x0200) return false; // 2001::/23 IETF protocol assignments, incl. Teredo 2001::/32
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2002) return false; // 6to4: embeds an IPv4 address
  if (a === 0x3fff && (b & 0xf000) === 0) return false; // 3fff::/20 documentation
  return true;
}

/** True only for a public unicast IP address. Anything that is not an IP address is false. */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) return isPublicV4(bare);
  if (family === 6) return isPublicV6(bare);
  return false;
}

/** What a URL's host names: an IP literal to check as it is, or a name to resolve and check. */
export type HostTarget = { kind: "ip"; address: string; family: 4 | 6 } | { kind: "name"; name: string } | { kind: "local" };

/** Classifies `url.hostname`. `localhost` and `*.localhost` are always local: resolvers answer them with loopback. */
export function hostTarget(url: URL): HostTarget {
  const host = url.hostname.toLowerCase();
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family === 4 || family === 6) return { kind: "ip", address: bare, family };
  const name = bare.replace(/\.$/, "");
  if (name === "" || name === "localhost" || name.endsWith(".localhost")) return { kind: "local" };
  return { kind: "name", name };
}
