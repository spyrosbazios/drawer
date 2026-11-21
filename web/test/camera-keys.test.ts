import { describe, expect, test } from "bun:test";
import { cameraCommand, takesKeys } from "@/lib/camera-keys";
import type { KeyStroke } from "@/lib/camera-keys";

const stroke = (key: string, extra: Partial<KeyStroke> = {}): KeyStroke => ({ key, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: { tagName: "BODY", isContentEditable: false, closest: () => null }, ...extra });
const field = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable, closest: () => null });
const inside = (selector: string) => ({ tagName: "DIV", isContentEditable: false, closest: (s: string) => (s.includes(selector) ? {} : null) });

describe("camera keys", () => {
  test("0-6 pick a view and F fits, with no focus on the viewer", () => {
    expect(cameraCommand(stroke("0"))).toEqual({ kind: "view", view: "iso" });
    expect(cameraCommand(stroke("1"))).toEqual({ kind: "view", view: "front" });
    expect(cameraCommand(stroke("6"))).toEqual({ kind: "view", view: "bottom" });
    expect(cameraCommand(stroke("f"))).toEqual({ kind: "fit" });
    expect(cameraCommand(stroke("F"))).toEqual({ kind: "fit" });
    expect(cameraCommand(stroke("7"))).toBeNull();
    expect(cameraCommand(stroke("x"))).toBeNull();
  });

  test("typing never moves the camera: fields, contenteditable, select", () => {
    for (const target of [field("INPUT"), field("TEXTAREA"), field("SELECT"), field("DIV", true)]) expect(cameraCommand(stroke("1", { target }))).toBeNull();
  });

  test("an open menu, dialog or list keeps its keys", () => {
    for (const role of ["role=menu", "role=dialog", "role=listbox"]) expect(cameraCommand(stroke("3", { target: inside(role) }))).toBeNull();
    expect(takesKeys(inside("data-other"))).toBeFalse();
  });

  test("shortcuts of the sidebar and the browser are left alone", () => {
    expect(cameraCommand(stroke("b", { ctrlKey: true }))).toBeNull();
    expect(cameraCommand(stroke("f", { metaKey: true }))).toBeNull();
    expect(cameraCommand(stroke("1", { altKey: true }))).toBeNull();
    expect(cameraCommand(stroke("/"))).toBeNull();
    expect(cameraCommand(stroke("1", { defaultPrevented: true }))).toBeNull();
  });
});
