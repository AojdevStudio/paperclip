import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CACHED_PATHS, HASHED_INPUTS, RUNNER_PACKAGE, computeScope, markCurrent } from "../runner-release-crate-cache.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts/runner-release-crate-cache.mjs");
const readWorkflow = (name) => readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
const prWorkflow = readWorkflow("pr-trusted.yml");
const releaseWorkflow = readWorkflow("release-verify.yml");

// Slice one job out of a workflow, from its two-space-indented key to the next.
function job(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `workflow is missing the ${name} job`);
  const body = workflow.slice(start + 1);
  const header = `  ${name}:\n`.length;
  const next = body.slice(header).search(/\n  [a-z0-9_-]+:\n/);
  return next === -1 ? body : body.slice(0, header + next + 1);
}

// Slice one step out of a job by its name, up to the next step.
function step(body, name) {
  const marker = `      - name: ${name}\n`;
  const start = body.indexOf(marker);
  assert.ok(start >= 0, `missing step: ${name}`);
  const rest = body.slice(start + marker.length);
  const next = rest.search(/\n      - name: /);
  return marker + (next === -1 ? rest : rest.slice(0, next + 1));
}

const RELEASE_DIR = `${RUNNER_PACKAGE}/runner/target/release`;
const KEY_STEP = "Compute the Runner release crate cache key";
const RESTORE_STEP = "Restore the Runner release crate (read only)";
const MARK_STEP = "Mark the restored Runner release crate current";
const LOOKUP_STEP = "Check for this push's Runner release crate";
const BUILD_STEP = "Build the Runner release crate for its cache";
const SAVE_STEP = "Save the Runner release crate";
const RUST_RESTORE_STEP = "Restore Runner Rust dependencies (read only)";

// Every PR job that builds the Runner release binary, and the command each
// one runs cargo through. The crate must be restored and marked before it.
const READERS = [
  ["typecheck_release_registry", "run: pnpm run typecheck:build-gaps"],
  ["verify_paperclip_runner", "run: pnpm --filter @paperclipai/paperclip-runner ${{ matrix.command }}"],
  ["build", "run: pnpm build"],
  ["canary_dry_run", "- name: Release canary dry run via release.sh internal build"],
];

const WRITER_GATE = "matrix.lane == 'rust' && github.repository == 'paperclipai/paperclip' && github.event_name == 'push' && github.ref == 'refs/heads/master' && inputs.ref == github.sha";

const expectedPathBlock = `          path: |\n${CACHED_PATHS.map((entry) => `            ${entry}\n`).join("")}`;
const expectedKey = `key: runner-release-crate-v1-\${{ steps.runner_release_crate_key.outputs.scope }}-\${{ hashFiles(${HASHED_INPUTS.map((entry) => `'${entry}'`).join(", ")}) }}`;

function assertCacheStep(body, name, { lookupOnly = false } = {}) {
  assert.match(body, /uses: actions\/cache\/(restore|save)@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/, name);
  assert.ok(body.includes(expectedPathBlock), `${name}: the cached path list must be exactly the script's CACHED_PATHS`);
  assert.ok(body.includes(expectedKey), `${name}: the key must be built from the script's scope and HASHED_INPUTS`);
  // An exact match or nothing: a prefix match would restore another
  // revision's artifacts and the mark step would make cargo keep them.
  assert.doesNotMatch(body, /restore-keys:/, name);
  assert.equal(/lookup-only: true/.test(body), lookupOnly, name);
  assert.doesNotMatch(body, /enableCrossOsArchive|fail-on-cache-miss: true/, name);
}

