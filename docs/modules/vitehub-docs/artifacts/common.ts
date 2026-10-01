import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function titleCase(input: string) {
  return input
    .split(/[-/]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function listFiles(rootDir: string, extension: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const absolutePath = join(rootDir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      files.push(...listFiles(absolutePath, extension));
      continue;
    }

    if (entry.isFile() && (!extension || absolutePath.endsWith(extension))) {
      files.push(absolutePath);
    }
  }

  return files.sort();
}

export function parseScalar(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // Only a YAML flow sequence is a list. Titles and descriptions can contain commas.
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => item.replace(/^['"]|['"]$/g, ""));
  }

  return trimmed;
}
