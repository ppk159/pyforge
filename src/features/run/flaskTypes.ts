/**
 * Flask Server (PyCharm's "Flask Server" configuration): a Python configuration whose
 * module is `flask` and which also exports the Flask environment variables.
 *
 * PyCharm's Flask type is the Python type plus `.env` files and a "Flask environment"
 * field; the target is always `flask run`, so the module is fixed and the parameters
 * carry what it runs (`--app src/webapp/flask_app`, `--host`, `--port`).
 */
import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution, RunConfigTypeField } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { commandName } from "./commandName";
import { pythonExtras, pythonPathFields, resolveInterpreter } from "./pythonTypes";

/** `FLASK_DEBUG=1` is how a Flask app is told to reload and show a debugger. */
export const FLASK_ENVIRONMENTS = ["development", "production"] as const;

/**
 * The `--app <target>` of a `flask run` command line: the module or file Flask starts.
 * `None` lets Flask find `app.py` / `wsgi.py` itself.
 */
function appTarget(args: readonly string[]): string {
  const at = args.indexOf("--app");
  if (at >= 0 && args[at + 1]) return args[at + 1]!;
  const inline = args.find((a) => a.startsWith("--app="));
  return inline ? inline.slice("--app=".length) : "";
}

/** The switch arguments of `flask run`, i.e. everything but `run` and `--app …`. */
function runOptions(args: readonly string[]): string[] {
  const out: string[] = [];
  let seenRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--app") {
      i++;
      continue;
    }
    if (arg.startsWith("--app=")) continue;
    // Only what follows `run` is an option of the run subcommand.
    if (!seenRun) {
      if (arg === "run") seenRun = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const appField: RunConfigTypeField = {
  key: "app",
  label: "Application",
  mono: true,
  placeholder: "e.g. src/webapp/flask_app.py or webapp:create_app()",
  hint: "The application Flask starts (`--app`); empty lets Flask find app.py or wsgi.py",
};

const environmentField: RunConfigTypeField = {
  key: "flaskEnv",
  label: "Flask environment",
  control: "select",
  options: [
    { value: "development", label: "development", detail: "Reloads on change and shows the debugger" },
    { value: "production", label: "production" },
  ],
  hint: "The FLASK_ENV the process starts with",
};

const envFilesField: RunConfigTypeField = {
  key: "envFiles",
  label: ".env files",
  mono: true,
  placeholder: "e.g. .env, local.env",
  hint: "Loaded before the environment variables below, in this order",
};

export const flaskType: RunConfigTypeContribution = {
  id: "flask",
  label: "Flask Server",
  icon: "file-python",
  group: "Servers",
  description: "Run a Flask application with flask run",
  defaults: { flaskEnv: "development" },
  debugAdapter: "debugpy",
  fields: [
    {
      key: "interpreter",
      label: "Interpreter",
      control: "select",
      options: [
        { value: "", label: "Project interpreter", detail: "Settings › Python Interpreter, else the project venv" },
      ],
      loadOptions: async () => {
        const { detectSdks } = await import("@/features/settings/languages/api");
        const detected = await detectSdks("python").catch(() => []);
        return detected.map((sdk) => ({ value: String(sdk.path), label: sdk.name, detail: String(sdk.path) }));
      },
    },
    appField,
    {
      key: "parameters",
      label: "Additional options",
      control: "textarea",
      mono: true,
      placeholder: "e.g. --host 0.0.0.0 --port 8866",
    },
    environmentField,
    envFilesField,
    ...pythonPathFields,
  ],
  commandLine: (p) => {
    const interpreter = p.interpreter?.trim() || "python3";
    const app = p.app?.trim();
    const options = parseArgs(p.parameters ?? "");
    // `--app` belongs to `flask` itself, not to `run`: it goes between the two, or
    // Flask rejects it with "No such option '--app'".
    return {
      command: interpreter,
      args: ["-m", "flask", ...(app ? ["--app", app] : []), "run", ...options],
    };
  },
  paramsFrom: flaskParams,
  prepareLaunch: resolveInterpreter,
};

/** A `flask run` command line back into this form's fields; null for anything else. */
function flaskParams(c: RunConfig): Record<string, string> | null {
  const name = commandName(c.command);
  const args = c.args;
  // `python -m flask run …`
  const isModule = args[0] === "-m" && args[1] === "flask" && args.includes("run");
  // A `flask` console script: `flask run …`
  const isScript = /^flask(\.exe)?$/.test(name) && args[0] === "run";
  if (!isModule && !isScript) return null;
  const rest = args.slice(isModule ? 2 : 0);
  return {
    interpreter: c.command,
    app: appTarget(rest),
    parameters: formatArgs(runOptions(rest)),
    flaskEnv: c.env.FLASK_ENV ?? "development",
    envFiles: (c.envFiles ?? []).join(", "),
  };
}

/**
 * The extras a Flask run needs: the environment variable Flask reads, and the `.env`
 * files. `FLASK_DEBUG` follows the environment, which is what PyCharm does.
 */
export function flaskExtras(
  params: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>> = {},
): Partial<RunConfig> & { env: Record<string, string> } {
  const environment = params.flaskEnv?.trim() || "development";
  const extraEnv: Record<string, string> = {
    ...env,
    FLASK_ENV: environment,
    ...(environment === "development" ? { FLASK_DEBUG: "1" } : {}),
  };
  const files = (params.envFiles ?? "")
    .split(/[,;]/)
    .map((f) => f.trim())
    .filter(Boolean);
  return { ...pythonExtras(params, files), env: extraEnv };
}
