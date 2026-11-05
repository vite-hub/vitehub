import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { parse } from "yaml";

import type { RunnableTutorialData, TutorialFiles } from "./steps";

export type { RunnableTutorialData, RunnableTutorialStep, TutorialFiles } from "./steps";
export { tutorialStepFiles } from "./steps";

export interface RunnableTutorialSource {
  slug: string;
  /** The docs page, such as `/docs/getting-started/first-agent`. Its file is `content/<page>.md`. */
  page: string;
  /** The folder in `fixtures/tutorials/`. */
  fixture: string;
}

// Generated or installed files. A fixture that was built or run locally has them, and the workspace makes its own.
const ignoredEntries = new Set(["node_modules", ".output", ".vitehub", ".nitro", ".data", "dist"]);

/** Labels of code blocks that are not files of the app, such as `commands/dev` and `output/response.json`. */
export function isTutorialFileLabel(label: string): boolean {
  return !label.startsWith("commands/") && !label.startsWith("output/");
}

function codeBlockLabels(markdown: string): string[] {
  return [...markdown.matchAll(/^```[^\n[]*\[([^\]]+)\]/gm)].map(match => match[1]!);
}

function frontmatterField(markdown: string, field: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
  const value: unknown = parse(frontmatter)?.[field];
  return typeof value === "string" ? value : "";
}

/** The `::tutorial-step` blocks of a page, in order, with the file labels of their code blocks. */
export function parseTutorialSteps(markdown: string): { title: string, labels: string[] }[] {
  const steps: { title: string, labels: string[] }[] = [];
  for (const match of markdown.matchAll(/^::tutorial-step\{([^}]*)\}\n([\s\S]*?)^::$/gm)) {
    const title = /title="([^"]*)"/.exec(match[1]!)?.[1];
    if (!title) throw new Error(`A ::tutorial-step block has no title: ::tutorial-step{${match[1]}}`);
    steps.push({ title, labels: codeBlockLabels(match[2]!).filter(isTutorialFileLabel) });
  }
  return steps;
}

/** The code block of `label` in a page, without its fences. */
export function codeBlock(markdown: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp("^```[^\\n]*\\[" + escaped + "\\]\\n([\\s\\S]*?)\\n```", "m").exec(markdown);
  return match ? `${match[1]}\n` : undefined;
}

/** The text files of a fixture folder, without generated or installed files. */
export async function readTree(root: string, directory = root): Promise<TutorialFiles> {
  const files: TutorialFiles = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredEntries.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await readTree(root, path));
    else if (entry.isFile()) files[relative(root, path).replaceAll("\\", "/")] = await readFile(path, "utf8");
  }
  return files;
}

export interface WorkspaceVersions {
  /** `catalog` and `catalogs` from `pnpm-workspace.yaml`. */
  catalogs: Record<string, Record<string, string>>;
  /** The version of each workspace package, by name. */
  packages: Record<string, string>;
}

/** Reads the pnpm catalogs and the versions of the workspace packages that fixtures depend on. */
export async function readWorkspaceVersions(repoRoot: string): Promise<WorkspaceVersions> {
  const workspace: unknown = parse(await readFile(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8"));
  const record = workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : {};
  const catalogs: Record<string, Record<string, string>> = {};
  if (record.catalog && typeof record.catalog === "object") catalogs.default = record.catalog as Record<string, string>;
  if (record.catalogs && typeof record.catalogs === "object") Object.assign(catalogs, record.catalogs);

  const packages: Record<string, string> = {};
  for (const entry of await readdir(resolve(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(resolve(repoRoot, "packages", entry.name, "package.json"), "utf8"));
      if (typeof manifest.name === "string" && typeof manifest.version === "string") packages[manifest.name] = manifest.version;
    }
    catch {
      // A folder without a package.json is not a workspace package.
    }
  }
  return { catalogs, packages };
}

/**
 * Rewrites `catalog:` and `workspace:` specifiers to npm versions, so `npm install` works outside this repository.
 * A workspace package resolves to the published range of its current version.
 */
export function resolveManifest(source: string, versions: WorkspaceVersions): string {
  const manifest = JSON.parse(source);
  for (const field of ["dependencies", "devDependencies"] as const) {
    const dependencies: Record<string, string> | undefined = manifest[field];
    if (!dependencies) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (specifier.startsWith("catalog:")) {
        const catalog = specifier.slice("catalog:".length) || "default";
        const version = versions.catalogs[catalog]?.[name];
        if (!version) throw new Error(`No version of ${name} in the pnpm catalog "${catalog}".`);
        dependencies[name] = version;
      }
      else if (specifier.startsWith("workspace:")) {
        const version = versions.packages[name];
        if (!version) throw new Error(`No workspace package named ${name}.`);
        dependencies[name] = `^${version}`;
      }
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Builds the workspace files of one tutorial.
 *
 * The fixture is the app after the last step, and every file code block in the lesson equals a fixture file. So step N
 * writes the fixture version of the files that its code blocks name. Before step 1 the app is the fixture without those
 * files, except where Installation already shows a version, such as `vite.config.ts`.
 */
export async function buildRunnableTutorial(input: {
  source: RunnableTutorialSource
  contentDir: string
  fixturesDir: string
  versions: WorkspaceVersions
}): Promise<RunnableTutorialData> {
  const { source, contentDir, fixturesDir, versions } = input;
  const lesson = (await readFile(resolve(contentDir, `${source.page.replace(/^\//, "")}.md`), "utf8")).replaceAll("\r\n", "\n");
  const installation = (await readFile(resolve(contentDir, "docs/getting-started/installation.md"), "utf8")).replaceAll("\r\n", "\n");
  const fixture = await readTree(resolve(fixturesDir, source.fixture));
  if (fixture["package.json"]) fixture["package.json"] = resolveManifest(fixture["package.json"], versions);

  const parsed = parseTutorialSteps(lesson);
  if (parsed.length === 0) throw new Error(`${source.page} has no ::tutorial-step blocks.`);

  const files: TutorialFiles = { ...fixture };
  const steps = parsed.map(({ title, labels }) => {
    const stepFiles: TutorialFiles = {};
    for (const label of labels) {
      const contents = fixture[label];
      if (contents === undefined) throw new Error(`${source.page} shows ${label}, but fixtures/tutorials/${source.fixture} has no such file.`);
      stepFiles[label] = contents;
    }
    return { title, files: stepFiles };
  });
  // Files that a step writes start in their Installation version, or do not exist yet.
  for (const step of steps) {
    for (const path of Object.keys(step.files)) {
      const before = codeBlock(installation, path);
      if (before === undefined) delete files[path];
      else files[path] = before;
    }
  }

  return {
    slug: source.slug,
    page: source.page,
    title: frontmatterField(lesson, "title"),
    description: frontmatterField(lesson, "description"),
    files,
    steps,
  };
}

/** A deflated .zip of text files, so a reader can download the starter of a tutorial. */
export function createZip(files: TutorialFiles, folder: string): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, contents] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const name = Buffer.from(`${folder}/${path}`, "utf8");
    const data = Buffer.from(contents, "utf8");
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    // DOS date 1980-01-01, so the archive is the same on every build.
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034B50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014B50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    header.copy(entry, 8, 6, 26);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}
