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
  "vscode-icons:file-type-toml",
  "vscode-icons:file-type-vue",
]);

const zodRegexAnnotationComment = "/** Anchors a pattern source. The interpolation lives here rather than at the call site because\n * esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it\n * will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */";
const zodUtilAnnotationComment = "// Wrapped in a `@__PURE__` IIFE: esbuild never tree-shakes a top-level initializer that contains a member access on `Number`, so the bare object literal survived into every bundle.";
const rollupAnnotationConclusion = "contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.";

export const buildWarningBudget = Object.freeze([
  { name: "Docus assistant disabled", maximum: 1, text: "AI assistant disabled:" },
  {
    name: "Nuxt Content local D1 fallback",
    maximum: 1,
    text: "Deploying to Cloudflare requires using D1 database",
  },
  {
    name: "Fontshare fetch retries",
    maximum: 3,
    text: "Could not fetch from https://api.fontshare.com/v2/fonts",
  },
  {
    name: "Bunny Fonts fetch retries",
    maximum: 3,
    text: "Could not fetch from https://fonts.bunny.net/list",
  },
  { name: "build plugin timings", maximum: 3, text: "[PLUGIN_TIMINGS]" },
  { name: "VueUse pure annotations", maximum: 2, text: "[INVALID_ANNOTATION]" },
  {
    name: "Nuxt generated pure annotations",
    maximum: 2,
    text: rollupAnnotationConclusion,
    source: "node_modules/.cache/nuxt/.nuxt/dist/server/_nuxt/dist-Dg8NDwTS.js",
    sourcePattern: /^node_modules\/\.cache\/nuxt\/\.nuxt\/dist\/server\/_nuxt\/(?:dist|agent-capability-inspector)-[\w-]+\.js$/,
    comment: zodRegexAnnotationComment,
    warningTokenRequired: false,
  },
  {
    name: "Zod util pure annotation",
    maximum: 1,
    text: rollupAnnotationConclusion,
    source: "zod@4.6.5/node_modules/zod/v4/core/util.js",
    comment: zodUtilAnnotationComment,
    warningTokenRequired: false,
  },
  {
    name: "Zod regexes pure annotation",
    maximum: 1,
    text: rollupAnnotationConclusion,
    source: "zod@4.6.5/node_modules/zod/v4/core/regexes.js",
    comment: zodRegexAnnotationComment,
    warningTokenRequired: false,
  },
  { name: "Nuxt UI button imports", maximum: 2, text: "[INEFFECTIVE_DYNAMIC_IMPORT]" },
  { name: "Vite chunk size", maximum: 1, text: "[plugin builtin:vite-reporter]" },
  {
    name: "Google Fonts icon metadata fetch",
    maximum: 1,
    text: "Could not fetch from https://fonts.google.com/metadata/icons?key=material_symbols&incomplete=true. Will retry in",
  },
  {
    name: "Google Fonts font metadata fetch",
    maximum: 1,
    text: "Could not fetch from https://fonts.google.com/metadata/fonts. Will retry in",
  },
  { name: "Nitro Cloudflare assets override", maximum: 1, text: "Wrangler config assetsset" },
  {
    name: "Nuxt Nitro server unused H3Event import",
    maximum: 1,
    text: '"H3Event" is imported from external module',
  },
  {
    name: "esbuild BigInt target warning",
    maximum: 3,
    text: "Big integer literals are not available in the configured target environment",
  },
  {
    name: "esbuild duplicate provider warning",
    maximum: 1,
    text: 'Duplicate key "provider" in object literal',
  },
]);

export function assertBuildWarningBudget(output) {
  const counts = new Map(buildWarningBudget.map((entry) => [entry.name, 0]));
  const unknownWarnings = [];
  const newMissingIcons = new Set();

  const lines = stripVTControlCharacters(output).split(/\r?\n/);
  const annotationDetails = new Map();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const normalizedLine = normalizeWarningText(line);
    const annotationBudget = annotationDetails.get(lineIndex);
    if (annotationBudget) {
      counts.set(annotationBudget.name, (counts.get(annotationBudget.name) ?? 0) + 1);
      continue;
    }
    const header = /^\s*(?:(?:\[warn(?:ing)?\]|warn(?:ing)?\b)\s*)?(.+?) \(\d+:\d+\): A comment\s*$/i.exec(line);
    if (header) {
      const source = header[1];
      const budget = buildWarningBudget.find(entry => entry.comment && (
        entry.sourcePattern ? entry.sourcePattern.test(source)
          : source === entry.source || source.endsWith(`/${entry.source}`)
      ));
      if (budget) {
        const detailIndex = lines.findIndex((detail, index) => index > lineIndex && index < lineIndex + 8
          && detail.trim() === `in "${source}" ${budget.text}`);
        const comment = lines.slice(lineIndex + 1, detailIndex).join("\n");
        if (detailIndex !== -1 && normalizeWarningText(comment).trim() === normalizeWarningText(budget.comment).trim()) {
          annotationDetails.set(detailIndex, budget);
          continue;
        }
      }
    }
    if (normalizedLine.includes("contains an annotation that rollup cannot interpret")) {
      unknownWarnings.push(line.trim());
      continue;
    }
    if (
      !/^\s*(?:\[warn(?:ing)?\]|warn(?:ing)?\b|\(node:\d+\)\s+(?:\[[a-z\d_]+\]\s+)?[a-z]*warning:|[a-z]*warning:)/i.test(
        line,
      )
    )
      continue;
    const iconMatch =
      /\[Icon] (?:failed to load icon [`'"]?([^`'"\s]+)[`'"]?|loading icon [`'"]?([^`'"\s]+)[`'"]? timed out after 1500ms)(?: \(repeated \d+ times\))?$/i.exec(
        line,
      );
    if (iconMatch) {
      const icon = iconMatch[1] || iconMatch[2];
      if (!allowedMissingIcons.includes(icon)) newMissingIcons.add(icon);
      continue;
    }
    const budget = buildWarningBudget.find((entry) =>
      !entry.comment && normalizedLine.includes(normalizeWarningText(entry.text)),
    );
    if (!budget) unknownWarnings.push(line.trim());
    else counts.set(budget.name, (counts.get(budget.name) ?? 0) + 1);
  }

  const overBudget = buildWarningBudget
    .filter((entry) => (counts.get(entry.name) ?? 0) > entry.maximum)
    .map((entry) => `${entry.name}: ${counts.get(entry.name)}/${entry.maximum}`);
  const failures = [
    ...overBudget.map((entry) => `warning budget exceeded for ${entry}`),
    ...[...newMissingIcons].sort().map((icon) => `new missing icon: ${icon}`),
    ...unknownWarnings.map((warning) => `unbudgeted warning: ${warning}`),
  ];
  if (failures.length > 0) {
    throw new Error(
      `Docs build warnings changed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
}

function normalizeWarningText(text) {
  return text.toLowerCase().replace(/[`'"]/g, "").replace(/\s+/g, " ");
}

export async function runDocsBuild() {
  const child = spawn("nuxi", ["build"], {
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"]
        .filter(Boolean)
        .join(" "),
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
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await runDocsBuild();
