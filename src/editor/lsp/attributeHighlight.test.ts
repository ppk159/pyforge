import { describe, expect, it } from "vitest";
import type { Range } from "@/bindings";
import { attributeHighlights, classBodyAt, declarationLineOf } from "./attributeHighlight";

const NL = String.fromCharCode(10);
const lines = (text: string) => text.split(NL);
const range = (line: number, col: number, len = 8): Range => ({
  start: { line, col },
  end: { line, col: col + len },
});
const occ = (line: number, col: number, len = 8, qualified = true) => ({
  range: range(line, col, len),
  qualified,
});

const SERVICE = [
  "from a import PlanDao",
  "",
  "class PlanService:",
  "    plan_dao: PlanDao",
  "    plan_step_dao: PlanDao",
  "",
  "    def get(self):",
  "        return self.plan_dao.get_plan_by_id(1)",
  "",
  "    def create(self):",
  "        plan_id = self.plan_dao.create_plan()",
  "        return plan_id",
  "",
  "class Other:",
  "    plan_dao: PlanDao",
  "    def x(self):",
  "        return self.plan_dao",
].join(NL);

describe("classBodyAt", () => {
  it("finds the class body a line belongs to", () => {
    expect(classBodyAt(lines(SERVICE), 7)).toEqual({ head: 2, end: 13 });
  });

  it("includes decorators above the class line", () => {
    const src = lines(["@egg", "class A:", "    x = 1", "", "y = 2"].join(NL));
    expect(classBodyAt(src, 2)).toEqual({ head: 0, end: 4 });
  });

  it("returns null outside any class", () => {
    // Line 0 is the module-level import, line 1 the blank line after it.
    expect(classBodyAt(lines(SERVICE), 0)).toBeNull();
    expect(classBodyAt(lines(SERVICE), 1)).toBeNull();
  });
});

describe("declarationLineOf", () => {
  it("finds a class-level annotation", () => {
    expect(declarationLineOf(lines(SERVICE), 2, 13, "plan_dao")).toBe(3);
  });

  it("finds a self. assignment", () => {
    const src = lines(["class A:", "    def __init__(self):", "        self.dao = 1"].join(NL));
    expect(declarationLineOf(src, 0, 3, "dao")).toBe(2);
  });

  it("is not fooled by a same-prefixed name", () => {
    const src = lines(["class A:", "    def f(self):", "        self.dao_helper = 1"].join(NL));
    expect(declarationLineOf(src, 0, 3, "dao")).toBe(-1);
  });

  it("does not treat a use as a declaration", () => {
    const src = lines(["class A:", "    def f(self):", "        return self.dao.get()"].join(NL));
    expect(declarationLineOf(src, 0, 3, "dao")).toBe(-1);
  });
});

describe("attributeHighlights", () => {
  it("marks the declaration as the write and the uses as text", () => {
    const items = attributeHighlights(lines(SERVICE), 7, "plan_dao", [
      occ(3, 4, 8, false), // the annotation
      occ(7, 19),
      occ(10, 23),
      occ(15, 4, 8, false), // Other's declaration — another class
      occ(16, 19), // Other's use
    ]);
    expect(items?.map((i) => [i.range.start.line, i.kind])).toEqual([
      [3, "write"],
      [7, "text"],
      [10, "text"],
    ]);
  });

  it("ignores attributes of another class", () => {
    // From inside `Other`, only `Other`'s own two occurrences are highlighted.
    const items = attributeHighlights(lines(SERVICE), 16, "plan_dao", [
      occ(3, 4, 8, false),
      occ(7, 19),
      occ(15, 4, 8, false),
      occ(16, 19),
    ]);
    expect(items?.map((i) => i.range.start.line)).toEqual([15, 16]);
  });

  it("returns null when the class never declares the attribute", () => {
    const items = attributeHighlights(lines(SERVICE), 7, "missing", [occ(7, 19, 7)]);
    expect(items).toBeNull();
  });

  it("returns null outside a class", () => {
    expect(attributeHighlights(lines(SERVICE), 0, "plan_dao", [occ(0, 5, 8, false)])).toBeNull();
  });
});
