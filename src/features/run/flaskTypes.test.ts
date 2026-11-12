import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/settings/languages/api", () => ({
  detectSdks: async () => [],
  effectivePython: async () => null,
}));

const { flaskType, flaskExtras } = await import("./flaskTypes");

const config = (over: Record<string, unknown>) =>
  ({
    id: "x",
    name: "x",
    kind: "flask",
    command: "python3",
    args: [],
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: "debugpy",
    ...over,
  }) as unknown as Parameters<NonNullable<typeof flaskType.paramsFrom>>[0];

describe("the Flask Server configuration", () => {
  it("runs flask run in the Servers group", () => {
    expect(flaskType.id).toBe("flask");
    expect(flaskType.label).toBe("Flask Server");
    expect(flaskType.group).toBe("Servers");
    expect(flaskType.debugAdapter).toBe("debugpy");
  });

  it("builds `flask run --app <app> <options>`", () => {
    expect(
      flaskType.commandLine!({
        interpreter: "C:/p/.venv/Scripts/python.exe",
        app: "src/webapp/flask_app.py",
        parameters: "--host 0.0.0.0 --port 8866",
        flaskEnv: "development",
      }),
    ).toEqual({
      command: "C:/p/.venv/Scripts/python.exe",
      // `--app` is a global option of `flask`: before `run`, or Flask rejects it.
      args: ["-m", "flask", "--app", "src/webapp/flask_app.py", "run", "--host", "0.0.0.0", "--port", "8866"],
    });
  });

  it("lets Flask find the app when the field is empty", () => {
    const line = flaskType.commandLine!({ app: "", parameters: "--port 5000" })!;
    expect(line.args).toEqual(["-m", "flask", "run", "--port", "5000"]);
  });

  it("reads a `python -m flask run` command line back", () => {
    const params = flaskType.paramsFrom!(
      config({
        args: ["-m", "flask", "run", "--app", "app.py", "--port", "8866"],
        env: { FLASK_ENV: "production" },
      }),
    );
    expect(params).toEqual({
      interpreter: "python3",
      app: "app.py",
      parameters: "--port 8866",
      flaskEnv: "production",
    });
  });

  it("reads a `flask run` console script back too", () => {
    const params = flaskType.paramsFrom!(config({ command: "/venv/bin/flask", args: ["run", "--app", "a.py"] }));
    expect(params).toMatchObject({ app: "a.py", parameters: "" });
  });

  it("does not claim a command line it cannot reproduce", () => {
    expect(flaskType.paramsFrom!(config({ command: "uvicorn", args: ["app:app"] }))).toBeNull();
    expect(flaskType.paramsFrom!(config({ args: ["src/app.py"] }))).toBeNull();
  });

  it("round-trips its own command line", () => {
    const params = { interpreter: "python3", app: "x.py", parameters: "--port 1", flaskEnv: "development" };
    const line = flaskType.commandLine!(params)!;
    const back = flaskType.paramsFrom!(config({ args: line.args }));
    expect(back).toMatchObject({ app: "x.py", parameters: "--port 1" });
  });

  it("exports the Flask environment and enables the reloader in development", () => {
    expect(flaskExtras({ flaskEnv: "development" })).toMatchObject({
      env: { FLASK_ENV: "development", FLASK_DEBUG: "1" },
    });
    // Production must not turn on the debugger.
    expect(flaskExtras({ flaskEnv: "production" })).toMatchObject({ env: { FLASK_ENV: "production" } });
    expect(flaskExtras({})).toMatchObject({ env: { FLASK_ENV: "development", FLASK_DEBUG: "1" } });
  });

  it("passes the PYTHONPATH switches on", () => {
    expect(flaskExtras({ addSourceRoots: "false" })).toMatchObject({ pythonSourceRoots: false });
  });

  it("drops the reloader when the environment leaves development", () => {
    // Switching development → production in the form kept FLASK_DEBUG=1, so the server
    // reloaded and showed the debugger in production.
    const from = flaskExtras({ flaskEnv: "development" }, { FLASK_ENV: "development", FLASK_DEBUG: "1" });
    expect(from.env).toMatchObject({ FLASK_DEBUG: "1" });
    const to = flaskExtras({ flaskEnv: "production" }, from.env);
    expect(to.env).toEqual({ FLASK_ENV: "production" });
    // A variable the user set themselves is theirs to keep.
    expect(flaskExtras({ flaskEnv: "production" }, { SECRET_KEY: "s" }).env).toMatchObject({ SECRET_KEY: "s" });
  });

  it("keeps environment variables the configuration already has", () => {
    expect(flaskExtras({ flaskEnv: "production" }, { SECRET_KEY: "s" }).env).toEqual({
      SECRET_KEY: "s",
      FLASK_ENV: "production",
    });
  });
});
