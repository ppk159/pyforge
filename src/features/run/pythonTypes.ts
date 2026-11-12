/**
 * Python (PyCharm's "Python" configuration): run a script file or a module with an
 * interpreter, or debug either with debugpy.
 *
 * PyCharm splits the same idea over two types — "Python" for a script or module, and
 * "Flask Server" / "Django Server" for a framework that needs one more environment
 * variable. Both are built from these fields, so this module exports the pieces and
 * the framework types add to them (see `flaskTypes.ts`).
 */
import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution, RunConfigTypeField } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { commandName } from "./commandName";

/**
 * The interpreter.
 *
 * A configuration stores what it runs, so an absolute path is replaced by the project
 * interpreter it names: the setting is offered as "Project interpreter" and the SDK
 * list shows the detected ones with the names PyCharm shows (`Python 3.12 (.venv)`).
 */
const interpreterField: RunConfigTypeField = {
  key: "interpreter",
  label: "Interpreter",
  control: "select",
  // The stored value is a path; the label the backend gives it is what a reader needs.
  options: [
    { value: "", label: "Project interpreter", detail: "Settings › Python Interpreter, else the project venv" },
    { value: "python3", label: "python3", detail: "The interpreter on PATH" },
  ],
  loadOptions: async () => {
    const { detectSdks } = await import("@/features/settings/languages/api");
    const detected = await detectSdks("python").catch(() => []);
    return detected.map((sdk) => ({
      value: String(sdk.path),
      label: sdk.name,
      detail: String(sdk.path),
    }));
  },
  hint: "The interpreter to run with; the project's one when left at the default",
};

/** `script` runs a file, `module` runs `-m`, and `code` runs the text PyCharm pastes in. */
const modeField: RunConfigTypeField = {
  key: "mode",
  label: "Run",
  control: "select",
  options: [
    { value: "script", label: "Script path" },
    { value: "module", label: "Module name" },
  ],
};

const scriptField: RunConfigTypeField = {
  key: "script",
  label: "Script path",
  mono: true,
  required: true,
  browse: "file",
  visible: (p) => (p.mode ?? "script") === "script",
};

const moduleField: RunConfigTypeField = {
  key: "module",
  label: "Module name",
  mono: true,
  required: true,
  placeholder: "e.g. tasks.cli, uvicorn, flask",
  visible: (p) => p.mode === "module",
  hint: "Run with `-m`; the working directory is on the import path",
};

const parametersField: RunConfigTypeField = {
  key: "parameters",
  label: "Parameters",
  control: "textarea",
  mono: true,
  placeholder: "Script parameters, space separated; quote with ' or \"",
};

/**
 * The interpreter the project runs with when the configuration names none: the one
 * chosen in Settings › Python Interpreter, else the project's virtualenv. The backend
 * answers this (`sdk_python_effective`), so the answer matches what the settings page
 * and the status bar show.
 */
let resolved: Promise<string | null> | null = null;
export function projectInterpreter(): Promise<string | null> {
  resolved ??= import("@/features/settings/languages/api").then((api) => api.effectivePython()).catch(() => null);
  return resolved;
}

/** What runs a script or module: this configuration's interpreter, else the project's. */
export async function interpreterOf(params: Readonly<Record<string, string>>): Promise<string> {
  const own = params.interpreter?.trim();
  if (own) return own;
  // Windows has no usable `python3` on PATH: it is at most a Store alias that exits
  // silently, so the backend's answer (a real path) is what to run.
  return (await projectInterpreter()) || "python3";
}

/**
 * The command line of a Python run.
 *
 * A bare `python3` is not a usable path on Windows — there it is at most a Microsoft
 * Store alias that exits silently — so the frontend passes the interpreter the backend
 * resolved. Module mode adds `-m`, and the parameters go last in both.
 */
