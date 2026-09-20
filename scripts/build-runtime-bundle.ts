import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { VERSION } from "../src/version";

const root = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version?: string;
  packageManager?: string;
};
if (packageJson.version !== VERSION) throw new Error("package.json and runtime version are out of sync");
const packageManagerMatch = /^bun@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager ?? "");
if (!packageManagerMatch) throw new Error("package.json must pin an exact Bun packageManager version");
const expectedBunVersion = packageManagerMatch[1];
if (Bun.version !== expectedBunVersion) {
  throw new Error(`Runtime bundle requires Bun ${expectedBunVersion}, received ${Bun.version}`);
}

function embeddedBunExecutable(): string {
  const configured = process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN;
  if (!configured) return realpathSync(process.execPath);
  if (!isAbsolute(configured)) throw new Error("CODEX_CHATGPT_WEB_EMBEDDED_BUN must be an absolute path");
  const executable = realpathSync(configured);
  const version = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0) {
    throw new Error(`Embedded Bun validation failed: ${version.stderr.toString() || version.stdout.toString()}`);
  }
  const reported = version.stdout.toString().trim();
  if (reported !== expectedBunVersion) {
    throw new Error(`Embedded Bun must be ${expectedBunVersion}, received ${reported || "no version"}`);
  }
  return executable;
}
const output = resolve(process.argv[2] ?? join(root, "dist", "runtime"));
const appDir = join(output, "app");
const runtimeDir = join(output, "runtime");
const binDir = join(output, "bin");

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  const normalizedCandidate = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function materializeWindowsDirectoryJunctions(rootDirectory: string): void {
  const canonicalRoot = realpathSync(rootDirectory);
  let temporaryCounter = 0;

  const assertCopyTreeHasNoLinks = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) {
        const canonicalTarget = realpathSync(absolutePath);
        if (!pathIsWithin(canonicalRoot, canonicalTarget)) {
          throw new Error(`Nested runtime dependency link escapes the staged app: ${relative(rootDirectory, absolutePath)}`);
        }
        throw new Error(`Nested runtime dependency link cannot be safely materialized: ${relative(rootDirectory, absolutePath)}`);
      }
      if (metadata.isDirectory()) assertCopyTreeHasNoLinks(absolutePath);
    }
  };

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const linkMetadata = lstatSync(absolutePath);
      if (!linkMetadata.isSymbolicLink()) {
        if (linkMetadata.isDirectory()) visit(absolutePath);
        continue;
      }

      const canonicalTarget = realpathSync(absolutePath);
      if (!pathIsWithin(canonicalRoot, canonicalTarget)) {
        throw new Error(`Runtime dependency link escapes the staged app: ${relative(rootDirectory, absolutePath)}`);
      }
      if (pathIsWithin(canonicalTarget, absolutePath)) {
        throw new Error(`Runtime dependency link targets its own ancestor: ${relative(rootDirectory, absolutePath)}`);
      }

      const targetMetadata = statSync(absolutePath);
      if (!targetMetadata.isDirectory()) continue;
      assertCopyTreeHasNoLinks(canonicalTarget);
      const temporaryPath = `${absolutePath}.materializing-${process.pid}-${temporaryCounter++}`;
      try {
        cpSync(canonicalTarget, temporaryPath, {
          recursive: true,
          dereference: false,
          force: false,
          errorOnExist: true,
        });
      } catch (error) {
        rmSync(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      rmSync(absolutePath, { recursive: true, force: true });
      renameSync(temporaryPath, absolutePath);
      visit(absolutePath);
    }
  };

  visit(rootDirectory);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

const build = await Bun.build({
  entrypoints: [join(root, "src", "cli.ts")],
  target: "bun",
  minify: true,
  external: ["playwright-core"],
  packages: "external",
  outdir: appDir,
  naming: "cli.js",
});
if (!build.success) {
  throw new Error(`Runtime bundle failed: ${build.logs.map(log => log.message).join("; ")}`);
}

const browserHelperBuild = await Bun.build({
  entrypoints: [join(root, "src", "adapters", "chatgpt-web", "browser-helper-main.ts")],
  target: "node",
  format: "cjs",
  minify: true,
  external: ["playwright-core"],
  packages: "external",
  outdir: appDir,
  naming: "browser-helper.cjs",
});
if (!browserHelperBuild.success) {
  throw new Error(`Browser helper bundle failed: ${browserHelperBuild.logs.map(log => log.message).join("; ")}`);
}

