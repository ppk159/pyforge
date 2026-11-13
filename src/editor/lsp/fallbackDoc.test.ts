import { describe, expect, it } from "vitest";
import { docstringAfter } from "./fallbackDoc";

const lines = (text: string) => text.split("\n");

describe("docstringAfter", () => {
  it("reads a triple-quoted docstring and dedents it", () => {
    const src = lines(`class Dao:
    def find(self) -> str:
        """
        查询工厂主数据
        第二行
        """
        return "x"`);
    expect(docstringAfter(src, 1, 4)).toBe("查询工厂主数据\n第二行");
  });

  it("reads a one-line triple-quoted docstring", () => {
    const src = lines(`def f():
    """Short."""
    pass`);
    expect(docstringAfter(src, 0, 0)).toBe("Short.");
  });

  it("skips a comment between the header and the docstring", () => {
    const src = lines(`def f():
    # explains nothing
    """The doc."""
    pass`);
    expect(docstringAfter(src, 0, 0)).toBe("The doc.");
  });

  it("returns null when the body starts with code", () => {
    const src = lines(`def f():
    x = 1
    return x`);
    expect(docstringAfter(src, 0, 0)).toBeNull();
  });

  it("stops at the end of the body instead of taking the next function's string", () => {
    // The classic false positive: every method in a class has a docstring, so a
    // definition without one must not borrow its neighbour's.
    const src = lines(`def a():
    pass

def b():
    """B's doc."""`);
    expect(docstringAfter(src, 0, 0)).toBeNull();
  });

  it("returns null for a literal that never closes", () => {
    const src = lines(`def f():
    """unterminated
    still going`);
    expect(docstringAfter(src, 0, 0)).toBeNull();
  });

  it("does not treat a lone quote on the header line as a docstring", () => {
    const src = lines(`def f(x="a"):
    return x`);
    expect(docstringAfter(src, 0, 0)).toBeNull();
  });

  it("unescapes the sequences a docstring actually contains", () => {
    const src = lines(`def f():
    """line\\nbreak"""
    pass`);
    expect(docstringAfter(src, 0, 0)).toBe("line\nbreak");
  });
});
