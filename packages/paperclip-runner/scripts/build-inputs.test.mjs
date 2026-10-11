import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  BUILD_INPUTS_SCHEMA,
  assessRunnerBuild,
  buildInputsStampPath,
  collectBuildInputFiles,
  computeBuildInputsDigest,
  expectedBuildOutputs,
  readBuildInputsStamp,
  recordRunnerBuild,
} from "./build-inputs.mjs";

const execFileAsync = promisify(execFile);
const recordScript = fileURLToPath(new URL("./record-build-inputs.mjs", import.meta.url));

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

/** A throwaway repo with one Runner source file, one Rust source, built outputs, and the usual noise. */
async function makeRepo() {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "runner-build-inputs-"));
  await writeTree(repoRoot, {
    "package.json": "{}\n",
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "tsconfig.base.json": "{}\n",
    "packages/paperclip-runner/package.json": '{"name":"@paperclipai/paperclip-runner"}\n',
    "packages/paperclip-runner/src/index.ts": "export const one = 1;\n",
    "packages/paperclip-runner/runner/src/main.rs": "fn main() {}\n",
    "packages/paperclip-runner/runner/target/release/paperclip-runnerd": "binary\n",
    "packages/paperclip-runner/dist/index.js": "export const one = 1;\n",
    "packages/paperclip-runner/dist/live/index.js": "export {};\n",
    "packages/paperclip-runner/dist/testing.js": "export {};\n",
    "packages/paperclip-runner/dist/bin/paperclip-runnerd": "binary\n",
    "packages/paperclip-runner/dist-browser/index.js": "browser\n",
    "packages/paperclip-runner/node_modules/dep/index.js": "dep\n",
    "packages/paperclip-runner/.vite/cache.json": "{}\n",
    "packages/paperclip-eval-kernel/src/index.ts": "export const kernel = 1;\n",
    "packages/paperclip-eval-kernel/dist/index.js": "export const kernel = 1;\n",
  });
  const packageRoot = path.join(repoRoot, "packages", "paperclip-runner");
  return { repoRoot, packageRoot };
}

async function withRepo(action) {
  const repo = await makeRepo();
  try {
    await action(repo);
  } finally {
    await rm(repo.repoRoot, { recursive: true, force: true });
  }
}

test("the input set covers sources, the eval kernel and root config, and skips outputs and caches", async () => {
  await withRepo(async ({ repoRoot }) => {
    const files = collectBuildInputFiles(repoRoot);
    assert.deepEqual(files, [
      "package.json",
      "packages/paperclip-eval-kernel/src/index.ts",
      "packages/paperclip-runner/package.json",
      "packages/paperclip-runner/runner/src/main.rs",
      "packages/paperclip-runner/src/index.ts",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
    ]);
  });
});

test("the digest is stable, ignores outputs and caches, and tracks every kind of input", async () => {
  await withRepo(async ({ repoRoot }) => {
    const before = computeBuildInputsDigest(repoRoot);
    assert.equal(before.schema, BUILD_INPUTS_SCHEMA);
    assert.equal(before.fileCount, 8);
    assert.equal(computeBuildInputsDigest(repoRoot).digest, before.digest, "two reads disagree");

    // Outputs, dependencies, caches and the Rust target directory may change freely.
    await writeTree(repoRoot, {
      "packages/paperclip-runner/dist/index.js": "export const one = 2;\n",
      "packages/paperclip-runner/dist-browser/index.js": "changed\n",
      "packages/paperclip-runner/node_modules/dep/index.js": "changed\n",
      "packages/paperclip-runner/.vite/cache.json": '{"changed":true}\n',
      "packages/paperclip-runner/runner/target/release/paperclip-runnerd": "rebuilt\n",
      "packages/paperclip-eval-kernel/dist/index.js": "changed\n",
    });
    assert.equal(computeBuildInputsDigest(repoRoot).digest, before.digest, "an output changed the digest");

    // Every input kind changes it: TypeScript, Rust, the eval kernel, root config, a new file, a rename.
    const seen = new Set([before.digest]);
    const expectChange = async (label, files) => {
      await writeTree(repoRoot, files);
      const next = computeBuildInputsDigest(repoRoot).digest;
      assert.ok(!seen.has(next), `${label} did not change the digest`);
      seen.add(next);
    };
    await expectChange("a Runner source", { "packages/paperclip-runner/src/index.ts": "export const one = 2;\n" });
    await expectChange("a Rust source", { "packages/paperclip-runner/runner/src/main.rs": "fn main() { }\n" });
    await expectChange("an eval-kernel source", { "packages/paperclip-eval-kernel/src/index.ts": "export const kernel = 2;\n" });
    await expectChange("the lockfile", { "pnpm-lock.yaml": "lockfileVersion: 9\nchanged: true\n" });
    await expectChange("the base tsconfig", { "tsconfig.base.json": '{"compilerOptions":{}}\n' });
    await expectChange("a new file", { "packages/paperclip-runner/protocol/new.json": "{}\n" });
    await rm(path.join(repoRoot, "packages/paperclip-runner/protocol/new.json"));
    await expectChange("a renamed file", { "packages/paperclip-runner/protocol/renamed.json": "{}\n" });
  });
});

