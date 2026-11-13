import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Leave headroom below Cloudflare's 64 MiB uncompressed Worker limit.
const maxBytes = 60 * 1024 * 1024;
// Cloudflare rejects an upload of 5,000 or more modules with "multipart: message too large". Nitro 3 uploads each
// chunk as its own module, so a feature that adds a module per page or per file can reach the limit in one change.
const maxModules = 2500;

/** Check Wrangler's --outdir output, including every additional Worker module. */
export function checkWorkerSize(directory) {
  const root = resolve(directory);
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    // Wrangler writes a README and source maps that are not Worker modules.
    .filter(file => file !== join(root, "README.md") && !file.endsWith(".map"));
  if (!files.length) throw new Error(`No Worker modules found in ${root}. Run wrangler deploy --dry-run --outdir first.`);
  const bytes = files.reduce((total, file) => total + statSync(file).size, 0);
  if (bytes > maxBytes) {
    throw new Error(`Docs Worker is ${(bytes / 1024 / 1024).toFixed(2)} MiB uncompressed, exceeding the 60 MiB budget. Reduce the bundle before deploying.`);
  }
  if (files.length > maxModules) {
    throw new Error(`Docs Worker has ${files.length} modules, exceeding the budget of ${maxModules}. Cloudflare rejects 5,000. Bundle many small files into one module before deploying.`);
  }
  return { bytes, modules: files.length };
}

if (import.meta.main) {
  const { bytes, modules } = checkWorkerSize(process.argv[2] ?? "docs/.wrangler/bundle");
  console.log(`Docs Worker: ${(bytes / 1024 / 1024).toFixed(2)} MiB uncompressed (60 MiB budget), ${modules} modules (${maxModules} budget).`);
}
