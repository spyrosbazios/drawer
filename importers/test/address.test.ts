import { describe, expect, test } from "bun:test";
import { hostTarget, isPublicAddress } from "../src/address";

/** What the importer does with a URL's host before any DNS: refused, an IP literal it allows, or a name. */
function verdict(url: string): "refused" | "allowed" | "resolve" {
  const target = hostTarget(new URL(url));
  if (target.kind === "local") return "refused";
  if (target.kind === "name") return "resolve";
  return isPublicAddress(target.address) ? "allowed" : "refused";
}

describe("URL hosts", () => {
  const table: [string, ReturnType<typeof verdict>][] = [
    // loopback in every spelling the URL parser accepts
    ["http://127.0.0.1/", "refused"],
    ["http://127.1/", "refused"],
    ["http://2130706433/", "refused"],
    ["http://0177.0.0.1/", "refused"],
    ["http://0x7f.0.0.1/", "refused"],
    ["http://0x7f000001/", "refused"],
    ["http://127.255.255.254:8080/", "refused"],
    ["http://[::1]/", "refused"],
    ["http://[0:0:0:0:0:0:0:1]/", "refused"],
    ["http://[::ffff:127.0.0.1]/", "refused"],
    ["http://[::ffff:7f00:1]/", "refused"],
    ["http://[::127.0.0.1]/", "refused"],
    ["http://localhost/", "refused"],
    ["http://LOCALHOST./", "refused"],
    ["http://localhost:3050/", "refused"],
    ["http://drawer.localhost/", "refused"],
    ["http://a.b.localhost./", "refused"],
    // the owner's networks and the cloud metadata service
    ["http://0.0.0.0/", "refused"],
    ["http://0/", "refused"],
    ["http://10.1.2.3/", "refused"],
    ["http://172.16.0.1/", "refused"],
    ["http://172.31.255.255/", "refused"],
    ["http://192.168.1.10/", "refused"],
    ["http://100.64.0.1/", "refused"],
    ["http://100.86.234.101/", "refused"],
    ["http://100.127.255.255/", "refused"],
    ["http://169.254.169.254/latest/meta-data/", "refused"],
    ["http://[fd7a:115c:a1e0::1]/", "refused"],
    ["http://[fc00::1]/", "refused"],
    ["http://[fe80::1]/", "refused"],
    ["http://[::ffff:192.168.1.1]/", "refused"],
    ["http://[::ffff:a9fe:a9fe]/", "refused"],
    ["http://[64:ff9b::a9fe:a9fe]/", "refused"],
    ["http://[64:ff9b:1::1]/", "refused"],
    ["http://[2002:7f00:1::]/", "refused"],
    ["http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", "refused"],
    // multicast, reserved, documentation, unspecified
    ["http://224.0.0.1/", "refused"],
    ["http://239.255.255.250/", "refused"],
    ["http://240.0.0.1/", "refused"],
    ["http://255.255.255.255/", "refused"],
    ["http://192.0.2.1/", "refused"],
    ["http://198.18.0.1/", "refused"],
    ["http://[::]/", "refused"],
    ["http://[ff02::1]/", "refused"],
    ["http://[2001:db8::1]/", "refused"],
    ["http://[100::1]/", "refused"],
    // public addresses, including the neighbours of refused ranges
    ["http://93.184.215.14/", "allowed"],
    ["http://8.8.8.8/", "allowed"],
    ["http://1.1.1.1/", "allowed"],
    ["http://100.63.255.255/", "allowed"],
    ["http://100.128.0.0/", "allowed"],
    ["http://172.15.255.255/", "allowed"],
    ["http://172.32.0.0/", "allowed"],
    ["http://169.253.255.255/", "allowed"],
    ["http://[2606:4700:4700::1111]/", "allowed"],
    ["http://[2a00:1450:4001::1]/", "allowed"],
    ["http://[2001:4860:4860::8888]/", "allowed"],
    // names are resolved, then every address is checked
    ["https://www.printables.com/model/1", "resolve"],
    ["https://evil.example./", "resolve"],
    ["http://localhost.evil.example/", "resolve"],
    ["http://127.0.0.1.nip.io/", "resolve"],
  ];

  for (const [url, expected] of table) {
    test(`${url} → ${expected}`, () => {
      expect(verdict(url)).toBe(expected);
    });
  }
});

describe("resolved addresses", () => {
  test("only public unicast passes; anything that is not an IP never does", () => {
    for (const a of ["127.0.0.1", "10.0.0.1", "::1", "::ffff:10.0.0.1", "fe80::1%eth0", "fd00::1", "100.100.100.100"]) expect(isPublicAddress(a)).toBe(false);
    for (const a of ["93.184.215.14", "2606:4700::6810:84e5"]) expect(isPublicAddress(a)).toBe(true);
    for (const a of ["", "localhost", "example.com", "1.2.3", "300.1.1.1"]) expect(isPublicAddress(a)).toBe(false);
  });
});
