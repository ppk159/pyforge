/**
 * Settings › Languages & Frameworks › Go / Java / Node.js / PHP / Rust / TypeScript and
 * Build Tools › Maven: the toolchain each language's server and run configurations
 * use (applied by `ide-sdk` when language servers start and when run configurations load).
 */
import { LanguageServerTargetRows, LanguageServerTargetsPage } from "./LanguageServerTarget";
import { useRunTargets } from "@/platform/pluginRunTargets";
import { tx } from "@/platform/i18n";
import { useEffect, useId, useMemo, useState } from "react";
import { call, commands, type Sdk } from "@/platform/ipc";
import { IconButton, Input, type SelectOption, T } from "@/ui";
import { PHP_LANGUAGE_LEVELS } from "@/platform/languageSettings";
import { GlobListEditor, Row, Section, Select, Toggle } from "../components/Form";
import { choosePath } from "./api";
import { useSetting } from "../components/context";
import { SdkField, tildify, useDetected } from "./components";
import styles from "./Sdk.module.css";

function PathInput({
  k,
  label,
  placeholder,
  hint,
  title,
  file,
}: {
  k: string;
  label: string;
  placeholder: string;
  hint?: string;
  title: string;
  /** Browse for a file instead of a directory. */
  file?: boolean;
}) {
  const [value, set] = useSetting<string>(k);
  const id = useId();
  return (
    <Row label={label} htmlFor={id} hint={hint}>
      <span className={styles.pathRow}>
        <Input
          id={id}
          mono
          className={styles.pathInput}
          value={value}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value.trim())}
        />
        <IconButton
          icon="folder-open"
          size="small"
          title="Browse…"
          onClick={async () => {
            const p = await choosePath({ directory: !file, title, defaultPath: value || undefined });
            if (p) set(p);
          }}
        />
      </span>
    </Row>
  );
}

