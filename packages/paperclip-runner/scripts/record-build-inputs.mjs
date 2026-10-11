// Final step of the Runner package's `build`: records the digest of every
// build input next to the outputs it produced, so server's
// prepare:runner-vendor can reuse this build instead of repeating it when
// nothing has changed. See build-inputs.mjs for what counts as an input.
//
// Usage: node scripts/record-build-inputs.mjs [--package-root <dir>]
// The package root defaults to this package; the flag exists for tests that
// build a throwaway package layout.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordRunnerBuild,
  repoRootFromRunnerPackage,
  runnerPackageRootFromScripts,
} from "./build-inputs.mjs";

export function parseArguments(argv) {
  let packageRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--package-root") {
      packageRoot = argv[index + 1];
      if (!packageRoot) throw new Error("--package-root needs a directory");
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return { packageRoot };
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const { packageRoot: requested } = parseArguments(argv);
  const packageRoot = requested ? path.resolve(requested) : runnerPackageRootFromScripts();
  const repoRoot = repoRootFromRunnerPackage(packageRoot);
  const record = recordRunnerBuild({ repoRoot, packageRoot });
  log(
    `${record.schema} recorded: digest=${record.digest.slice(0, 12)} files=${record.fileCount} ` +
      `bytes=${record.byteCount} stamp=${path.relative(packageRoot, record.stampPath)}`,
  );
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
