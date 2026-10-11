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
// The Runner's `build` brackets itself with scripts/record-build-inputs.mjs:
// `--begin` removes any previous stamp and writes a pending record of the
// input digest before the first step reads anything; `--finish` recomputes
// the digest after the last check and writes the stamp under
// node_modules/.cache only if the inputs are still the ones the build started
// from, together with a manifest of every file the build left under dist. The
// server's prepare step (server/scripts/prepare-runner-vendor.mjs) reuses the
// build only when the stamp matches, every recorded output is still there at
// its recorded size, and the current input digest matches. Every other state
// rebuilds: a missing stamp, a changed input, a deleted or truncated output, a
// different platform, an edit that landed while the build was running. The
// slow direction is always the safe one.
//
// Inputs: every file under packages/paperclip-runner except its build outputs
// (dist, dist-browser, runner/target), node_modules and dot-directories (tool
// caches); every file under packages/paperclip-eval-kernel except dist and
// node_modules, because build:typescript builds that package first; every
// file under the root patches directory, because check:acpx-profiles hashes
// the acpx patch and build-verified-provider-entrypoints.mjs copies the pi-acp
// and brace-expansion patches into dist; and the root files the Runner's
// tsconfig and dependency graph read. The toolchain pins live inside the
// package (rust-toolchain.toml, runner/Cargo.lock), and the TypeScript version
// comes from pnpm-lock.yaml, so both are covered.
//
// Outputs: the server build vendors packages/paperclip-runner/dist wholesale
// (`cp -Rf ../packages/paperclip-runner/dist/. dist/vendor/paperclip-runner/`),
// so the stamp lists every file under dist with its size and reuse needs all
// of them present; a helper such as dist/cli/acpx-runtime-sidecar.cjs is
// opened by path at runtime, so a tree that lost it must not count as current.

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

export const BUILD_INPUTS_SCHEMA = "paperclip.runner-build-inputs.v2";

const RUNNER_PACKAGE_RELATIVE = "packages/paperclip-runner";
const EVAL_KERNEL_PACKAGE_RELATIVE = "packages/paperclip-eval-kernel";
const ROOT_INPUT_DIRECTORIES = ["patches"];
const ROOT_INPUT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
];
const OUTPUT_DIRECTORY_RELATIVE = "dist";
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

/** Written by `--begin`, consumed by `--finish`; its presence means a build is (or was) in progress. */
export function buildInputsPendingPath(packageRoot) {
  return path.join(packageRoot, "node_modules", ".cache", "paperclip-runner-build-inputs.pending.json");
}

/**
 * The outputs every consumer of the vendored Runner reads; a build that did
 * not produce them is not recorded, and a tree missing any of them is not
 * current whatever the stamp says.
 */
export function expectedBuildOutputs(packageRoot, platform = process.platform) {
  const executable = platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  return ["dist/index.js", "dist/live/index.js", "dist/testing.js", `dist/bin/${executable}`]
    .map((relative) => path.join(packageRoot, ...relative.split("/")));
}

function walk(root, relativeDirectory, { skipNames, skippedDirectories, skipDotDirectories }, out) {
  const absolute = path.join(root, ...relativeDirectory.split("/"));
  if (!existsSync(absolute)) return;
  const entries = readdirSync(absolute, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (skipDotDirectories && entry.name.startsWith(".")) continue;
      if (skipNames.has(entry.name)) continue;
      if (skippedDirectories.has(relative)) continue;
      walk(root, relative, { skipNames, skippedDirectories, skipDotDirectories }, out);
      continue;
    }
    // Files and symlinks; a symlinked directory is hashed as its link target
    // rather than followed, so a link into node_modules cannot pull a
    // dependency tree into the input set.
    out.push(relative);
  }
}

const INPUT_WALK = {
  skipNames: SKIPPED_DIRECTORY_NAMES,
  skippedDirectories: new Set(),
  skipDotDirectories: true,
};

/** Repo-relative POSIX paths of every build input, sorted. */
export function collectBuildInputFiles(repoRoot) {
  const files = [];
  walk(repoRoot, RUNNER_PACKAGE_RELATIVE, { ...INPUT_WALK, skippedDirectories: RUNNER_SKIPPED_DIRECTORIES }, files);
  walk(repoRoot, EVAL_KERNEL_PACKAGE_RELATIVE, INPUT_WALK, files);
  for (const directory of ROOT_INPUT_DIRECTORIES) walk(repoRoot, directory, INPUT_WALK, files);
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

/**
 * Every file the build left under dist (the tree the server vendors), as
 * package-relative POSIX paths with the size lstat reports, sorted. Nothing
 * under dist is skipped: the server copies all of it.
 */
export function collectBuildOutputFiles(packageRoot) {
  const files = [];
  walk(packageRoot, OUTPUT_DIRECTORY_RELATIVE, { skipNames: new Set(), skippedDirectories: new Set(), skipDotDirectories: false }, files);
  return files.sort().map((relative) => ({
    path: relative,
    size: lstatSync(path.join(packageRoot, ...relative.split("/"))).size,
  }));
}

/** The first recorded output that is gone or has changed size, or null when all are intact. */
export function findChangedBuildOutput(packageRoot, outputs) {
  for (const output of outputs) {
    const absolute = path.join(packageRoot, ...output.path.split("/"));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      return { ...output, state: "missing" };
    }
    if (stat.size !== output.size) return { ...output, state: "changed size", size: stat.size, recordedSize: output.size };
  }
  return null;
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
 * First step of the Runner's build: forgets the previous build (a build in
 * progress can no longer vouch for its outputs) and records the inputs the
 * build is about to read, so that `recordRunnerBuild` can tell whether they
 * changed while it ran.
 */
