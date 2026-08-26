#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export const allowedMissingIcons = Object.freeze([
  "simple-icons:bun",
  "simple-icons:npm",
  "simple-icons:pnpm",
  "simple-icons:yarn",
  "vscode-icons:file-type-css",
  "vscode-icons:file-type-dotenv",
  "vscode-icons:file-type-json",
  "vscode-icons:file-type-node",
  "vscode-icons:file-type-nuxt",
  "vscode-icons:file-type-tsconfig",
  "vscode-icons:file-type-vue",
]);

export const buildWarningBudget = Object.freeze([
  { name: "Docus assistant disabled", maximum: 1, text: "AI assistant disabled:" },
  { name: "Nuxt Content local D1 fallback", maximum: 1, text: "Deploying to Cloudflare requires using D1 database" },
  { name: "build plugin timings", maximum: 3, text: "[PLUGIN_TIMINGS]" },
  { name: "VueUse pure annotations", maximum: 2, text: "[INVALID_ANNOTATION]" },
  { name: "Rollup pure annotations", maximum: 2, text: "contains an annotation that Rollup cannot interpret", warningTokenRequired: false },
  { name: "Vite chunk size", maximum: 1, text: "[plugin builtin:vite-reporter]" },
  { name: "Nitro Cloudflare assets override", maximum: 1, text: "Wrangler config assetsset" },
]);

export function assertBuildWarningBudget(output) {
  const counts = new Map(buildWarningBudget.map(entry => [entry.name, 0]));
  const unknownWarnings = [];
  const newMissingIcons = new Set();

  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const normalizedLine = normalizeWarningText(line);
    const warningWithoutToken = buildWarningBudget.find(entry => entry.warningTokenRequired === false && normalizedLine.includes(normalizeWarningText(entry.text)));
    if (warningWithoutToken) {
      counts.set(warningWithoutToken.name, (counts.get(warningWithoutToken.name) ?? 0) + 1);
      continue;
    }
    if (!/^\s*(?:\[warn(?:ing)?\]|warn(?:ing)?\b|\(node:\d+\)\s+(?:\[[a-z\d_]+\]\s+)?[a-z]*warning:|[a-z]*warning:)/i.test(line)) continue;
    const iconMatch = /\[Icon] failed to load icon [`'"]?([^`'"\s]+)[`'"]?/i.exec(line);
    if (iconMatch) {
      if (!allowedMissingIcons.includes(iconMatch[1])) newMissingIcons.add(iconMatch[1]);
      continue;
    }
    const budget = buildWarningBudget.find(entry => normalizedLine.includes(normalizeWarningText(entry.text)));
    if (!budget) unknownWarnings.push(line.trim());
    else counts.set(budget.name, (counts.get(budget.name) ?? 0) + 1);
  }

  const overBudget = buildWarningBudget
    .filter(entry => (counts.get(entry.name) ?? 0) > entry.maximum)
    .map(entry => `${entry.name}: ${counts.get(entry.name)}/${entry.maximum}`);
  const failures = [
    ...overBudget.map(entry => `warning budget exceeded for ${entry}`),
    ...[...newMissingIcons].sort().map(icon => `new missing icon: ${icon}`),
    ...unknownWarnings.map(warning => `unbudgeted warning: ${warning}`),
  ];
  if (failures.length > 0) {
    throw new Error(`Docs build warnings changed:\n${failures.map(failure => `- ${failure}`).join("\n")}`);
  }
}

function normalizeWarningText(text) {
  return text.toLowerCase().replace(/[`'"]/g, "").replace(/\s+/g, " ");
}

export async function runDocsBuild() {
  const child = spawn("nuxi", ["build"], {
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"].filter(Boolean).join(" "),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (status.code !== 0 || status.signal) {
    process.exitCode = status.code || 1;
    return;
  }
  try {
    assertBuildWarningBudget(output);
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await runDocsBuild();
