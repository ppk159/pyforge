import { describe, expect, it } from "vitest";
import { joinPath, projectNameError } from "../NewProject";
import { exportedStorage } from "../projectActions";

describe("File › New Project…", () => {
  it("validates the folder name", () => {
    expect(projectNameError("demo")).toBeNull();
    expect(projectNameError("  ")).toBe("Enter a project name");
    expect(projectNameError("a/b")).not.toBeNull();
    expect(projectNameError("..")).not.toBeNull();
  });

  it("joins the location and name with the location's separator", () => {
    expect(joinPath("/Users/me/Projects", " demo ")).toBe("/Users/me/Projects/demo");
    expect(joinPath("/Users/me/", "demo")).toBe("/Users/me/demo");
    expect(joinPath("C:\\Users\\me", "demo")).toBe("C:\\Users\\me\\demo");
  });
});

describe("Manage IDE Settings › Export Settings…", () => {
  it("exports templates, macros, layouts and view options, not per-project state", () => {
    const data: Record<string, string> = {
      "pyforge.liveTemplates.v1": "[]",
      "pyforge.macros.v1": "{}",
      "pyforge.toolWindowLayouts.v1": "{}",
      "pyforge.projectTree.options": '{"singleClickOpen":true}',
      "pyforge.projectTree.expanded:/p": "[]",
      "pyforge.runAnything.history.v1:/p": "[]",
    };
    const keys = Object.keys(data);
    const storage = {
      length: keys.length,
      key: (i: number) => keys[i] ?? null,
      getItem: (k: string) => data[k] ?? null,
    };
    expect(Object.keys(exportedStorage(storage)).sort()).toEqual([
      "pyforge.liveTemplates.v1",
      "pyforge.macros.v1",
      "pyforge.projectTree.options",
      "pyforge.toolWindowLayouts.v1",
    ]);
  });
});
