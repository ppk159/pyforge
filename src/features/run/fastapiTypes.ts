/**
 * FastAPI Server: a Python configuration that runs an ASGI app through uvicorn.
 *
 * uvicorn takes its target positionally and only as a dotted module —
 * `uvicorn webapp.fastapi_app:app`, never a file path (`uvicorn app.py:app` fails with
 * ModuleNotFoundError). So the form asks for the module and the variable separately,
 * and an optional application directory puts a `src/` layout on the import path the way
 * uvicorn's own `--app-dir` does.
 *
 * It listens on behalf of a WSGI/ASGI server rather than running the module's
 * `__main__`, which is what the plain Python type does.
 */
import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution, RunConfigTypeField } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { commandName } from "./commandName";
import { pythonExtras, pythonPathDefaults, pythonPathFields, resolveInterpreter } from "./pythonTypes";

/**
 * A uvicorn target: `<module>:<variable>` or a bare `<module>`.
 *
 * The module part may be empty while the form is being filled in — `:app` — and is
 * recognised here so such a configuration opens in the form, where the missing module
 * shows as an error, instead of falling back to a raw command line.
 */
const TARGET = /^[A-Za-z_][\w.]*(:[\w.()]*)?$|^:[\w.()]*$/;

const interpreterField: RunConfigTypeField = {
  key: "interpreter",
  label: "Interpreter",
  control: "select",
  options: [
    { value: "", label: "Project interpreter", detail: "Settings › Python Interpreter, else the project venv" },
    { value: "python3", label: "python3", detail: "The interpreter on PATH" },
  ],
  loadOptions: async () => {
    const { detectSdks } = await import("@/features/settings/languages/api");
    const detected = await detectSdks("python").catch(() => []);
    return detected.map((sdk) => ({ value: String(sdk.path), label: sdk.name, detail: String(sdk.path) }));
  },
};

const moduleField: RunConfigTypeField = {
  key: "module",
  label: "Module",
  mono: true,
  required: true,
  placeholder: "e.g. webapp.fastapi_app",
  hint: "The importable module holding the app — a dotted name, not a file path",
  validate: (value) => {
    const module = value.trim();
    if (!module) return "A module is required: uvicorn runs `<module>:<application>`";
    if (/\.py$/.test(module)) return "Use the dotted module name (webapp.app), not a file path";
    if (/:/.test(module)) return "Put the application variable in its own field, not after a colon";
    return null;
  },
};

const appField: RunConfigTypeField = {
  key: "appVar",
  label: "Application",
  mono: true,
  placeholder: "app",
  hint: "The variable holding the ASGI app",
};

const appDirField: RunConfigTypeField = {
  key: "appDir",
  label: "Application directory",
  mono: true,
  browse: "directory",
  placeholder: "e.g. src",
  hint: "`--app-dir`: put this directory first on the import path, as a src/ layout needs",
};

const optionsField: RunConfigTypeField = {
  key: "parameters",
  label: "Additional options",
  control: "textarea",
  mono: true,
  placeholder: "e.g. --host 0.0.0.0 --port 8000 --reload",
};

/** uvicorn's target: `<module>:<variable>`. */
export function uvicornTarget(params: Readonly<Record<string, string>>): string {
  const module = params.module?.trim() ?? "";
  const app = params.appVar?.trim() || "app";
  return `${module}:${app}`;
}

export const fastapiType: RunConfigTypeContribution = {
  id: "fastapi",
  label: "FastAPI Server",
  icon: "fastapi",
  group: "Servers",
  description: "Run an ASGI application with uvicorn",
  defaults: { ...pythonPathDefaults },
  debugAdapter: "debugpy",
  fields: [interpreterField, moduleField, appField, appDirField, optionsField, ...pythonPathFields],
  commandLine: (p) => {
    const interpreter = p.interpreter?.trim() || "python3";
    const appDir = p.appDir?.trim();
    const options = parseArgs(p.parameters ?? "");
    // `--app-dir` is an option of uvicorn itself, so it precedes the target.
    return {
      command: interpreter,
      args: ["-m", "uvicorn", ...(appDir ? ["--app-dir", appDir] : []), uvicornTarget(p), ...options],
    };
  },
  paramsFrom: fastapiParams,
  extras: (params) => fastapiExtras(params),
  prepareLaunch: resolveInterpreter,
};

/** The `--app-dir` value of a uvicorn command line, and the arguments after it. */
function splitAppDir(args: readonly string[]): { appDir: string; rest: string[] } {
  const rest: string[] = [];
  let appDir = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--app-dir") {
      appDir = args[i + 1] ?? "";
      i++;
      continue;
    }
    if (arg.startsWith("--app-dir=")) {
      appDir = arg.slice("--app-dir=".length);
      continue;
    }
    rest.push(arg);
  }
  return { appDir, rest };
}

/** A `uvicorn <module>:<app> …` command line back into this form's fields; null otherwise. */
function fastapiParams(c: RunConfig): Record<string, string> | null {
  const name = commandName(c.command);
  const args = c.args;
  // `python -m uvicorn …` or the `uvicorn` console script.
  const isModule = args[0] === "-m" && args[1] === "uvicorn";
  const isScript = /^uvicorn(\.exe)?$/.test(name);
  if (!isModule && !isScript) return null;
  const { appDir, rest } = splitAppDir(args.slice(isModule ? 2 : 0));
  // The target is a module name, with or without `:variable`. It cannot be told from a
  // flag's value by "does not start with a dash" — `--port 8000` would match — so it is
  // recognised by its own shape.
  const at = rest.findIndex((a) => TARGET.test(a));
  if (at < 0) return null;
  const target = rest[at]!;
  const colon = target.lastIndexOf(":");
  const module = colon < 0 ? target : target.slice(0, colon);
  // An empty module is kept, not refused: it is a configuration with a missing field,
  // and the form is where that shows (with the reason). The target is still the target,
  // so what runs does not change.
  const appVar = (colon < 0 ? "" : target.slice(colon + 1)) || "app";
  return {
    interpreter: c.command,
    module,
    appVar,
    appDir,
    // The flags before the target apply to this configuration, so keep them too.
    parameters: formatArgs([...rest.slice(0, at), ...rest.slice(at + 1)]),
  };
}

/** The extras an ASGI run needs: the PYTHONPATH switches. */
export function fastapiExtras(
  params: Readonly<Record<string, string>>,
): Partial<RunConfig> & { env: Record<string, string> } {
  return { ...pythonExtras(params), env: {} };
}
