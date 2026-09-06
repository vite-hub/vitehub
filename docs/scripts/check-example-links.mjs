#!/usr/bin/env node
import { examples } from "../app/data/examples.ts";
import { checkExampleLinks } from "./example-links.mjs";

const result = await checkExampleLinks(examples, { token: process.env.GITHUB_TOKEN });
const categories = new Map();
for (const check of result.checks) categories.set(check.category, (categories.get(check.category) ?? 0) + 1);

console.log("Public examples catalog link report:");
for (const [category, count] of [...categories].sort()) console.log(`- ${category}: ${count} checked`);

if (result.failures.length > 0) {
  console.error(`Public examples catalog check failed with ${result.failures.length} error(s):`);
  for (const failure of result.failures) console.error(`- [${failure.category}] ${failure.name}: ${failure.message}`);
  process.exitCode = 1;
}
