import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/settings/languages/api", () => ({
  detectSdks: async () => [],
  effectivePython: async () => null,
}));

const { fastapiType, uvicornTarget, fastapiExtras } = await import("./fastapiTypes");

type Params = Parameters<NonNullable<typeof fastapiType.paramsFrom>>[0];

const config = (over: Record<string, unknown>) =>
  ({
    id: "x",
    name: "x",
    kind: "fastapi",
    command: "python3",
    args: [],
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: "debugpy",
    ...over,
  }) as unknown as Params;

describe("the FastAPI Server configuration", () => {
  it("lives in the Servers group and debugs with debugpy", () => {
    expect(fastapiType.id).toBe("fastapi");
    expect(fastapiType.label).toBe("FastAPI Server");
    expect(fastapiType.group).toBe("Servers");
    expect(fastapiType.debugAdapter).toBe("debugpy");
  });

  it("builds `uvicorn <module>:<app>` with the options last", () => {
    expect(
      fastapiType.commandLine!({
        interpreter: "C:/p/.venv/Scripts/python.exe",
        module: "webapp.fastapi_app",
        appVar: "app",
        parameters: "--host 0.0.0.0 --port 8000",
      }),
    ).toEqual({
      command: "C:/p/.venv/Scripts/python.exe",
      args: ["-m", "uvicorn", "webapp.fastapi_app:app", "--host", "0.0.0.0", "--port", "8000"],
    });
  });

  it("puts the application directory before the target, where uvicorn wants it", () => {
    const line = fastapiType.commandLine!({ module: "webapp.fastapi_app", appVar: "app", appDir: "src" })!;
    expect(line.args).toEqual(["-m", "uvicorn", "--app-dir", "src", "webapp.fastapi_app:app"]);
  });

  it("defaults the application variable to app", () => {
    expect(uvicornTarget({ module: "webapp.api" })).toBe("webapp.api:app");
    expect(fastapiType.commandLine!({ module: "webapp.api" })!.args).toEqual(["-m", "uvicorn", "webapp.api:app"]);
  });

  it("names a non-default application variable", () => {
    expect(uvicornTarget({ module: "webapp.api", appVar: "create_app()" })).toBe("webapp.api:create_app()");
  });

  it("reads a `python -m uvicorn` command line back", () => {
    const params = fastapiType.paramsFrom!(
      config({ args: ["-m", "uvicorn", "--app-dir", "src", "webapp.fastapi_app:app", "--port", "8000"] }),
    );
    expect(params).toEqual({
      interpreter: "python3",
      module: "webapp.fastapi_app",
      appVar: "app",
      appDir: "src",
      parameters: "--port 8000",
      envFiles: "",
    });
  });

  it("reads a `uvicorn` console script back too", () => {
    const params = fastapiType.paramsFrom!(config({ command: "/venv/bin/uvicorn", args: ["main:app", "--reload"] }));
    expect(params).toMatchObject({ module: "main", appVar: "app", appDir: "", parameters: "--reload" });
  });

  it("keeps a flag written before the target", () => {
    const params = fastapiType.paramsFrom!(config({ args: ["-m", "uvicorn", "--reload", "main:app"] }));
    expect(params).toMatchObject({ module: "main", parameters: "--reload" });
  });

  it("round-trips its own command line", () => {
    const params = {
      interpreter: "python3",
      module: "webapp.api",
      appVar: "api",
      appDir: "src",
      parameters: "--port 9",
    };
    const line = fastapiType.commandLine!(params)!;
    expect(fastapiType.paramsFrom!(config({ args: line.args }))).toMatchObject({
      module: "webapp.api",
      appVar: "api",
      appDir: "src",
      parameters: "--port 9",
    });
  });

  it("does not claim a command line it cannot reproduce", () => {
    expect(fastapiType.paramsFrom!(config({ command: "flask", args: ["run"] }))).toBeNull();
    // A uvicorn run with no target at all.
    expect(fastapiType.paramsFrom!(config({ args: ["-m", "uvicorn", "--port", "8000"] }))).toBeNull();
  });

  it("rejects a file path where a module name belongs", () => {
    const field = fastapiType.fields.find((f) => f.key === "module")!;
    expect(field.validate!("src/webapp/fastapi_app.py", {})).toMatch(/dotted module name/);
    expect(field.validate!("webapp.fastapi_app", {})).toBeNull();
  });

  it("passes .env files and the PYTHONPATH switches on", () => {
    expect(fastapiExtras({ envFiles: ".env", addSourceRoots: "false" })).toMatchObject({
      envFiles: [".env"],
      pythonSourceRoots: false,
    });
    // uvicorn needs no environment variables of its own.
    expect(fastapiExtras({}).env).toEqual({});
  });
});