test("the script's path list and key inputs cover what the release build of the crate reads and writes", () => {
  assert.deepEqual(CACHED_PATHS, [
    `${RELEASE_DIR}/.fingerprint/paperclip-runner-core-*`,
    `${RELEASE_DIR}/deps/libpaperclip_runner_core-*`,
    `${RELEASE_DIR}/deps/paperclip_runner_core-*.d`,
    `${RELEASE_DIR}/deps/paperclip_runnerd-*`,
    `${RELEASE_DIR}/paperclip-runnerd`,
    `${RELEASE_DIR}/paperclip-runnerd.d`,
  ]);
  assert.deepEqual(HASHED_INPUTS, [
    `${RUNNER_PACKAGE}/rust-toolchain.toml`,
    `${RUNNER_PACKAGE}/runner/Cargo.toml`,
    `${RUNNER_PACKAGE}/runner/Cargo.lock`,
    `${RUNNER_PACKAGE}/runner/crates/**`,
    `${RUNNER_PACKAGE}/protocol/**`,
    `${RUNNER_PACKAGE}/test-fixtures/**`,
    `${RUNNER_PACKAGE}/test/fixtures/**`,
  ]);
  for (const input of HASHED_INPUTS) {
    const fixed = input.replace(/\/\*\*$/, "");
    assert.ok(statSync(path.join(repoRoot, fixed)), `${input} must exist in the repository`);
  }
  // The stage step copies the uplifted binary; it has to be in the set.
  const stage = readFileSync(path.join(repoRoot, RUNNER_PACKAGE, "scripts/stage-runner-binary.mjs"), "utf8");
  assert.match(stage, /"runner", "target", "release", executable/);
  assert.ok(CACHED_PATHS.includes(`${RELEASE_DIR}/paperclip-runnerd`));
});

test("every file the crate includes by path sits under a hashed input, so an edit to it changes the key", () => {
  const crateRoot = path.join(repoRoot, RUNNER_PACKAGE, "runner/crates");
  const hashedRoots = HASHED_INPUTS.map((input) => path.join(repoRoot, input.replace(/\/\*\*$/, "")));
  const sources = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".rs")) sources.push(full);
    }
  })(crateRoot);
  assert.ok(sources.length > 10, "the crate sources must be found");
  let includes = 0;
  for (const source of sources) {
    const text = readFileSync(source, "utf8");
    for (const [, literal] of text.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"/g)) {
      includes += 1;
      const resolved = path.resolve(path.dirname(source), literal);
      assert.ok(
        hashedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)),
        `${path.relative(repoRoot, source)} includes ${literal}, which no HASHED_INPUTS pattern covers`,
      );
      assert.ok(statSync(resolved).isFile(), `${literal} must exist`);
    }
  }
  assert.ok(includes > 0, "the crate includes protocol files by path; the guard must see them");
});

