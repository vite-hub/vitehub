import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  array,
  literal,
  number,
  object,
  optional,
  safeParse,
  string,
} from "valibot";
import { listFiles, parseScalar, titleCase } from "./artifacts/common";
import { docsLanes, parseDocsLanes } from "./docs-lanes";
import { toRawMarkdown } from "./artifacts/raw-markdown";

type DocsArtifactOptions = {
  docsRoot: string;
  outputDir: string;
};

const docsManifestVersion = 1;
const docsManifestSchema = object({
  sections: array(
    object({
      pages: array(object({ path: string() })),
    }),
  ),
  version: literal(docsManifestVersion),
});
const fileSystemErrorSchema = object({ code: optional(string()) });
const lockOwnerSchema = object({ identity: optional(string()), pid: number(), token: string() });
const lockStaleAfterMs = 30_000;

function fileSystemErrorCode(error: unknown) {
  const parsed = safeParse(fileSystemErrorSchema, error);
  return parsed.success ? parsed.output.code : undefined;
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileSystemErrorCode(error) === "EPERM";
  }
}

function linuxProcessIdentity(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startedAt = fields[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return startedAt && bootId ? `${bootId}:${startedAt}` : null;
  } catch {
    return null;
  }
}

const currentProcessIdentity = linuxProcessIdentity(process.pid) || `node:${randomUUID()}`;

function lockOwnerIsRunning(owner: { identity?: string, pid: number }) {
  if (!processIsRunning(owner.pid)) return false;
  if (!owner.identity) return true;
  const identity = owner.pid === process.pid ? currentProcessIdentity : linuxProcessIdentity(owner.pid);
  return identity === null || identity === owner.identity;
}

function hasRecoveryClaim(lockDir: string) {
  try {
    return readdirSync(lockDir).some(entry => entry.startsWith(".recovery-"));
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return true;
    throw error;
  }
}