copyFileSync(join(root, "package.json"), join(appDir, "package.json"));
copyFileSync(join(root, "bun.lock"), join(appDir, "bun.lock"));
const install = Bun.spawnSync([
  process.execPath,
  "install",
  "--production",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--linker=hoisted",
  "--backend=copyfile",
], {
  cwd: appDir,
  stdout: "pipe",
  stderr: "pipe",
});
if (install.exitCode !== 0) {
  throw new Error(`Runtime dependencies failed to install: ${install.stderr.toString() || install.stdout.toString()}`);
}
if (process.platform === "win32") materializeWindowsDirectoryJunctions(appDir);
const bunName = process.platform === "win32" ? "bun.exe" : "bun";
cpSync(embeddedBunExecutable(), join(runtimeDir, bunName));
if (process.platform !== "win32") chmodSync(join(runtimeDir, bunName), 0o755);

const launcherName = process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web";
const launcher = process.platform === "win32" ? `@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0.."
set "CODEX_CHATGPT_WEB_LAUNCHER=%~f0"
"%ROOT%\\runtime\\bun.exe" "%ROOT%\\app\\cli.js" %*
` : `#!/bin/sh
set -eu
invoked="$0"
case "$invoked" in
  /*) ;;
  *) invoked="$(command -v -- "$invoked")" ;;
esac
script="$invoked"
while [ -L "$script" ]; do
  target="$(readlink "$script")"
  case "$target" in
    /*) script="$target" ;;
    *) script="$(dirname "$script")/$target" ;;
  esac
done
bin_dir="$(CDPATH= cd -- "$(dirname "$script")" && pwd -P)"
root="$(CDPATH= cd -- "$bin_dir/.." && pwd -P)"
export CODEX_CHATGPT_WEB_LAUNCHER="$invoked"
exec "$root/runtime/bun" "$root/app/cli.js" "$@"
`;
writeFileSync(join(binDir, launcherName), launcher, process.platform === "win32" ? undefined : { mode: 0o755 });
if (process.platform !== "win32") chmodSync(join(binDir, launcherName), 0o755);

const notices = Bun.spawnSync([
  process.execPath,
  "run",
  join(root, "scripts", "generate-third-party-notices.ts"),
  join(output, "THIRD_PARTY_NOTICES.txt"),
  "--include-launcher",
], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
if (notices.exitCode !== 0) {
  throw new Error(`Third-party notices failed: ${notices.stderr.toString() || notices.stdout.toString()}`);
}
copyFileSync(join(root, "LICENSE"), join(output, "LICENSE"));
cpSync(join(root, "LICENSES"), join(output, "LICENSES"), { recursive: true });

interface RuntimeManifestFile {
  path: string;
  size: number;
  sha256: string;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runtimeManifestFiles(): RuntimeManifestFile[] {
  const canonicalRoot = realpathSync(output);
  const files: RuntimeManifestFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(output, absolutePath).split(sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const metadata = statSync(absolutePath);
      if (!metadata.isFile()) throw new Error(`Unsupported runtime bundle entry: ${relativePath}`);
      if (lstatSync(absolutePath).isSymbolicLink()) {
        const target = realpathSync(absolutePath);
        if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`)) {
          throw new Error(`Runtime bundle symlink escapes the bundle: ${relativePath}`);
        }
      }
      files.push({
        path: relativePath,
        size: metadata.size,
        sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
      });
    }
  };
  visit(output);
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

function bundleIdFor(files: RuntimeManifestFile[]): string {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

const playwrightPackage = join(appDir, "node_modules", "playwright-core", "package.json");
const files = runtimeManifestFiles();
writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
  schemaVersion: 2,
  appVersion: VERSION,
  bundleId: bundleIdFor(files),
  bunVersion: Bun.version,
  platform: process.platform,
  arch: process.arch,
  launcher: `bin/${launcherName}`,
  entrypoint: "app/cli.js",
  playwright: JSON.parse(readFileSync(playwrightPackage, "utf8")).version,
  files,
}, null, 2)}\n`);

process.stdout.write(`${output}\n`);