test("every PR reader restores the crate after the dependency cache and marks it before building", () => {
  for (const [name, buildCommand] of READERS) {
    const body = job(prWorkflow, name);
    const positions = [RUST_RESTORE_STEP, KEY_STEP, RESTORE_STEP, MARK_STEP].map((stepName) => body.indexOf(`      - name: ${stepName}\n`));
    assert.ok(positions.every((position) => position >= 0), `${name}: a crate cache step is missing`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${name}: the crate steps must follow the dependency restore in order`);
    const build = body.indexOf(buildCommand);
    assert.ok(build > positions.at(-1), `${name}: the crate must be marked before ${buildCommand}`);

    const key = step(body, KEY_STEP);
    assert.match(key, /id: runner_release_crate_key\n/, name);
    assert.match(key, /run: echo "scope=\$\(node scripts\/runner-release-crate-cache\.mjs scope\)" >> "\$GITHUB_OUTPUT"/, name);

    const restore = step(body, RESTORE_STEP);
    assert.match(restore, /id: runner_release_crate\n/, name);
    assertCacheStep(restore, `${name} restore`);
    assert.doesNotMatch(restore, /actions\/cache\/save/, name);

    const mark = step(body, MARK_STEP);
    assert.match(mark, /if: \$\{\{ steps\.runner_release_crate\.outputs\.cache-hit == 'true' \}\}/, name);
    assert.match(mark, /run: node scripts\/runner-release-crate-cache\.mjs mark-current/, name);
  }
  // No other job restores or saves the crate.
  const total = prWorkflow.match(/- name: Restore the Runner release crate \(read only\)\n/g)?.length ?? 0;
  assert.equal(total, READERS.length);
  assert.doesNotMatch(prWorkflow, /actions\/cache\/save@/);
});

test("the Verify Paperclip Runner job restores the crate only in the lanes that build it", () => {
  const body = job(prWorkflow, "verify_paperclip_runner");
  const lanes = [...body.matchAll(/- lane_label: (.+)\n\s+command: (.+)\n(\s+release_crate: (true)\n)?/g)].map(([, label, , , flag]) => [label, flag === "true"]);
  assert.deepEqual(lanes, [
    ["static checks", false],
    ["rust", true],
    ["vitest 1/2", false],
    ["vitest 2/2", true],
  ]);
  for (const stepName of [KEY_STEP, RESTORE_STEP]) {
    assert.match(step(body, stepName), /if: \$\{\{ matrix\.release_crate == true \}\}/, stepName);
  }
  // A lane that skipped the restore has no cache-hit output, so the mark
  // step's own condition is enough there.
  assert.match(step(body, MARK_STEP), /if: \$\{\{ steps\.runner_release_crate\.outputs\.cache-hit == 'true' \}\}/);
  for (const [name] of READERS.filter(([name]) => name !== "verify_paperclip_runner")) {
    for (const stepName of [KEY_STEP, RESTORE_STEP]) {
      assert.doesNotMatch(step(job(prWorkflow, name), stepName), /^\s+if:/m, `${name}: ${stepName} is unconditional`);
    }
  }
});

test("only the master Rust lane writes the crate, after a lookup, with the readers' exact path list and key", () => {
  const body = job(releaseWorkflow, "verify_paperclip_runner");
  const positions = ["Verify Paperclip Runner", "Warm debug dependencies for the shared Runner cache", KEY_STEP, LOOKUP_STEP, BUILD_STEP, SAVE_STEP].map((stepName) => body.indexOf(`      - name: ${stepName}\n`));
  assert.ok(positions.every((position) => position >= 0), "a writer step is missing");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the writer steps must follow the checks and the debug warm-up, in order");

  for (const stepName of [KEY_STEP, LOOKUP_STEP]) {
    assert.match(step(body, stepName), new RegExp(`if: \\$\\{\\{ ${WRITER_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\}\\}`), stepName);
  }
  for (const stepName of [BUILD_STEP, SAVE_STEP]) {
    assert.match(
      step(body, stepName),
      new RegExp(`if: \\$\\{\\{ ${WRITER_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} && steps\\.runner_release_crate\\.outputs\\.cache-hit != 'true' \\}\\}`),
      stepName,
    );
  }
  assert.match(step(body, KEY_STEP), /run: echo "scope=\$\(node scripts\/runner-release-crate-cache\.mjs scope\)" >> "\$GITHUB_OUTPUT"/);

  const lookup = step(body, LOOKUP_STEP);
  assert.match(lookup, /id: runner_release_crate\n/);
  assert.match(lookup, /uses: actions\/cache\/restore@/);
  assertCacheStep(lookup, "writer lookup", { lookupOnly: true });

  // The saved artifacts come from the readers' exact command, on a crate
  // cleaned of the test-profile variants the lane's checks built.
  const build = step(body, BUILD_STEP);
  assert.match(build, /working-directory: packages\/paperclip-runner\n/);
  assert.match(build, /set -euo pipefail\n\s+cargo clean --release --manifest-path runner\/Cargo\.toml -p paperclip-runner-core\n\s+pnpm build:binary\n/);
  const runnerScripts = JSON.parse(readFileSync(path.join(repoRoot, RUNNER_PACKAGE, "package.json"), "utf8")).scripts;
  assert.match(runnerScripts["build:binary"], /^cargo build --release --manifest-path runner\/Cargo\.toml --locked -p paperclip-runner-core --bin paperclip-runnerd && /);

  const save = step(body, SAVE_STEP);
  assert.match(save, /uses: actions\/cache\/save@/);
  assertCacheStep(save, "writer save");

  // The dependency cache's own writer gate is the same expression.
  assert.match(body, new RegExp(`save-if: \\$\\{\\{ ${WRITER_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\}\\}`));
  assert.equal((releaseWorkflow.match(/actions\/cache\/save@/g) ?? []).length, 1);
});

test("the scope names the platform, the compiler and the checkout root, and survives a missing rustc", () => {
  const a = computeScope({ workspace: "/home/runner/_work/paperclip/paperclip", rustcVersion: "1.97.1-abcdef123-x86_64-unknown-linux-gnu" });
  const b = computeScope({ workspace: "/home/runner/work/paperclip/paperclip", rustcVersion: "1.97.1-abcdef123-x86_64-unknown-linux-gnu" });
  const c = computeScope({ workspace: "/home/runner/_work/paperclip/paperclip", rustcVersion: "1.97.2-0123456ab-x86_64-unknown-linux-gnu" });
  assert.notEqual(a, b, "a different checkout root must select a different entry");
  assert.notEqual(a, c, "a different compiler must select a different entry");
  assert.equal(a, computeScope({ workspace: "/home/runner/_work/paperclip/paperclip/", rustcVersion: "1.97.1-abcdef123-x86_64-unknown-linux-gnu" }));
  assert.match(a, new RegExp(`^${os.platform()}-${os.arch()}-1\\.97\\.1-abcdef123-x86_64-unknown-linux-gnu-[0-9a-f]{12}$`));
  assert.doesNotMatch(computeScope({ rustcVersion: "weird version/with spaces" }), /[^A-Za-z0-9._-]/);

  // The CLI reads rustc from PATH; a stand-in proves which fields it reads,
  // and an empty PATH proves a missing compiler still yields a usable key.
  const bin = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-rustc-"));
  try {
    const stub = path.join(bin, "rustc");
    writeFileSync(stub, '#!/bin/sh\nprintf "rustc 1.97.1 (8bab26f4f 2026-06-30)\\nbinary: rustc\\ncommit-hash: 8bab26f4f0123456789abcdef\\ncommit-date: 2026-06-30\\nhost: x86_64-unknown-linux-gnu\\nrelease: 1.97.1\\nLLVM version: 21.1.2\\n"\n');
    chmodSync(stub, 0o755);
    const withStub = execFileSync(process.execPath, [script, "scope"], { encoding: "utf8", env: { ...process.env, PATH: bin, GITHUB_WORKSPACE: "/home/runner/_work/paperclip/paperclip" } }).trim();
    assert.equal(withStub, computeScope({ workspace: "/home/runner/_work/paperclip/paperclip", rustcVersion: "1.97.1-8bab26f4f-x86_64-unknown-linux-gnu" }));
    const without = execFileSync(process.execPath, [script, "scope"], { encoding: "utf8", env: { ...process.env, PATH: mkdtempSync(path.join(os.tmpdir(), "empty-path-")), GITHUB_WORKSPACE: "/home/runner/_work/paperclip/paperclip" } }).trim();
    assert.match(without, /-no-rustc-/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// The tree cargo leaves behind for the crate's release lib and bin units,
// with the mtimes GitHub's cache restores: older than a fresh checkout.
function layRestoredCrate(root, { withRlib = true } = {}) {
  const release = path.join(root, RELEASE_DIR);
  const lib = path.join(release, ".fingerprint/paperclip-runner-core-0b6c4654c2710743");
  const bin = path.join(release, ".fingerprint/paperclip-runner-core-46cce78dbc4840c2");
  mkdirSync(path.join(release, "deps"), { recursive: true });
  mkdirSync(lib, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const files = {
    [path.join(lib, "lib-paperclip_runner_core")]: "0123456789abcdef",
    [path.join(lib, "lib-paperclip_runner_core.json")]: "{}",
    [path.join(lib, "dep-lib-paperclip_runner_core")]: "dep",
    [path.join(lib, "invoked.timestamp")]: "t",
    [path.join(bin, "bin-paperclip-runnerd")]: "fedcba9876543210",
    [path.join(bin, "bin-paperclip-runnerd.json")]: "{}",
    [path.join(bin, "dep-bin-paperclip-runnerd")]: "dep",
    [path.join(release, "deps/libpaperclip_runner_core-0b6c4654c2710743.rmeta")]: "rmeta",
    [path.join(release, "deps/paperclip_runner_core-0b6c4654c2710743.d")]: "d",
    [path.join(release, "deps/paperclip_runnerd-46cce78dbc4840c2")]: "ELF",
    [path.join(release, "deps/paperclip_runnerd-46cce78dbc4840c2.d")]: "d",
    [path.join(release, "paperclip-runnerd")]: "ELF",
    [path.join(release, "paperclip-runnerd.d")]: "d",
    // A dependency's artifacts sit beside the crate's and must not be touched.
    [path.join(release, "deps/libserde-1234567890abcdef.rlib")]: "dep rlib",
  };
  if (withRlib) files[path.join(release, "deps/libpaperclip_runner_core-0b6c4654c2710743.rlib")] = "rlib";
  const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(file, content);
    utimesSync(file, old, old);
  }
  for (const dir of [lib, bin, path.join(release, "deps"), path.join(release, ".fingerprint"), release]) utimesSync(dir, old, old);
  return { release, files: Object.keys(files), old };
}

test("mark-current makes every restored artifact newer than the checkout and leaves dependencies alone", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-"));
  try {
    const { release, files, old } = layRestoredCrate(root);
    const checkout = path.join(root, RUNNER_PACKAGE, "runner/crates/runner-core/src/lib.rs");
    mkdirSync(path.dirname(checkout), { recursive: true });
    writeFileSync(checkout, "// checked out after the artifacts were built\n");
    const checkedOutAt = statSync(checkout).mtimeMs;

    const result = markCurrent({ root, now: new Date(checkedOutAt + 5000) });
    assert.equal(result.action, "marked");
    assert.equal(result.files, 14);
    assert.equal(result.bytes, files.filter((file) => !file.includes("libserde")).reduce((sum, file) => sum + statSync(file).size, 0));

    for (const file of files) {
      const mtime = statSync(file).mtimeMs;
      if (file.includes("libserde")) assert.equal(Math.floor(mtime / 1000), Math.floor(old.getTime() / 1000), "a dependency artifact must keep its mtime");
      else assert.ok(mtime > checkedOutAt, `${path.relative(release, file)} must be newer than the checkout`);
    }
    for (const dir of [".fingerprint/paperclip-runner-core-0b6c4654c2710743", ".fingerprint/paperclip-runner-core-46cce78dbc4840c2"]) {
      assert.ok(statSync(path.join(release, dir)).mtimeMs > checkedOutAt, `${dir} must be newer than the checkout`);
    }
    assert.ok(statSync(checkout).mtimeMs === checkedOutAt, "sources are never touched");

    // The CLI prints the same result as one line of JSON for the job log.
    const printed = JSON.parse(execFileSync(process.execPath, [script, "mark-current"], { encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: root } }));
    assert.equal(printed.schema, "paperclip.runner-release-crate.v1");
    assert.equal(printed.action, "marked");
    assert.equal(printed.files, 14);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mark-current discards an incomplete restore so cargo sees a plain miss", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-"));
  try {
    const { release } = layRestoredCrate(root, { withRlib: false });
    const result = markCurrent({ root });
    assert.equal(result.action, "discarded");
    assert.match(result.reason, /the lib rlib is missing/);
    assert.ok(result.removed > 0);
    assert.deepEqual(readdirSync(path.join(release, ".fingerprint")), []);
    assert.deepEqual(readdirSync(path.join(release, "deps")), ["libserde-1234567890abcdef.rlib"], "only the crate's own artifacts are removed");
    assert.deepEqual(readdirSync(release).sort(), [".fingerprint", "deps"]);

    // Nothing restored at all is reported the same way and exits cleanly.
    const empty = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-empty-"));
    try {
      const printed = JSON.parse(execFileSync(process.execPath, [script, "mark-current"], { encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: empty } }));
      assert.equal(printed.action, "discarded");
      assert.equal(printed.removed, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI prints the lists the workflows embed", () => {
  const paths = execFileSync(process.execPath, [script, "paths"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(paths, CACHED_PATHS);
  const inputs = execFileSync(process.execPath, [script, "hashed-inputs"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(inputs, HASHED_INPUTS);
  const usage = spawnSync(process.execPath, [script, "nonsense"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: runner-release-crate-cache\.mjs/);
});