export function pythonCommandLine(
  params: Readonly<Record<string, string>>,
  extra: { module?: string; args?: string[] } = {},
): { command: string; args: string[] } {
  // The command line is built synchronously (the form previews it), so the interpreter
  // is written as configured and `prepareLaunch` resolves the project's one.
  const interpreter = params.interpreter?.trim() || "python3";
  const rest = parseArgs(params.parameters ?? "");
  // A framework type runs its own module (`flask`, `uvicorn`) in place of the file.
  const module = extra.module ?? ((params.mode ?? "script") === "module" ? params.module?.trim() : undefined);
  if (module !== undefined) {
    return { command: interpreter, args: ["-m", ...(module ? [module] : []), ...(extra.args ?? []), ...rest] };
  }
  const script = params.script?.trim() ?? "";
  return { command: interpreter, args: [script, ...rest] };
}

/**
 * Replaces a bare `python3` with the interpreter the project actually has.
 *
 * The backend knows (settings, then the project's venv) and Windows has no usable
 * `python3` at all, so this runs right before the process starts rather than when the
 * form previews the line.
 */
export async function resolveInterpreter(config: RunConfig): Promise<RunConfig> {
  const name = commandName(config.command);
  if (!/^python[\d.]*(\.exe)?$/i.test(name)) return config;
  const params = config.params ?? {};
  const own = params.interpreter?.trim();
  const interpreter = own || (await projectInterpreter());
  if (!interpreter || interpreter === config.command) return config;
  return { ...config, command: interpreter };
}

/** The params that reproduce `c`, when its command line is a plain script or module run. */
export function pythonParamsFrom(c: RunConfig): Record<string, string> | null {
  const name = commandName(c.command);
  const args = c.args;
  // `-m module` is a module run whatever the interpreter is called.
  if (args[0] === "-m" && args[1]) {
    return {
      mode: "module",
      interpreter: c.command,
      module: args[1],
      parameters: formatArgs(args.slice(2)),
    };
  }
  if (args.length && /^python[\d.]*(\.exe)?$/i.test(name)) {
    return {
      mode: "script",
      interpreter: c.command,
      script: args[0]!,
      parameters: formatArgs(args.slice(1)),
    };
  }
  return null;
}

/**
 * The two PYTHONPATH switches, shared with the framework types.
 *
 * They are stored as run extras rather than params (the process needs them), so they
 * are read and written through `params` keys of the same name and turned into extras by
 * `pythonExtras`.
 */
export const pythonPathFields: readonly RunConfigTypeField[] = [
  {
    key: "addContentRoots",
    label: "Add content roots to PYTHONPATH",
    control: "checkbox",
  },
  {
    key: "addSourceRoots",
    label: "Add source roots to PYTHONPATH",
    control: "checkbox",
  },
];

/**
 * Both switches start out on, which is what PyCharm does and what the backend already
 * assumed (`python_content_roots` defaults to true): an unchecked box and a true default
 * would disagree about what the process gets.
 */
export const pythonPathDefaults = { addContentRoots: "true", addSourceRoots: "true" } as const;

/**
 * The extras the PYTHONPATH switches become.
 *
 * A cleared checkbox deletes its param, so a missing key means "on" — the default the
 * backend already applies. Reading only a present key left the previous `true` behind
 * and made the box impossible to turn off.
 */
export function pythonExtras(params: Readonly<Record<string, string>>): Partial<RunConfig> {
  return {
    pythonContentRoots: (params.addContentRoots ?? pythonPathDefaults.addContentRoots) === "true",
    pythonSourceRoots: (params.addSourceRoots ?? pythonPathDefaults.addSourceRoots) === "true",
  };
}

export const pythonType: RunConfigTypeContribution = {
  id: "python",
  label: "Python",
  icon: "file-python",
  description: "Run a Python script or module",
  defaults: { mode: "script", ...pythonPathDefaults },
  debugAdapter: "debugpy",
  fields: [modeField, interpreterField, scriptField, moduleField, parametersField, ...pythonPathFields],
  // The interpreter is resolved by the backend, so building the line is async.
  commandLine: (p) => pythonCommandLine(p),
  paramsFrom: pythonParamsFrom,
  extras: pythonExtras,
  prepareLaunch: resolveInterpreter,
};
