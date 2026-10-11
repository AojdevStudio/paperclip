// Records which inputs produced the Runner package's current build output, so
// a consumer that would otherwise rebuild the Runner can reuse the build when
// nothing it depends on has changed.
//
// server's `prepare:runner-vendor` runs the Runner's full `build`, because a
// standalone `pnpm --filter @paperclipai/server build` (the Dockerfile's path)
// must produce a current vendored Runner on its own. Inside `pnpm -r build`
// the same command has just built the Runner a few seconds earlier, and the
// rebuild cost 12-16s on the CI Build job's critical path (six master runs,
// 2026-10-11), the same again in every other `pnpm build`.
//
// The Runner's `build` ends by recording a digest of every build input into a
// stamp under node_modules/.cache (scripts/record-build-inputs.mjs). The
// server's prepare step (server/scripts/prepare-runner-vendor.mjs) recomputes
// the digest and reuses the build only when the stamp matches and the outputs
// exist. Every other state rebuilds: a missing stamp, a changed input, a
// deleted output, a different platform. The slow direction is always the safe
// one, and a stamp is only ever written after a build that passed every check.
//
// Inputs: every file under packages/paperclip-runner except its build outputs
// (dist, dist-browser, runner/target), node_modules and dot-directories (tool
// caches); every file under packages/paperclip-eval-kernel except dist and
// node_modules, because build:typescript builds that package first; and the
// root files the Runner's tsconfig and dependency graph read. The toolchain
// pins live inside the package (rust-toolchain.toml, runner/Cargo.lock), and
// the TypeScript version comes from pnpm-lock.yaml, so both are covered.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_INPUTS_SCHEMA = "paperclip.runner-build-inputs.v1";

const RUNNER_PACKAGE_RELATIVE = "packages/paperclip-runner";
const EVAL_KERNEL_PACKAGE_RELATIVE = "packages/paperclip-eval-kernel";
const ROOT_INPUT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
];
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "dist", "dist-browser"]);
const RUNNER_SKIPPED_DIRECTORIES = new Set([`${RUNNER_PACKAGE_RELATIVE}/runner/target`]);

export function runnerPackageRootFromScripts() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function repoRootFromRunnerPackage(packageRoot) {
  return path.resolve(packageRoot, "../..");
}

export function buildInputsStampPath(packageRoot) {
  return path.join(packageRoot, "node_modules", ".cache", "paperclip-runner-build-inputs.json");
}

/** The outputs a consumer of the vendored Runner reads; all must exist for a build to count as current. */
export function expectedBuildOutputs(packageRoot, platform = process.platform) {
  const executable = platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  return ["dist/index.js", "dist/live/index.js", "dist/testing.js", `dist/bin/${executable}`]
    .map((relative) => path.join(packageRoot, ...relative.split("/")));
}

function walk(repoRoot, relativeDirectory, skippedDirectories, out) {
  const absolute = path.join(repoRoot, ...relativeDirectory.split("/"));
  if (!existsSync(absolute)) return;
  const entries = readdirSync(absolute, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      if (skippedDirectories.has(relative)) continue;
      walk(repoRoot, relative, skippedDirectories, out);
      continue;
    }
    // Files and symlinks; a symlinked directory is hashed as its link target
    // rather than followed, so a link into node_modules cannot pull a
    // dependency tree into the input set.
    out.push(relative);
  }
}

/** Repo-relative POSIX paths of every build input, sorted. */
export function collectBuildInputFiles(repoRoot) {
  const files = [];
  walk(repoRoot, RUNNER_PACKAGE_RELATIVE, RUNNER_SKIPPED_DIRECTORIES, files);
  walk(repoRoot, EVAL_KERNEL_PACKAGE_RELATIVE, new Set(), files);
  for (const name of ROOT_INPUT_FILES) {
    if (existsSync(path.join(repoRoot, name))) files.push(name);
  }
  return files.sort();
}

export function computeBuildInputsDigest(repoRoot) {
  const files = collectBuildInputFiles(repoRoot);
  const hash = createHash("sha256");
  let byteCount = 0;
  for (const relative of files) {
    const absolute = path.join(repoRoot, ...relative.split("/"));
    hash.update(relative);
    hash.update("\0");
    if (lstatSync(absolute).isSymbolicLink()) {
      hash.update("link\0");
      hash.update(readlinkSync(absolute));
    } else {
      const content = readFileSync(absolute);
      byteCount += content.length;
      hash.update(`file ${content.length}\0`);
      hash.update(content);
    }
    hash.update("\0");
  }
  return {
    schema: BUILD_INPUTS_SCHEMA,
    digest: hash.digest("hex"),
    fileCount: files.length,
    byteCount,
  };
}

export function readBuildInputsStamp(stampPath) {
  try {
    const parsed = JSON.parse(readFileSync(stampPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBuildInputsStamp(stampPath, record) {
  mkdirSync(path.dirname(stampPath), { recursive: true });
  const staged = `${stampPath}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(staged, stampPath);
}

export function removeBuildInputsStamp(stampPath) {
  rmSync(stampPath, { force: true });
}

/**
 * Records the current inputs as the ones that produced the current outputs.
 * Call this only after a build that completed every step and check.
 */
export function recordRunnerBuild({
  repoRoot,
  packageRoot,
  platform = process.platform,
  arch = process.arch,
  now = () => new Date(),
}) {
  const inputs = computeBuildInputsDigest(repoRoot);
  const record = { ...inputs, platform, arch, recordedAt: now().toISOString() };
  const stampPath = buildInputsStampPath(packageRoot);
  writeBuildInputsStamp(stampPath, record);
  return { ...record, stampPath };
}

/**
 * Decides whether the Runner's outputs are current for the present inputs.
 * `code` is a stable slug for timing lines; `detail` is for humans.
 */
export function assessRunnerBuild({
  repoRoot,
  packageRoot,
  platform = process.platform,
  arch = process.arch,
}) {
  const stampPath = buildInputsStampPath(packageRoot);
  const stamp = readBuildInputsStamp(stampPath);
  if (!stamp) {
    return { current: false, code: "no_stamp", detail: `no build stamp at ${stampPath}`, stampPath };
  }
  if (stamp.schema !== BUILD_INPUTS_SCHEMA) {
    return {
      current: false,
      code: "schema_mismatch",
      detail: `stamp schema ${String(stamp.schema)} is not ${BUILD_INPUTS_SCHEMA}`,
      stampPath,
    };
  }
  if (stamp.platform !== platform || stamp.arch !== arch) {
    return {
      current: false,
      code: "platform_mismatch",
      detail: `stamp recorded on ${stamp.platform}/${stamp.arch}, this is ${platform}/${arch}`,
      stampPath,
    };
  }
  const missing = expectedBuildOutputs(packageRoot, platform).filter((file) => !existsSync(file));
  if (missing.length > 0) {
    return {
      current: false,
      code: "missing_output",
      detail: `missing build output ${path.relative(packageRoot, missing[0])}`,
      stampPath,
    };
  }
  const inputs = computeBuildInputsDigest(repoRoot);
  if (inputs.digest !== stamp.digest) {
    return {
      current: false,
      code: "inputs_changed",
      detail: `inputs changed since the recorded build (${inputs.fileCount} files checked)`,
      stampPath,
      inputs,
    };
  }
  return {
    current: true,
    code: "inputs_unchanged",
    detail: `inputs unchanged since the build recorded at ${stamp.recordedAt} (${inputs.fileCount} files checked)`,
    stampPath,
    inputs,
    stamp,
  };
}
