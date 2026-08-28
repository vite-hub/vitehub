import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function lockOwnerIsRunning(owner: { identity?: string, pid: number }, evidencePath: string) {
  if (!processIsRunning(owner.pid)) return false;
  if (!owner.identity) return true;
  const identity = owner.pid === process.pid ? currentProcessIdentity : linuxProcessIdentity(owner.pid);
  if (identity !== null) return identity === owner.identity;
  return Date.now() - statSync(evidencePath).mtimeMs < lockStaleAfterMs;
}

function hasRecoveryClaim(lockDir: string) {
  try {
    return readdirSync(lockDir).some(entry => entry.startsWith(".recovery-"));
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function claimLockRecovery(lockDir: string) {
  const claimPath = resolve(lockDir, ".recovery-claim");
  while (true) {
    const owner = {
      identity: currentProcessIdentity,
      pid: process.pid,
      token: randomUUID(),
    };
    const candidatePath = resolve(lockDir, `.recovery-candidate-${owner.token}.json`);
    writeFileSync(candidatePath, JSON.stringify(owner), { flag: "wx" });
    try {
      linkSync(candidatePath, claimPath);
      return owner.token;
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") return null;
      if (fileSystemErrorCode(error) !== "EEXIST") throw error;
    } finally {
      rmSync(candidatePath, { force: true });
    }

    let existingOwner: unknown;
    try {
      existingOwner = JSON.parse(readFileSync(claimPath, "utf8"));
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    const parsedOwner = safeParse(lockOwnerSchema, existingOwner);
    if (!parsedOwner.success || lockOwnerIsRunning(parsedOwner.output, claimPath)) return false;

    const abandonedPath = resolve(lockDir, `.recovery-abandoned-${randomUUID()}.json`);
    try {
      renameSync(claimPath, abandonedPath);
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    const abandonedOwner: unknown = JSON.parse(readFileSync(abandonedPath, "utf8"));
    const parsedAbandonedOwner = safeParse(lockOwnerSchema, abandonedOwner);
    if (parsedAbandonedOwner.success && parsedAbandonedOwner.output.token === parsedOwner.output.token) {
      rmSync(abandonedPath, { force: true });
      continue;
    }
    if (!existsSync(claimPath)) renameSync(abandonedPath, claimPath);
    return false;
  }
}

function restoreQuarantinedLock(lockDir: string, quarantinePath: string) {
  if (!existsSync(lockDir)) renameSync(quarantinePath, lockDir);
}

function recoverMalformedLock(lockDir: string) {
  if (Date.now() - statSync(lockDir).mtimeMs < lockStaleAfterMs) return false;
  const claimToken = claimLockRecovery(lockDir);
  if (claimToken === null) return true;
  if (claimToken === false) return false;

  const quarantinePath = `${lockDir}.recovery-${claimToken}`;
  try {
    renameSync(lockDir, quarantinePath);
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return true;
    throw error;
  }

  try {
    const claim: unknown = JSON.parse(readFileSync(resolve(quarantinePath, ".recovery-claim"), "utf8"));
    const parsedClaim = safeParse(lockOwnerSchema, claim);
    if (!parsedClaim.success || parsedClaim.output.token !== claimToken) {
      restoreQuarantinedLock(lockDir, quarantinePath);
      return false;
    }
    rmSync(quarantinePath, { recursive: true });
    return true;
  } catch (error) {
    if (existsSync(quarantinePath)) restoreQuarantinedLock(lockDir, quarantinePath);
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
        return recoverMalformedLock(lockDir);
      }
      throw error;
    }
    const parsedOwner = safeParse(lockOwnerSchema, owner);
    if (!parsedOwner.success) return recoverMalformedLock(lockDir);
    if (lockOwnerIsRunning(parsedOwner.output, resolve(lockDir, "owner.json"))) return false;

    const claimToken = claimLockRecovery(lockDir);
    if (claimToken === null) return true;
    if (claimToken === false) return false;

    try {
      const currentOwner: unknown = JSON.parse(readFileSync(resolve(lockDir, "owner.json"), "utf8"));
      const parsedCurrentOwner = safeParse(lockOwnerSchema, currentOwner);
      if (
        !parsedCurrentOwner.success
        || parsedCurrentOwner.output.pid !== parsedOwner.output.pid
        || parsedCurrentOwner.output.identity !== parsedOwner.output.identity
        || parsedCurrentOwner.output.token !== parsedOwner.output.token
        || lockOwnerIsRunning(parsedCurrentOwner.output, resolve(lockDir, "owner.json"))
      ) return false;

      const quarantinePath = `${lockDir}.recovery-${claimToken}`;
      try {
        renameSync(lockDir, quarantinePath);
      } catch (error) {
        if (fileSystemErrorCode(error) === "ENOENT") return !existsSync(lockDir);
        throw error;
      }

      rmSync(quarantinePath, { recursive: true });
      return true;
    } finally {
      if (ownsLockRecovery(lockDir, claimToken)) rmSync(resolve(lockDir, ".recovery-claim"), { force: true });
    }
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function ownsLockRecovery(lockDir: string, token: string) {
  try {
    const claim: unknown = JSON.parse(readFileSync(resolve(lockDir, ".recovery-claim"), "utf8"));
    const parsedClaim = safeParse(lockOwnerSchema, claim);
    return parsedClaim.success && parsedClaim.output.token === token;
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return false;
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
      if (hasRecoveryClaim(lockDir)) {
        if (ownsLock(lockDir, lockToken)) rmSync(resolve(lockDir, "owner.json"), { force: true });
        continue;
      }
      if (!ownsLock(lockDir, lockToken)) {
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