export function recoverAbandonedLock(lockDir: string) {
  try {
    let owner: unknown;
    try {
      owner = JSON.parse(readFileSync(resolve(lockDir, "owner.json"), "utf8"));
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT" || error instanceof SyntaxError) {
        if (Date.now() - statSync(lockDir).mtimeMs < lockStaleAfterMs) return false;
        const claimPath = resolve(lockDir, ".recovery-claim");
        try {
          mkdirSync(claimPath);
        } catch (claimError) {
          if (fileSystemErrorCode(claimError) === "ENOENT") return true;
          if (fileSystemErrorCode(claimError) === "EEXIST") return false;
          throw claimError;
        }

        let liveOwner = false;
        try {
          const currentOwner: unknown = JSON.parse(readFileSync(resolve(lockDir, "owner.json"), "utf8"));
          const parsedCurrentOwner = safeParse(lockOwnerSchema, currentOwner);
          liveOwner = parsedCurrentOwner.success && lockOwnerIsRunning(parsedCurrentOwner.output);
        } catch (ownerError) {
          if (fileSystemErrorCode(ownerError) !== "ENOENT" && !(ownerError instanceof SyntaxError)) {
            rmSync(claimPath, { force: true, recursive: true });
            throw ownerError;
          }
        }
        if (liveOwner) {
          rmSync(claimPath, { force: true, recursive: true });
          return false;
        }

        try {
          rmSync(lockDir, { recursive: true });
          return true;
        } catch (recoveryError) {
          rmSync(claimPath, { force: true, recursive: true });
          throw recoveryError;
        }
      }
      throw error;
    }
    const parsedOwner = safeParse(lockOwnerSchema, owner);
    if (!parsedOwner.success || lockOwnerIsRunning(parsedOwner.output)) return false;

    const claimedOwnerPath = resolve(lockDir, `.recovery-${randomUUID()}.json`);
    try {
      renameSync(resolve(lockDir, "owner.json"), claimedOwnerPath);
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") return !existsSync(lockDir);
      throw error;
    }
    const claimedOwner: unknown = JSON.parse(readFileSync(claimedOwnerPath, "utf8"));
    const parsedClaimedOwner = safeParse(lockOwnerSchema, claimedOwner);
    if (
      !parsedClaimedOwner.success
      || parsedClaimedOwner.output.pid !== parsedOwner.output.pid
      || parsedClaimedOwner.output.identity !== parsedOwner.output.identity
      || parsedClaimedOwner.output.token !== parsedOwner.output.token
    ) {
      if (!existsSync(resolve(lockDir, "owner.json"))) renameSync(claimedOwnerPath, resolve(lockDir, "owner.json"));
      return false;
    }

    rmSync(lockDir, { recursive: true });
    return true;
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function ownsLock(lockDir: string, token: string) {
  try {
    const owner: unknown = JSON.parse(readFileSync(resolve(lockDir, "owner.json"), "utf8"));
    const parsedOwner = safeParse(lockOwnerSchema, owner);
    return parsedOwner.success && parsedOwner.output.token === token;
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function rawPagePath(contentRoot: string, absolutePath: string, prefix: string) {
  const segments = relative(contentRoot, absolutePath)
    .replace(/\\/g, "/")
    .replace(/\.md$/, "")
    .split("/")
    .map(segment => segment.replace(/^\d+\./, ""));
  if (segments.at(-1) === "index") segments.pop();
  const route = [prefix, ...segments].filter(Boolean).join("/") || "index";
  return `${route}.md`;
}

function withArtifactLock<T>(outputDir: string, callback: () => T) {
  const lockDir = resolve(outputDir, ".raw-artifacts.lock");
  const lockToken = randomUUID();
  mkdirSync(outputDir, { recursive: true });
  const deadline = Date.now() + lockStaleAfterMs;
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(resolve(lockDir, "owner.json"), JSON.stringify({
        identity: currentProcessIdentity,
        pid: process.pid,
        token: lockToken,
      }));
      if (hasRecoveryClaim(lockDir) || !ownsLock(lockDir, lockToken)) {
        if (ownsLock(lockDir, lockToken)) rmSync(lockDir, { recursive: true });
        continue;
      }
      break;
    } catch (error) {
      if (fileSystemErrorCode(error) !== "EEXIST") throw error;
      if (recoverAbandonedLock(lockDir)) continue;
      if (Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  try {
    return callback();
  } finally {
    if (ownsLock(lockDir, lockToken)) rmSync(lockDir, { recursive: true });
  }
}

function writeRawMarkdownArtifacts(docsRoot: string, outputDir: string) {
  const rawOutputDir = resolve(outputDir, "raw");
  const expectedPaths = new Set<string>();
  for (const [directory, prefix] of [["docs", "docs"], ["blog", "blog"], ["trust", ""]] as const) {
    const contentRoot = resolve(docsRoot, "content", directory);
    for (const absolutePath of listFiles(contentRoot, ".md")) {
      const destination = resolve(rawOutputDir, rawPagePath(contentRoot, absolutePath, prefix));
      expectedPaths.add(destination);
      mkdirSync(resolve(destination, ".."), { recursive: true });
      const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, toRawMarkdown(readFileSync(absolutePath, "utf8")));
        renameSync(temporaryPath, destination);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    }
  }

  for (const existingPath of listFiles(rawOutputDir, ".md")) {
    if (!expectedPaths.has(existingPath)) rmSync(existingPath, { force: true });
  }
}

function parseFrontmatter(source: string) {
  if (!source.startsWith("---\n")) {
    return {};
  }

  const endIndex = source.indexOf("\n---", 4);
  if (endIndex === -1) {
    return {};
  }

  const frontmatter = source.slice(4, endIndex).trim();
  const result: Record<string, unknown> = {};

  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key = "", value = ""] = match;
    result[key] = parseScalar(value);
  }

  return result;
}

function parseNavigationFile(sectionDir: string) {
  const navigationPath = resolve(sectionDir, ".navigation.yml");
  if (!existsSync(navigationPath)) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const line of readFileSync(navigationPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key = "", value = ""] = match;
    result[key] = parseScalar(value);
  }

  return result;
}

function normalizePageId(relativeFile: string) {
  const withoutExtension = relativeFile.replace(/\.md$/, "");
  if (withoutExtension === "index") {
    return "index";
  }

  if (withoutExtension.endsWith("/index")) {
    return withoutExtension.slice(0, -"/index".length) || "index";
  }

  return withoutExtension;
}

function pagePath(sectionId: string, pageId: string) {
  return pageId === "index"
    ? `/docs/${sectionId}`
    : `/docs/${sectionId}/${pageId}`;
}

function pageTitleFromMeta(pageId: string, meta: Record<string, unknown>) {
  return String(meta["navigation.title"] || meta.title || titleCase(pageId === "index" ? "overview" : pageId));
}

function optionalString(value: unknown) {
  const result = safeParse(string(), value);
  return result.success ? result.output : null;
}

function optionalNumber(value: unknown) {
  const result = safeParse(number(), value);
  return result.success ? result.output : null;
}

