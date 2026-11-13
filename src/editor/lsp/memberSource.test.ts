import { describe, expect, it } from "vitest";
import type { OutlineItem } from "@/platform/ipc";
import { enclosingClassName, memberReceiver, membersFor, toCompletionResult } from "./memberSource";

const node = (name: string, kind: string, children: OutlineItem[] = []): OutlineItem => ({
  name,
  kind: kind as OutlineItem["kind"],
  detail: null,
  range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
  selection_range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
  children,
});

const NL = String.fromCharCode(10);

describe("enclosingClassName", () => {
  const src = ["class PlanService:", "    def get(self):", "        self.", "", "def top():", "    pass"].join(NL);

  it("finds the class a self. belongs to", () => {
    expect(enclosingClassName(src, src.indexOf("self.") + 8, "python")).toBe("PlanService");
  });

  it("returns null at module level", () => {
    expect(enclosingClassName("x = 1" + NL + "y = 2" + NL, 12, "python")).toBeNull();
  });

  it("returns null for a def at module level, after a class ended", () => {
    const at = src.indexOf("pass") + 2;
    expect(enclosingClassName(src, at, "python")).toBeNull();
  });

  it("is Python-only", () => {
    expect(enclosingClassName(src, src.indexOf("self.") + 8, "typescript")).toBeNull();
  });
});

describe("membersFor", () => {
  const never = async () => null;

  it("lists an imported module's names", async () => {
    const module = [node("plan_service", "variable"), node("helper", "function")];
    const members = await membersFor(
      { container: null, modules: ["svc/plan_service.py"] },
      { classMembers: never, fileOfModule: async () => module },
    );
    expect(members?.map((m) => m.name)).toEqual(["plan_service", "helper"]);
  });

  it("falls back to the class a receiver was assigned", async () => {
    const members = await membersFor(
      { container: "FactoryDao", modules: [] },
      { classMembers: async (n) => [{ name: `from_${n}`, kind: "method", owner: n }], fileOfModule: never },
    );
    expect(members?.map((m) => m.name)).toEqual(["from_FactoryDao"]);
  });

  it("offers nothing when the file proves neither", async () => {
    expect(await membersFor({ container: null, modules: [] }, { classMembers: never, fileOfModule: never })).toBeNull();
  });

  it("does not guess when an imported module cannot be read", async () => {
    expect(
      await membersFor(
        { container: null, modules: ["missing.py"] },
        { classMembers: never, fileOfModule: async () => null },
      ),
    ).toBeNull();
  });
});

describe("toCompletionResult", () => {
  const members = [
    { name: "get_plan_detail", kind: "method", owner: "PlanService" },
    { name: "update_plan", kind: "method", owner: "PlanService" },
    { name: "plan_dao", kind: "variable", owner: "PlanService" },
  ];

  it("filters by what is already typed", () => {
    const r = toCompletionResult(members, 10, "up");
    expect(r?.from).toBe(10);
    expect(r?.options.map((o) => o.label)).toEqual(["update_plan"]);
  });

  it("shows the owning class as the detail", () => {
    expect(toCompletionResult(members, 0, "")?.options.every((o) => o.detail === "PlanService")).toBe(true);
  });

  it("returns null rather than an empty list", () => {
    expect(toCompletionResult(members, 0, "zzz")).toBeNull();
  });
});

describe("memberReceiver", () => {
  it("reads the receiver and the partial member", () => {
    const doc = "x = plan_service.get_p";
    const m = memberReceiver({ state: { sliceDoc: () => doc }, pos: doc.length } as never);
    expect(m).toEqual({ receiver: "plan_service", from: doc.length - "get_p".length, typed: "get_p" });
  });

  it("returns null when there is no dot before the caret", () => {
    expect(memberReceiver({ state: { sliceDoc: () => "value" }, pos: 5 } as never)).toBeNull();
  });
});