function SdkRow({
  k,
  label,
  hint,
  ...field
}: { k: string; label: string; hint?: string } & Omit<Parameters<typeof SdkField>[0], "value" | "onChange">) {
  const [value, set] = useSetting<string>(k);
  return (
    <Row label={label} hint={hint}>
      <SdkField {...field} value={value} onChange={set} />
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Node.js

function RunTargetRow({ language }: { language: "php" | "node" }) {
  const [target, setTarget] = useSetting<string>(`languages.${language}.runTarget`);
  const targets = useRunTargets();
  const options = [
    { value: "", label: "Default run target" },
    { value: "local", label: "Local machine" },
    ...targets.map((t) => ({ value: t.id, label: tx`Run in target ${t.name}` })),
  ];
  if (target && target !== "local" && !targets.some((t) => t.id === target))
    options.push({ value: target, label: tx`Run in target ${target}` });
  return (
    <Row label="Run in target">
      <Select value={target ?? ""} options={options} onChange={setTarget} aria-label="Run in target" />
    </Row>
  );
}

export function NodePage() {
  const [pm, setPm] = useSetting<string>("languages.node.packageManager");
  const { list } = useDetected("packageManager");
  const pmOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "Auto", detail: "from packageManager / lock file" },
      ...(["npm", "pnpm", "yarn", "bun"] as const).map((name) => {
        const found = list.find((s) => s.name === name);
        return {
          value: name,
          label: name,
          detail: found ? `${found.version ?? ""} ${tildify(found.path)}`.trim() : "not found",
        };
      }),
    ],
    [list],
  );
  return (
    <div className={styles.page}>
      <Section>
        <SdkRow
          k="languages.node.interpreter"
          label="Node interpreter"
          kind="node"
          emptyLabel="Default"
          emptyDetail="node on PATH"
          browseTitle="Select Node.js Interpreter"
          aria-label="Node interpreter"
          hint="Runs npm scripts and Node-based language servers (vtsls, eslint, pyright…)."
        />
        <RunTargetRow language="node" />
        <LanguageServerTargetsPage ids={["javascript", "javascriptreact", "typescript", "typescriptreact"]} />
        <Row label="Package manager" hint="Used by the npm run configurations detected from package.json scripts.">
          <Select value={pm} options={pmOptions} onChange={setPm} aria-label="Package manager" />
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PHP

const PHP_LEVEL_OPTIONS: SelectOption[] = PHP_LANGUAGE_LEVELS.map((level) =>
  level ? { value: level, label: level } : { value: "", label: "Auto", detail: "from composer.json" },
);

/** The `php` on `PATH` (what the Default interpreter runs), looked up while `enabled`. */
function usePathPhp(enabled: boolean): string | null {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    call(commands.sdkLocateTools(["php"], null))
      .then((r) => live && setPath(r.tools[0]?.path ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled]);
  return path;
}

/**
 * The Xdebug version `php` loads, `null` for none; `undefined` while it is checked or when the check
 * fails. Checked again when detection runs again (after installing Xdebug).
 */
function useXdebug(php: Sdk | undefined): string | null | undefined {
  const [found, setFound] = useState<{ php: Sdk; xdebug: string | null } | null>(null);
  useEffect(() => {
    if (!php) return;
    let live = true;
    call(commands.sdkPhpXdebug(php.path, null))
      .then((r) => live && setFound({ php, xdebug: r.xdebug }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [php]);
  return found && found.php === php ? found.xdebug : undefined;
}

export function PhpPage() {
  const [interpreter] = useSetting<string>("languages.php.interpreter");
  const [level, setLevel] = useSetting<string>("languages.php.languageLevel");
  const [includePaths, setIncludePaths] = useSetting<string[]>("languages.php.includePaths");
  const [stubs, setStubs] = useSetting<string[]>("languages.php.stubs");
  const { list } = useDetected("php");
  const pathPhp = usePathPhp(!interpreter);
  // Default runs the `php` on PATH: the list is newest first, so it isn't necessarily `list[0]`.
  const selected = list.find((s) => s.path === (interpreter || pathPhp));
  const xdebug = useXdebug(selected);
  return (
    <div className={styles.page}>
      <Section>
        <Row
          label="PHP language level"
          hint="The PHP version Intelephense checks the code against: newer syntax and functions are reported. Auto uses config.platform.php from composer.json, else the lowest version require.php allows."
        >
          <Select value={level} options={PHP_LEVEL_OPTIONS} onChange={setLevel} aria-label="PHP language level" />
        </Row>
        <Row
          label="Include paths"
          stacked
          hint="Folders outside the project whose classes and functions Intelephense indexes too, such as the platform a module extends. Absolute, or relative to the project."
        >
          <GlobListEditor
            value={includePaths ?? []}
            onChange={setIncludePaths}
            placeholder="/path/to/platform"
            emptyText="No include paths"
            itemLabel="Include path"
            aria-label="Include paths"
          />
        </Row>
        <Row
          label="Additional stubs"
          stacked
          hint="Intelephense stub sets loaded on top of its defaults, such as wordpress. Each ext-* in require or require-dev of composer.json adds its own."
        >
          <GlobListEditor
            value={stubs ?? []}
            onChange={setStubs}
            placeholder="Stub name, e.g. wordpress"
            emptyText="No additional stubs"
            itemLabel="Stub"
            aria-label="Additional stubs"
          />
        </Row>
      </Section>
      <Section title="PHPStan">
        <PathInput
          k="languages.php.phpstanConfig"
          label="Configuration file"
          placeholder="phpstan.neon, phpstan.neon.dist or phpstan.dist.neon"
          hint="The configuration vendor/bin/phpstan checks saved files with. Empty uses phpstan.neon, phpstan.neon.dist or phpstan.dist.neon in the project root. Absolute, or relative to the project."
          title="Select PHPStan Configuration File"
          file
        />
      </Section>
      <Section title="CLI Interpreter">
        <RunTargetRow language="php" />
        <LanguageServerTargetRows language="php" />
        <SdkRow
          k="languages.php.interpreter"
          label="PHP interpreter"
          kind="php"
          emptyLabel="Default"
          emptyDetail="php on PATH"
          browseTitle="Select PHP Interpreter"
          aria-label="PHP interpreter"
          hint="Runs PHP scripts, PHPUnit, Composer and artisan, and the PHP-based language servers (phpactor). Its folder is put first on PATH, so vendor/bin/phpunit and other #!/usr/bin/env php scripts use it too."
        />
        {selected?.version && <Row label="Version">{selected.version}</Row>}
        {xdebug !== undefined && <Row label="Xdebug">{xdebug ?? <T>Not installed</T>}</Row>}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ruby

export function RubyPage() {
  return (
    <div className={styles.page}>
      <Section>
        <SdkRow
          k="languages.ruby.interpreter"
          label="Ruby interpreter"
          kind="ruby"
          emptyLabel="Auto"
          emptyDetail=".ruby-version / mise / asdf, else ruby on PATH"
          browseTitle="Select Ruby Interpreter"
          aria-label="Ruby interpreter"
          hint="Runs the ruby, rake and rspec configurations and lists the standard library and gems under External Libraries. Installs from rbenv, rvm, chruby, mise and asdf are detected."
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rust

export function RustPage() {
  const [toolchain] = useSetting<string>("languages.rust.toolchain");
  const [checkOnSave, setCheckOnSave] = useSetting<boolean>("languages.rust.checkOnSave");
  const [checkCommand, setCheckCommand] = useSetting<string>("languages.rust.checkCommand");
  const [rustfmtArgs, setRustfmtArgs] = useSetting<string>("languages.rust.rustfmtArgs");
  const { list } = useDetected("rust");
  const selected = list.find((s) => s.path === toolchain);
  const argsId = useId();
  return (
    <div className={styles.page}>
      <Section title="Toolchain">
        <SdkRow
          k="languages.rust.toolchain"
          label="Toolchain location"
          kind="rust"
          emptyLabel="Default"
          emptyDetail="rustup default / PATH"
          directory
          browseTitle="Select Toolchain bin Directory"
          aria-label="Toolchain location"
          hint="cargo run configurations and rust-analyzer use this toolchain (PATH, RUSTUP_TOOLCHAIN)."
        />
        <PathInput
          k="languages.rust.stdlib"
          label="Standard library"
          placeholder={selected?.extra ? tildify(selected.extra) : "Detected from the toolchain"}
          title="Select Standard Library Sources"
          hint="Sources of std for navigation and completion (RUST_SRC_PATH)."
        />
      </Section>
      <Section title="External Linters">
        <Row label="External tool">
          <Select
            value={checkCommand}
            options={[
              { value: "check", label: "Cargo Check" },
              { value: "clippy", label: "Clippy" },
            ]}
            onChange={setCheckCommand}
            aria-label="External tool"
          />
        </Row>
        <Toggle
          label="Run external linter on save"
          checked={checkOnSave}
          onChange={setCheckOnSave}
          hint="rust-analyzer runs the tool after each save and reports its diagnostics."
        />
      </Section>
      <Section title="Rustfmt">
        <Row
          label="Additional arguments"
          htmlFor={argsId}
          hint="Passed to rustfmt when reformatting, e.g. --edition 2024"
        >
          <Input
            id={argsId}
            mono
            className={styles.pathInput}
            value={rustfmtArgs}
            onChange={(e) => setRustfmtArgs(e.target.value)}
          />
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Go

export function GoPage() {
  const { list } = useDetected("go");
  const defaultGopath = list.find((s) => s.extra)?.extra;
  return (
    <div className={styles.page}>
      <Section title="GOROOT">
        <SdkRow
          k="languages.go.goroot"
          label="GOROOT"
          kind="go"
          emptyLabel="Default"
          emptyDetail="go on PATH"
          directory
          browseTitle="Select GOROOT"
          aria-label="GOROOT"
          hint="Go SDK used by gopls and the go run / test configurations."
        />
      </Section>
      <Section title="GOPATH">
        <PathInput
          k="languages.go.gopath"
          label="Project GOPATH"
          placeholder={defaultGopath ? tildify(defaultGopath) : "go env GOPATH"}
          title="Select GOPATH"
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TypeScript

export function TypeScriptPage() {
  const [version, setVersion] = useSetting<string>("languages.typescript.version");
  const { list } = useDetected("typeScript");
  const workspace = list.find((s) => s.source === "workspace");
  const options = useMemo<SelectOption[]>(() => {
    const out: SelectOption[] = [
      { value: "bundled", label: "Bundled", detail: "the language server's own TypeScript" },
      {
        value: "workspace",
        label: workspace ? workspace.name : "node_modules/typescript",
        detail: workspace ? tildify(workspace.path) : "not installed in this project",
      },
    ];
    if (version && version !== "bundled" && version !== "workspace")
      out.push({ value: version, label: tildify(version), detail: "custom" });
    return out;
  }, [workspace, version]);
  return (
    <div className={styles.page}>
      <Section>
        <Row
          label="TypeScript"
          hint="Version used by vtsls / typescript-language-server (typescript.tsdk, tsserver.path)."
        >
          <span className={styles.pathRow}>
            <Select value={version} options={options} onChange={setVersion} aria-label="TypeScript version" />
            <IconButton
              icon="folder-open"
              size="small"
              title="Browse…"
              onClick={async () => {
                const p = await choosePath({ directory: true, title: "Select TypeScript lib Directory" });
                if (p) setVersion(p);
              }}
            />
          </span>
        </Row>
      </Section>
    </div>
  );
}