function pageOrderFromMeta(meta: Record<string, unknown>) {
  const result = optionalNumber(meta["navigation.order"]);
  return result ?? Number.MAX_SAFE_INTEGER;
}

function collectPages(rootDir: string, sectionId: string) {
  return listFiles(rootDir, ".md").map((absolutePath) => {
    const relativeFile = relative(rootDir, absolutePath).replace(/\\/g, "/");
    const source = readFileSync(absolutePath, "utf8");
    const pageId = normalizePageId(relativeFile);
    const meta = parseFrontmatter(source);

    return {
      id: pageId,
      path: pagePath(sectionId, pageId),
      title: pageTitleFromMeta(pageId, meta),
      sourceTitle: optionalString(meta.title),
      description: optionalString(meta.description),
      icon: optionalString(meta.icon),
      group: optionalString(meta["navigation.group"]),
      lanes: parseDocsLanes(meta["navigation.lanes"]),
      navigation: meta.navigation !== false,
      order: pageOrderFromMeta(meta),
    };
  }).sort((left, right) => {
    if (left.id === "index") {
      return -1;
    }

    if (right.id === "index") {
      return 1;
    }

    if (left.order !== right.order) {
      return left.order - right.order;
    }

    return left.id.localeCompare(right.id);
  });
}

function collectRootPage(localDocsRoot: string) {
  const rootPath = resolve(localDocsRoot, "index.md");
  if (!existsSync(rootPath)) {
    return null;
  }

  const meta = parseFrontmatter(readFileSync(rootPath, "utf8"));
  return {
    id: "index",
    path: "/docs",
    title: pageTitleFromMeta("index", meta),
    sourceTitle: optionalString(meta.title),
    description: optionalString(meta.description),
    icon: optionalString(meta.icon),
    lanes: docsLanes,
    navigation: meta.navigation !== false,
    order: pageOrderFromMeta(meta),
  };
}

function createDocsSection(sectionId: string, rootDir: string, order: number) {
  const navigation = parseNavigationFile(rootDir);
  const lanes = parseDocsLanes(navigation.lanes) || [...docsLanes];
  const pages = collectPages(rootDir, sectionId).map(page => ({
    ...page,
    lanes: page.lanes || lanes,
  }));
  const overview = pages.find(page => page.id === "index");

  return {
    id: sectionId,
    path: pagePath(sectionId, "index"),
    title: optionalString(navigation.title) || overview?.sourceTitle || titleCase(sectionId),
    description: overview?.description || null,
    icon: optionalString(navigation.icon) || overview?.icon || null,
    lanes,
    order: optionalNumber(navigation.order) ?? order,
    pages,
  };
}

function collectSections(localDocsRoot: string) {
  if (!existsSync(localDocsRoot)) {
    return [];
  }

  return readdirSync(localDocsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry, index) => createDocsSection(entry.name, resolve(localDocsRoot, entry.name), index))
    .filter(section => section.pages.length > 0)
    .sort((left, right) => {
      return left.order - right.order || left.title.localeCompare(right.title);
    });
}

export function writeDocsArtifacts({ docsRoot, outputDir }: DocsArtifactOptions) {
  return withArtifactLock(outputDir, () => {
    const localDocsRoot = resolve(docsRoot, "content", "docs");
    const rootPage = collectRootPage(localDocsRoot);
    const sections = collectSections(localDocsRoot);
    const manifest = { version: docsManifestVersion, rootPage, sections };

    writeRawMarkdownArtifacts(docsRoot, outputDir);
    mkdirSync(outputDir, { recursive: true });

    const manifestSource = `export const docsManifest = ${JSON.stringify(manifest, null, 2)};\n\nexport default docsManifest;\n`;
    const manifestPath = resolve(outputDir, "docs-manifest.mjs");
    if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifestSource) {
      const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(temporaryPath, manifestSource);
        renameSync(temporaryPath, manifestPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    }

    return manifest;
  });
}

export function readDocsArtifactsManifest(outputDir: string) {
  const manifestPath = resolve(outputDir, "docs-manifest.mjs");
  if (!existsSync(manifestPath)) {
    return null;
  }

  const source = readFileSync(manifestPath, "utf8");
  const prefix = "export const docsManifest = ";
  const suffix = ";\n\nexport default docsManifest;\n";

  if (!source.startsWith(prefix) || !source.endsWith(suffix)) {
    return null;
  }

  const manifest: unknown = JSON.parse(source.slice(prefix.length, -suffix.length));
  const result = safeParse(docsManifestSchema, manifest);
  return result.success ? result.output : null;
}
