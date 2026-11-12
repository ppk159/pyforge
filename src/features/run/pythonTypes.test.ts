import { afterEach, describe, expect, it, vi } from "vitest";

const effective = vi.fn(async (): Promise<string | null> => null);
vi.mock("@/features/settings/languages/api", () => ({
  detectSdks: async () => [
    {
      path: "C:/p/.venv/Scripts/python.exe",
      name: "Python 3.11 (.venv)",
      version: "3.11.9",
      source: "venv",
      home: "C:/p/.venv",
    },
    { path: "/usr/bin/python3.12", name: "Python 3.12", version: "3.12.0", source: "path", home: null },
  ],
  effectivePython: () => effective(),
}));

const { pythonType, pythonCommandLine, pythonParamsFrom, pythonExtras } = await import("./pythonTypes");
const { newConfigOfType, withParams } = await import("./types");

afterEach(() => {
  effective.mockReset();
  effective.mockImplementation(async () => null);
});

/** A fresh copy of the module-level promise cache, so a test's answer does not leak. */
async function interpreterWith(value: string | null) {
  effective.mockImplementation(async () => value);
  vi.resetModules();
  const mod = await import("./pythonTypes");
  return mod;
}

describe("the Python configuration", () => {
  it("runs a script with its parameters", () => {
    expect(pythonCommandLine({ mode: "script", script: "src/tasks/cli.py", parameters: "--overdue" })).toEqual({
      command: "python3",
      args: ["src/tasks/cli.py", "--overdue"],
    });
  });

  it("runs a module with -m", () => {
    expect(pythonCommandLine({ mode: "module", module: "tasks.cli", parameters: "-x" })).toEqual({
      command: "python3",
      args: ["-m", "tasks.cli", "-x"],
    });
  });

  it("keeps a configured interpreter", () => {
    const line = pythonCommandLine({ interpreter: "C:/p/.venv/Scripts/python.exe", script: "a.py" });
    expect(line.command).toBe("C:/p/.venv/Scripts/python.exe");
    expect(line.args).toEqual(["a.py"]);
  });

  it("quotes parameters the way a shell would", () => {
    expect(pythonCommandLine({ script: "a.py", parameters: '--name "two words"' }).args).toEqual([
      "a.py",
      "--name",
      "two words",
    ]);
  });

  it("is registered with a debug adapter and the mode switch", () => {
    expect(pythonType.id).toBe("python");
    expect(pythonType.debugAdapter).toBe("debugpy");
    const keys = pythonType.fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["mode", "interpreter", "script", "module", "parameters"]));
  });

  it("shows the script field only in script mode", () => {
    const script = pythonType.fields.find((f) => f.key === "script")!;
    const module = pythonType.fields.find((f) => f.key === "module")!;
    expect(script.visible!({ mode: "script" })).toBe(true);
    expect(script.visible!({ mode: "module" })).toBe(false);
    expect(module.visible!({ mode: "module" })).toBe(true);
    expect(module.visible!({})).toBe(false);
  });

  it("reads back a script run and a module run", () => {
    const script = pythonParamsFrom({
      id: "x",
      name: "x",
      kind: "python",
      command: "C:/p/.venv/Scripts/python.exe",
      args: ["src/tasks/cli.py", "--overdue"],
      cwd: null,
      env: {},
      detected: false,
      isTest: false,
      debugAdapter: "debugpy",
    });
    expect(script).toEqual({
      mode: "script",
      interpreter: "C:/p/.venv/Scripts/python.exe",
      script: "src/tasks/cli.py",
      parameters: "--overdue",
    });

    const mod = pythonParamsFrom({
      id: "y",
      name: "y",
      kind: "python",
      command: "python3",
      args: ["-m", "tasks.cli"],
      cwd: null,
      env: {},
      detected: false,
      isTest: false,
      debugAdapter: "debugpy",
    });
    expect(mod).toEqual({ mode: "module", interpreter: "python3", module: "tasks.cli", parameters: "" });
  });

  it("does not claim a command line it cannot reproduce", () => {
    expect(
      pythonParamsFrom({
        id: "z",
        name: "z",
        kind: "python",
        command: "pytest",
        args: ["tests"],
        cwd: null,
        env: {},
        detected: false,
        isTest: false,
        debugAdapter: null,
      }),
    ).toBeNull();
  });
});

describe("resolving the interpreter before a launch", () => {
  const base = {
    id: "x",
    name: "x",
    kind: "python",
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: "debugpy",
  };

  it("replaces a bare python3 with the project's interpreter", async () => {
    const mod = await interpreterWith("C:/p/.venv/Scripts/python.exe");
    const out = await mod.resolveInterpreter({ ...base, command: "python3", args: ["a.py"], params: {} });
    expect(out.command).toBe("C:/p/.venv/Scripts/python.exe");
  });

  it("keeps an interpreter the configuration names", async () => {
    effective.mockImplementation(async () => "C:/other/python.exe");
    vi.resetModules();
    const mod = await import("./pythonTypes");
    const out = await mod.resolveInterpreter({
      ...base,
      command: "python3",
      args: ["a.py"],
      params: { interpreter: "C:/mine/python.exe" },
    });
    expect(out.command).toBe("C:/mine/python.exe");
  });

  it("leaves another program alone", async () => {
    const mod = await interpreterWith("C:/p/.venv/Scripts/python.exe");
    const out = await mod.resolveInterpreter({ ...base, command: "pytest", args: [], params: {} });
    expect(out.command).toBe("pytest");
  });

  it("keeps python3 when nothing is known", async () => {
    const mod = await interpreterWith(null);
    const out = await mod.resolveInterpreter({ ...base, command: "python3", args: ["a.py"], params: {} });
    expect(out.command).toBe("python3");
  });
});

describe("the PYTHONPATH switches", () => {
  it("become run extras", () => {
    expect(pythonExtras({ addContentRoots: "false", addSourceRoots: "true" })).toEqual({
      pythonContentRoots: false,
      pythonSourceRoots: true,
    });
    // Nothing said means the defaults, which is what the backend applies anyway.
    expect(pythonExtras({})).toEqual({ pythonContentRoots: true, pythonSourceRoots: true });
  });

  it("start out on, as the backend's defaults do", () => {
    expect(pythonType.defaults).toMatchObject({ addContentRoots: "true", addSourceRoots: "true" });
  });

  it("reach the configuration when a field changes, not just the params", () => {
    // Both boxes off: the process must not get the project's roots on PYTHONPATH.
    // What the form passes once the second box is cleared: the key is gone from params.
    const config = withParams(newConfigOfType(pythonType, []), { addSourceRoots: "false" }, pythonType);
    expect(config.pythonContentRoots).toBe(true);
    expect(config.pythonSourceRoots).toBe(false);
  });
});