test("a symlink is hashed as its target path, not followed", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const before = computeBuildInputsDigest(repoRoot);
    await symlink("../node_modules/dep", path.join(packageRoot, "src", "linked"), "dir");
    const linked = computeBuildInputsDigest(repoRoot);
    assert.notEqual(linked.digest, before.digest, "the link itself is an input");
    assert.equal(linked.fileCount, before.fileCount + 1, "the link target's files were followed");
    await writeFile(path.join(packageRoot, "node_modules/dep/index.js"), "changed\n");
    assert.equal(computeBuildInputsDigest(repoRoot).digest, linked.digest, "a change behind the link changed the digest");
  });
});

test("a build is current only with a matching stamp and every consumer-facing output present", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const platform = "linux";
    const arch = "x64";
    const assess = () => assessRunnerBuild({ repoRoot, packageRoot, platform, arch });

    assert.equal(assess().current, false);
    assert.equal(assess().code, "no_stamp");

    const record = recordRunnerBuild({ repoRoot, packageRoot, platform, arch, now: () => new Date(0) });
    assert.equal(record.stampPath, buildInputsStampPath(packageRoot));
    assert.deepEqual(readBuildInputsStamp(record.stampPath), {
      schema: BUILD_INPUTS_SCHEMA,
      digest: record.digest,
      fileCount: 8,
      byteCount: record.byteCount,
      platform,
      arch,
      recordedAt: "1970-01-01T00:00:00.000Z",
    });
    const current = assess();
    assert.equal(current.current, true, current.detail);
    assert.equal(current.code, "inputs_unchanged");

    assert.equal(assessRunnerBuild({ repoRoot, packageRoot, platform: "win32", arch }).code, "platform_mismatch");
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot, platform, arch: "arm64" }).code, "platform_mismatch");

    for (const output of expectedBuildOutputs(packageRoot, platform)) {
      const content = await readFile(output);
      await rm(output);
      const missing = assess();
      assert.equal(missing.current, false, `${output} missing still counted as current`);
      assert.equal(missing.code, "missing_output");
      assert.match(missing.detail, new RegExp(path.basename(output)));
      await writeFile(output, content);
    }
    assert.equal(assess().current, true);

    await writeFile(path.join(packageRoot, "src", "index.ts"), "export const one = 3;\n");
    const changed = assess();
    assert.equal(changed.current, false);
    assert.equal(changed.code, "inputs_changed");

    await writeFile(record.stampPath, JSON.stringify({ ...readBuildInputsStamp(record.stampPath), schema: "other" }));
    assert.equal(assess().code, "schema_mismatch");
    await writeFile(record.stampPath, "not json");
    assert.equal(assess().code, "no_stamp");
  });
});

test("record-build-inputs.mjs writes the stamp for the package it is pointed at", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const { stdout } = await execFileAsync(process.execPath, [recordScript, "--package-root", packageRoot]);
    const expected = computeBuildInputsDigest(repoRoot);
    assert.match(stdout, new RegExp(`^${BUILD_INPUTS_SCHEMA} recorded: digest=${expected.digest.slice(0, 12)} files=8 `));
    const stamp = readBuildInputsStamp(buildInputsStampPath(packageRoot));
    assert.equal(stamp.digest, expected.digest);
    assert.equal(stamp.platform, process.platform);
    assert.equal(stamp.arch, process.arch);
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot }).current, true);

    await assert.rejects(
      execFileAsync(process.execPath, [recordScript, "--bogus"]),
      /unknown argument --bogus/,
    );
  });
});
