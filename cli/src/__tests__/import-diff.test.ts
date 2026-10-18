import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { diffImportPackages } from "../commands/diff/import-diff.js";

test("diff scans empty and nested packages without constructing an async function", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-import-diff-"));
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  const originalArgv = process.argv;
  const originalLog = console.log;
  const output: string[] = [];
  try {
    await mkdir(left);
    await mkdir(right);
    process.argv = ["node", "paperclipai", "diff", "packages", "--left", left, "--right", right];
    console.log = (...args: unknown[]) => { output.push(args.join(" ")); };
    await diffImportPackages({ left, right });
    const empty = JSON.parse(output.at(-1)!);
    assert.equal(empty.leftCount, 0);
    assert.equal(empty.rightCount, 0);

    for (const dir of [left, right]) {
      await mkdir(path.join(dir, "agents", "nested"), { recursive: true });
      await writeFile(path.join(dir, "COMPANY.md"), "Same company\n");
      await writeFile(path.join(dir, "README.md"), "Ignored metadata\n");
    }
    await writeFile(path.join(left, "agents", "nested", "alice.md"), "Old description\n");
    await writeFile(path.join(right, "agents", "nested", "alice.md"), "New description\n");
    await writeFile(path.join(left, "agents", "left-only.md"), "Only left\n");
    await writeFile(path.join(right, "agents", "right-only.md"), "Only right\n");
    await diffImportPackages({ left, right });
    const report = JSON.parse(output.at(-1)!);
    assert.equal(report.leftCount, 3);
    assert.equal(report.rightCount, 3);
    assert.deepEqual(report.summary, { overlap: 2, leftDrift: 1, rightDrift: 1, conflicts: 1 });
    assert.equal(report.details.conflicts[0].leftPath, "agents/nested/alice.md");
    assert.equal(report.details.conflicts[0].rightPath, "agents/nested/alice.md");
    assert.equal(report.details.leftDrift[0].slug, "left-only");
    assert.equal(report.details.rightDrift[0].slug, "right-only");
  } finally {
    process.argv = originalArgv;
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});
