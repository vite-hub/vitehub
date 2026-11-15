import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

it("uses canonical CLI paths in repository source, documentation, and scripts", () => {
  const files = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean));
  // Tests can exercise removed paths. Operation identifiers such as kv.delete and
  // email.outbox-list are unchanged; match only full CLI invocations.
  const removedCommand = /\bvitehub\s+(?:db\b|usage\b|(?:kv|blob)\s+del\b|content\s+rm\b|channels\s+export\b|email\s+outbox-(?:list|show|clear)\b|inspect\s+provider-output\b|agent\s+dev\b[^\r\n]*\s--payload\b)|\bvitehub-drain\b/;
  const violations: string[] = [];
  for (const file of files) {
    if (!existsSync(join(repoRoot, file))) continue;
    if (/(?:^|\/)(?:test|tests)\//.test(file) || /\.(?:test|spec)\./.test(file)) continue;
    // This migration's source and guide explain the removed commands to users.
    if (file === "packages/codemods/src/renamed-apis/index.ts" || file === "packages/codemods/README.md") continue;
    if (!/\.(?:md|[cm]?[jt]sx?|vue|svelte|json|ya?ml|sh)$/.test(file)) continue;
    for (const [index, line] of readFileSync(join(repoRoot, file), "utf8").split("\n").entries()) {
      if (removedCommand.test(line)) violations.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  expect(violations).toEqual([]);
});
