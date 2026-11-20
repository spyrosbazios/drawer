import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("binds to loopback unless DRAWER_HOST says otherwise", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ DRAWER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  test("DRAWER_ALLOWED_HOSTS is a comma-separated list of bare host names", () => {
    expect(loadConfig({}).allowedHosts).toEqual([]);
    expect(loadConfig({ DRAWER_ALLOWED_HOSTS: " Drawer.LAN , workshop.tail1234.ts.net.,, " }).allowedHosts).toEqual(["drawer.lan", "workshop.tail1234.ts.net"]);
    for (const bad of ["http://drawer.lan", "drawer.lan:3050", "drawer lan", ".lan"]) {
      expect(() => loadConfig({ DRAWER_ALLOWED_HOSTS: bad })).toThrow("DRAWER_ALLOWED_HOSTS");
    }
  });
});