export function beginRunnerBuild({
  repoRoot,
  packageRoot,
  platform = process.platform,
  arch = process.arch,
  now = () => new Date(),
}) {
  removeBuildInputsStamp(buildInputsStampPath(packageRoot));
  const inputs = computeBuildInputsDigest(repoRoot);
  const pending = { ...inputs, platform, arch, startedAt: now().toISOString() };
  const pendingPath = buildInputsPendingPath(packageRoot);
  writeBuildInputsStamp(pendingPath, pending);
  return { ...pending, pendingPath };
}

/**
 * Last step of the Runner's build, after every step and check has passed:
 * records the inputs captured by `beginRunnerBuild` as the ones that produced
 * the outputs now under dist. An edit that landed while the build ran means
 * the outputs may not reflect the current inputs, so nothing is recorded and
 * the next consumer rebuilds. A build that did not begin with
 * `beginRunnerBuild`, or that left a required output missing, is an error.
 */
export function recordRunnerBuild({
  repoRoot,
  packageRoot,
  platform = process.platform,
  arch = process.arch,
  now = () => new Date(),
}) {
  const stampPath = buildInputsStampPath(packageRoot);
  const pendingPath = buildInputsPendingPath(packageRoot);
  const pending = readBuildInputsStamp(pendingPath);
  if (!pending || pending.schema !== BUILD_INPUTS_SCHEMA || typeof pending.digest !== "string") {
    removeBuildInputsStamp(stampPath);
    throw new Error(
      `no pending build inputs at ${pendingPath}: the Runner build must start with ` +
        "`node scripts/record-build-inputs.mjs --begin` before it can record its result",
    );
  }
  rmSync(pendingPath, { force: true });

  const missing = expectedBuildOutputs(packageRoot, platform).filter((file) => !existsSync(file));
  if (missing.length > 0) {
    removeBuildInputsStamp(stampPath);
    throw new Error(`the Runner build finished without producing ${path.relative(packageRoot, missing[0])}`);
  }

  const inputs = computeBuildInputsDigest(repoRoot);
  if (inputs.digest !== pending.digest) {
    removeBuildInputsStamp(stampPath);
    return {
      recorded: false,
      code: "inputs_changed_during_build",
      detail:
        `inputs changed while the build ran (digest ${pending.digest.slice(0, 12)} at start, ` +
        `${inputs.digest.slice(0, 12)} now); the next consumer rebuilds`,
      startedAt: pending.startedAt,
      stampPath,
    };
  }

  const outputs = collectBuildOutputFiles(packageRoot);
  const record = {
    ...inputs,
    platform,
    arch,
    startedAt: pending.startedAt,
    recordedAt: now().toISOString(),
    outputCount: outputs.length,
    outputs,
  };
  writeBuildInputsStamp(stampPath, record);
  return { recorded: true, code: "recorded", ...record, stampPath };
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
  if (stamp.schema !== BUILD_INPUTS_SCHEMA || !Array.isArray(stamp.outputs)) {
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
  const changedOutput = findChangedBuildOutput(packageRoot, stamp.outputs);
  if (changedOutput) {
    return {
      current: false,
      code: "outputs_changed",
      detail:
        `build output ${changedOutput.path} is ${changedOutput.state} since the build recorded at ` +
        `${stamp.recordedAt}; ${stamp.outputs.length} outputs checked`,
      stampPath,
    };
  }
  const inputs = computeBuildInputsDigest(repoRoot);
  if (inputs.digest !== stamp.digest) {
    return {
      current: false,
      code: "inputs_changed",
      detail: `inputs changed since the recorded build; ${inputs.fileCount} files checked`,
      stampPath,
      inputs,
    };
  }
  return {
    current: true,
    code: "inputs_unchanged",
    detail:
      `inputs unchanged since the build recorded at ${stamp.recordedAt}; ${inputs.fileCount} files ` +
      `and ${stamp.outputs.length} outputs checked`,
    stampPath,
    inputs,
    stamp,
  };
}
