import { parse } from "yaml";
import * as snapshots from "../src/server/github-install-snapshot.ts";
import * as inputs from "../src/server/github-install-inputs.ts";
import { chmod, symlink, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateGitHubInstallInputs } from "../src/server/github-install-inputs.ts";
import { assertGitHubDependenciesCurrent, installGitHubPullRequestWorkspace, GitHubWorkspaceInstallError } from "../src/server/github-install.ts";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-host-install-")); roots.push(root);
  await mkdir(join(root, ".git")); await mkdir(join(root, "bin"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6" }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/../args.txt"\nif [ -n "$GITHUB_APP_PRIVATE_KEY" ]; then exit 99; fi\nif [ "$COREPACK_ENV_FILE" != 0 ] || [ "$COREPACK_NPM_REGISTRY" != https://registry.npmjs.org ]; then exit 98; fi\nmkdir -p node_modules\n', { mode: 0o755 });
  vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH}`);
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "host-secret");
  return root;
}
it("classifies malformed installation inputs separately from host failures", async () => {
  const root = await fixture();
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n---\nimporters: {}\n");
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toMatchObject({ retryable: false });
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await expect(installGitHubPullRequestWorkspace(root, undefined, async () => {
    throw new Error("Registry temporarily unavailable.");
  })).rejects.toMatchObject({ retryable: true });
});

it.each(["validation", "publication", "cleanup"])("retries host %s failures after the package-manager command succeeds", async phase => {
  const root = await fixture();
  const failure = Object.assign(new Error("Temporary host failure."), phase === "validation" ? { errno: -5, code: "EIO" } : { code: 1 });
  const createSnapshot = snapshots.createGitHubInstallSnapshot;
  const validateInputs = inputs.validateGitHubInstallInputs;
  const mock = phase === "validation"
    ? vi.spyOn(inputs, "validateGitHubInstallInputs").mockImplementationOnce(validateInputs).mockRejectedValueOnce(failure)
    : phase === "publication"
      ? vi.spyOn(snapshots, "publishGitHubInstallSnapshot").mockRejectedValueOnce(failure)
      : vi.spyOn(snapshots, "createGitHubInstallSnapshot").mockImplementationOnce(async target => {
        const snapshot = await createSnapshot(target);
        return { ...snapshot, async close() { await snapshot.close(); throw failure; } };
      });
  try {
    await expect(installGitHubPullRequestWorkspace(root, undefined, async ({ cwd }) => {
      await mkdir(join(cwd, "node_modules"));
    })).rejects.toMatchObject({ retryable: true });
  } finally { mock.mockRestore(); }
});

it("installs on the host with a frozen lockfile and no host secrets or lifecycle scripts", async () => {
  const root = await fixture();
  await installGitHubPullRequestWorkspace(root);
  expect(await readFile(join(root, ".git", "args.txt"), "utf8")).toBe("pnpm@10.34.6\ninstall\n--frozen-lockfile\n--ignore-scripts\n--ignore-pnpmfile\n--config.manage-package-manager-versions=false\n");
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "installed", scripts: false });
});
it("publishes cached runner output only through the validated snapshot", async () => {
  const root = await fixture();
  await installGitHubPullRequestWorkspace(root, undefined, async input => {
    expect(input.cwd).not.toBe(root);
    expect(input.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(input.command).toContain("--ignore-scripts");
    await mkdir(join(input.cwd, "node_modules"));
    await writeFile(join(input.cwd, "node_modules", "cached.txt"), "isolated");
    return { cache: "hit", durationMs: 1 };
  });
  expect(await readFile(join(root, "node_modules", "cached.txt"), "utf8")).toBe("isolated");
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "installed", scripts: false, cache: "hit" });
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
});

it("rejects changed live dependency inputs after a cached runner completes", async () => {
  const root = await fixture();
  await expect(installGitHubPullRequestWorkspace(root, undefined, async input => {
    await mkdir(join(input.cwd, "node_modules"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { changed: "1.0.0" } }));
  })).rejects.toThrow("Dependency inputs changed during installation");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow();
});

it.each(["~1.2.1", "~2.2.10 || ^3.0.0", "~ 1.2", "~1"])("accepts the tilde dependency range %s", async range => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { example: range } }));
  await writeFile(join(root, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\npackages:\n  example@1.2.1:\n    peerDependencies:\n      peer: '${range}'\n`);
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
});

it.each(["~/private", "~user/private", "~"])("rejects the home dependency path %s before execution", async path => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { example: path } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it("reports the trusted host Corepack prerequisite when Node does not provide it", async () => {
  const root = await fixture();
  vi.stubEnv("PATH", join(root, "missing-host-tools"));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/requires Corepack in PATH/);
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "failed" });
});

it.each(["true", "false"])("accepts lockfile-shaping npm peer settings: %s", async legacyPeerDeps => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.6.3" }));
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, ".npmrc"), `legacy-peer-deps=${legacyPeerDeps}\ninstall-links=true\n`);
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it.each([".npmrc", "pnpm-workspace.yaml"])("accepts pnpm deep workspace linking from %s and fingerprints it", async config => {
  const root = await fixture();
  await writeFile(join(root, config), config === ".npmrc" ? "link-workspace-packages=deep\n" : "linkWorkspacePackages: deep\n");
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
  await writeFile(join(root, config), config === ".npmrc" ? "link-workspace-packages=false\n" : "linkWorkspacePackages: false\n");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow();
});

it("records a reproduced installation failure for durable retry", async () => {
  const root = await fixture();
  await writeFile(join(root, "bin", "corepack"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toBeInstanceOf(GitHubWorkspaceInstallError);
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "failed" });
});

it("rejects checkout-selected package-manager executables before running Corepack", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@https://example.com/untrusted.tgz" }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/official matching/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});
it.each(["1.22.22", "4.9.2"])("suppresses Yarn %s delegation, plugins and workspace scripts", async version => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: `yarn@${version}` }));
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/../args.txt"\nprintf "%s\\n" "$YARN_RC_FILENAME" "$COREPACK_ENABLE_PROJECT_SPEC" "$YARN_IGNORE_PATH" > "$HOME/../env.txt"\n', { mode: 0o755 });
  await installGitHubPullRequestWorkspace(root);
  const args = await readFile(join(root, ".git", "args.txt"), "utf8");
  if (version.startsWith("1.")) expect(args).toContain("--ignore-scripts\n--ignore-path\n--no-default-rc");
  else {
    expect(args).toContain("--immutable\n--mode=skip-build");
    const [config] = (await readFile(join(root, ".git", "env.txt"), "utf8")).split("\n");
    expect(config).toMatch(/^\.vitehub-install-[a-f\d-]+\.yml$/);
    await expect(readFile(join(root, config!))).rejects.toThrow();
  }
});

it.each(["node-modules", "pnpm", "pnp"])("preserves the Yarn %s linker without loading project extensions", async linker => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, ".yarnrc.yml"), `nodeLinker: ${linker}\nyarnPath: ./untrusted.cjs\nplugins:\n  - path: ./untrusted-plugin.cjs\n`);
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\ncat "$YARN_RC_FILENAME" > "$HOME/../yarn-config.txt"\n', { mode: 0o755 });
  await installGitHubPullRequestWorkspace(root);
  const config = await readFile(join(root, ".git", "yarn-config.txt"), "utf8");
  expect(config).toContain(`nodeLinker: ${linker}\n`);
  expect(config).toContain("enableScripts: false\nignorePath: true\n");
  expect(config).not.toMatch(/yarnPath|plugins|untrusted/);
});

it.each([
  { pnpEnableEsmLoader: true, pnpEnableInlining: false, pnpMode: "loose", pnpFallbackMode: "all" },
  { nmHoistingLimits: "workspaces", nmSelfReferences: false, nmMode: "hardlinks-local" },
])("preserves and fingerprints Yarn layout settings %j", async layout => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, ".yarnrc.yml"), JSON.stringify(layout));
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\ncat "$YARN_RC_FILENAME" > "$HOME/../yarn-config.txt"\n', { mode: 0o755 });
  await installGitHubPullRequestWorkspace(root);
  expect(parse(await readFile(join(root, ".git", "yarn-config.txt"), "utf8"))).toMatchObject(layout);
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
  await writeFile(join(root, ".yarnrc.yml"), "{}");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it.each([{ pnpEnableEsmLoader: "true" }, { nmHoistingLimits: "invalid" }, { nmMode: "../../outside" }])("rejects invalid Yarn layout settings %j before execution", async layout => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, ".yarnrc.yml"), JSON.stringify(layout));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toBeInstanceOf(GitHubWorkspaceInstallError);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it("invalidates installed dependencies when the Yarn linker changes", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  await installGitHubPullRequestWorkspace(root);
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
  await writeFile(join(root, ".yarnrc.yml"), "nodeLinker: pnpm\n");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it.each(["invalid", ["node-modules"], { path: "/outside" }])("rejects an unsupported Yarn linker %j before execution", async linker => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, ".yarnrc.yml"), JSON.stringify({ nodeLinker: linker }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toBeInstanceOf(GitHubWorkspaceInstallError);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it.each([
  ["file:/srv/outside.tgz", "# yarn lockfile v1\n"],
  ["file:%2fsrv/outside.tgz", "# yarn lockfile v1\n"],
  ["file:/srv/outside.tgz", ""],
])("rejects Yarn Classic lockfile resolved source %s with header %s before execution", async (source, header) => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.22" }));
  await writeFile(join(root, "yarn.lock"), `${header}\n"unsafe@1.0.0":\n  version "1.0.0"\n  resolved ${JSON.stringify(source)}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it.each(["classic", "modern"])("accepts safe %s Yarn lockfile sources", async format => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: format === "classic" ? "yarn@1.22.22" : "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), format === "classic"
    ? '# yarn lockfile v1\n\n"safe@^1.0.0", "safe@~1.0.0":\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/safe/-/safe-1.0.0.tgz"\n'
    : '__metadata:\n  version: 8\n\n"safe@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "safe@npm:1.0.0"\n');
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it("allows unrelated external symlinks during dependency validation", async () => {
  const root = await fixture();
  await symlink(tmpdir(), join(root, "docs-link"));
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it.each([
  "http://127.0.0.1/private.tgz", "https://10.0.0.1/private.tgz", "https://[::1]/private.tgz",
  "https://registry.npmjs.org.attacker.example/package.tgz", "https://registry.npmjs.org@127.0.0.1/package.tgz",
  "https://registry.npmjs.org:4443/package.tgz", "git+ssh://git@127.0.0.1/private.git",
  "https:\\127.0.0.1\\private.tgz", "https:/127.0.0.1/private.tgz", "https:%5c%5c127.0.0.1%5cprivate.tgz",
])("rejects untrusted dependency URL %s in manifests and lockfiles before execution", async source => {
  for (const input of ["manifest", "lockfile"]) {
    const root = await fixture();
    if (input === "manifest") await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { unsafe: source } }));
    else await writeFile(join(root, "pnpm-lock.yaml"), `packages:\n  unsafe:\n    resolution:\n      tarball: ${JSON.stringify(source)}\n`);
    await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/trusted HTTPS/);
    await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
  }
});

it.each(["abc123", ""])("accepts Yarn virtual peer locators with entropy %s and a supported nested source", async entropy => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), `__metadata:\n  version: 8\n"safe@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "safe@virtual:${entropy}#npm:1.0.0"\n`);
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it.each(["package-lock.json", "npm-shrinkwrap.json"])("accepts npm workspace link targets in %s", async lockfile => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await mkdir(join(root, "packages/a"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.6.3", workspaces: ["packages/*"] }));
  await writeFile(join(root, "packages/a/package.json"), JSON.stringify({ name: "a", version: "1.0.0" }));
  await writeFile(join(root, lockfile), JSON.stringify({ lockfileVersion: 3, packages: { "": { workspaces: ["packages/*"] }, "node_modules/a": { resolved: "packages/a", link: true }, "packages/a": { version: "1.0.0" } } }));
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it.each(["package-lock.json", "npm-shrinkwrap.json"])("fingerprints nested npm package links in %s", async lockfile => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await mkdir(join(root, "vendor/fixtures/local"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.6.3" }));
  await writeFile(join(root, "vendor/fixtures/local/package.json"), JSON.stringify({ name: "local", version: "1.0.0", bin: { local: "index.js" } }));
  await writeFile(join(root, "vendor/fixtures/local/index.js"), "export const value = 1\n");
  await writeFile(join(root, lockfile), JSON.stringify({ lockfileVersion: 3, packages: { "packages/app/node_modules/local": { resolved: "vendor/fixtures/local", link: true } } }));
  await installGitHubPullRequestWorkspace(root);
  await assertGitHubDependenciesCurrent(root);
  await writeFile(join(root, "vendor/fixtures/local/index.js"), "export const value = 2\n");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it.each(["../outside", "/srv/outside", "https://registry.npmjs.org/a.tgz"])("rejects npm workspace links outside the checkout: %s", async target => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.6.3" }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": { resolved: target, link: true } } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local|checkout-relative/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it.each(["exec:./script.js", "http://registry.npmjs.org/unsafe.tgz", "file:/srv/outside.tgz"])("rejects Yarn virtual locators wrapping %s", async source => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), `__metadata:\n  version: 8\n"unsafe@npm:1.0.0":\n  version: 1.0.0\n  resolution: ${JSON.stringify(`unsafe@virtual:abc123#${source}`)}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/protocol|Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it.each(["registry.npmjs.org", "registry.yarnpkg.com", "pkg.pr.new"])("accepts dependency downloads from %s", async host => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { safe: `https://${host}/safe.tgz` } }));
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it.each(["packages/*", "packages/*/*"])("rejects an external symlink matched by workspace glob %s", async pattern => {
  const root = await fixture();
  await mkdir(join(root, "packages"));
  await symlink(tmpdir(), join(root, "packages", "outside"));
  await writeFile(join(root, "pnpm-workspace.yaml"), `packages:\n  - '${pattern}'\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it.each(["pnpm", "manifest"])("rejects escaped negated %s workspace globs before execution", async manager => {
  const root = await fixture();
  const packages = ["**", "!../../outside"];
  if (manager === "pnpm") await writeFile(join(root, "pnpm-workspace.yaml"), `packages: ${JSON.stringify(packages)}\n`);
  else {
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.6.3", workspaces: packages }));
  }
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it("preserves literal exclamation marks in file dependencies and safe workspace exclusions", async () => {
  const root = await fixture();
  await mkdir(join(root, "!local"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { local: "file:!local" } }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - '!packages/excluded'\n");
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it("uses the declared npm version rather than the host npm binary", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.1.0" }));
  await writeFile(join(root, "package-lock.json"), "{}");
  await installGitHubPullRequestWorkspace(root);
  expect(await readFile(join(root, ".git", "args.txt"), "utf8")).toBe("npm@11.1.0\nci\n--ignore-scripts\n--no-audit\n--no-fund\n");
});

it("rejects legacy npm versions with repository onload scripts before execution", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@6.14.18" }));
  await writeFile(join(root, "package-lock.json"), "{}");
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/npm 7 or newer/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});
it("serializes host installers while cancellation does not hold up later work", async () => {
  const first = await fixture();
  const second = await fixture();
  const third = await fixture();
  const marker = join(first, "installer-active");
  const sequence = join(first, "sequence");
  await writeFile(join(third, "bin", "corepack"), `#!/bin/sh
if ! mkdir '${marker}'; then exit 88; fi
trap 'rmdir "${marker}"' EXIT
printf '%s\n' "$HOME" >> '${sequence}'
sleep 0.15
mkdir -p node_modules
`, { mode: 0o755 });
  const abort = new AbortController();
  const running = installGitHubPullRequestWorkspace(first);
  await vi.waitFor(async () => expect(await readFile(sequence, "utf8")).toContain(first));
  const queued = vi.spyOn(abort.signal, "addEventListener");
  const cancelled = installGitHubPullRequestWorkspace(second, abort.signal);
  await vi.waitFor(() => expect(queued).toHaveBeenCalledWith("abort", expect.any(Function), { once: true }));
  abort.abort(new DOMException("Cancelled queued checkout", "AbortError"));
  await expect(cancelled).rejects.toThrow("Cancelled queued checkout");
  const last = installGitHubPullRequestWorkspace(third);
  await expect(running).resolves.toBeUndefined();
  await expect(last).resolves.toBeUndefined();
  expect((await readFile(sequence, "utf8")).trim().split("\n")).toEqual([first, third].map(root => join(root, ".git", "vitehub-install-home")));
  await expect(readFile(join(second, ".git", "args.txt"))).rejects.toThrow();
});

it("releases the installer slot after a failed predecessor", async () => {
  const first = await fixture();
  const second = await fixture();
  await writeFile(join(second, "bin", "corepack"), `#!/bin/sh
if [ "$HOME" = '${join(first, ".git", "vitehub-install-home")}' ]; then exit 7; fi
mkdir -p node_modules
`, { mode: 0o755 });
  const failed = installGitHubPullRequestWorkspace(first);
  const next = installGitHubPullRequestWorkspace(second);
  await expect(failed).rejects.toBeInstanceOf(GitHubWorkspaceInstallError);
  await expect(next).resolves.toBeUndefined();
});

it("does not queue dependency-free workspaces behind an active installer", async () => {
  const first = await fixture();
  const empty = await fixture();
  await rm(join(empty, "package.json"));
  const started = join(first, "started");
  const release = join(first, "release");
  await writeFile(join(empty, "bin", "corepack"), `#!/bin/sh
touch '${started}'
while [ ! -f '${release}' ]; do sleep 0.02; done
mkdir -p node_modules
`, { mode: 0o755 });
  const running = installGitHubPullRequestWorkspace(first);
  let completed = false;
  let skipped: Promise<void> | undefined;
  try {
    await vi.waitFor(async () => { await readFile(started); });
    skipped = installGitHubPullRequestWorkspace(empty).then(() => { completed = true; });
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 1000 });
  } finally {
    await writeFile(release, "");
    await Promise.all([running, skipped]);
  }
  await expect(readFile(join(empty, ".git", "vitehub-install.json"))).rejects.toThrow();
});

it("parks a queued installer before waiting can consume the repair pass lifetime", async () => {
  const first = await fixture();
  const second = await fixture();
  const started = join(first, "started");
  const release = join(first, "release");
  await writeFile(join(second, "bin", "corepack"), `#!/bin/sh
if [ "$HOME" = '${join(first, ".git", "vitehub-install-home")}' ]; then
  touch '${started}'
  while [ ! -f '${release}' ]; do sleep 0.02; done
fi
printf '%s\n' "$@" > "$HOME/../args.txt"
mkdir -p node_modules
`, { mode: 0o755 });
  const running = installGitHubPullRequestWorkspace(first);
  let queued: Promise<void> | undefined;
  try {
    await vi.waitFor(async () => { await readFile(started); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    queued = installGitHubPullRequestWorkspace(second);
    const observed = queued.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    // Let the real filesystem preflight finish before advancing queue time.
    for (let n = 0; n < 10; n++) await readFile(join(second, "package.json"));
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    expect(settled).toBe(true);
    expect(await observed).toBeInstanceOf(GitHubWorkspaceInstallError);
    await expect(readFile(join(second, ".git", "args.txt"))).rejects.toThrow();
  } finally {
    vi.useRealTimers();
    await writeFile(release, "");
    await Promise.allSettled([running, queued]);
  }
});

it.each(["cache", "cafile"])("rejects project npm %s paths before execution", async setting => {
  const root = await fixture();
  await writeFile(join(root, ".npmrc"), `${setting}=/srv/outside\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local|Unsupported project/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it.each(["modulesDir", "storeDir", "cacheDir"])("rejects project pnpm %s paths before execution", async setting => {
  const root = await fixture();
  await writeFile(join(root, "pnpm-workspace.yaml"), `${setting}: /srv/outside\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local|Unsupported project/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it("fingerprints supported project npm settings for dependency refresh", async () => {
  const root = await fixture();
  await writeFile(join(root, ".npmrc"), "node-linker=isolated\nhoist=false\npublic-hoist-pattern[]=\n");
  await installGitHubPullRequestWorkspace(root);
  await writeFile(join(root, ".npmrc"), "node-linker=isolated\nhoist=true\n");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it("installs npm shrinkwrap-only projects", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.1.0" }));
  await writeFile(join(root, "npm-shrinkwrap.json"), "{}");
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
  expect(await readFile(join(root, ".git", "args.txt"), "utf8")).toContain("npm@11.1.0\nci\n");
});

it.each(["file:/srv/app", "file:../../outside.tgz", "/srv/app", "file:%2fetc"])("rejects host dependency %s before execution", async source => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { unsafe: source } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});
it("validates decoded lockfile-only sources and workspace manifests", async () => {
  const root = await fixture();
  await writeFile(join(root, "pnpm-lock.yaml"), 'packages:\n  unsafe:\n    resolution:\n      tarball: "file:\\u002fsrv/app.tgz"\n');
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});
it("allows internal workspace links but rejects links through an external symlink", async () => {
  const root = await fixture();
  await mkdir(join(root, "packages", "local"), { recursive: true });
  await writeFile(join(root, "pnpm-lock.yaml"), "importers:\n  packages/local:\n    dependencies:\n      local:\n        version: link:../../packages/local\n");
  await installGitHubPullRequestWorkspace(root);
  await symlink(tmpdir(), join(root, "outside"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { unsafe: "file:./outside/local" } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
});
it("requires a dependency refresh after changing the installed graph", async () => {
  const root = await fixture();
  await installGitHubPullRequestWorkspace(root);
  await assertGitHubDependenciesCurrent(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { example: "1.0.0" } }));
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
  await installGitHubPullRequestWorkspace(root);
  await assertGitHubDependenciesCurrent(root);
});

it("rejects local sources in nested workspace manifests", async () => {
  const root = await fixture();
  await writeFile(join(root, "pnpm-workspace.yaml"), 'packages: ["packages/*"]\n');
  await mkdir(join(root, "packages", "local"), { recursive: true });
  await writeFile(join(root, "packages", "local", "package.json"), JSON.stringify({ dependencies: { unsafe: "file:../../../outside" } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});
it("requires dependency conflicts to be resolved before refreshing the merged graph", async () => {
  const root = await fixture();
  await writeFile(join(root, "pnpm-lock.yaml"), "<<<<<<< HEAD\nlockfileVersion: '9.0'\n=======\nlockfileVersion: '9.0'\n>>>>>>> main\n");
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Resolve dependency conflicts/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await installGitHubPullRequestWorkspace(root);
  await assertGitHubDependenciesCurrent(root);
});

it.each(["manifest", "lockfile"])("rejects Yarn executable fetch protocols in the %s before host execution", async location => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2", dependencies: { unsafe: location === "manifest" ? "exec:./script.js" : "1.0.0" } }));
  await writeFile(join(root, "yarn.lock"), '__metadata:\n  version: 8\n"unsafe@npm:1.0.0":\n  version: 1.0.0\n  resolution: "unsafe@exec:./script.js"\n');
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/protocol/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});
it.each([
  "git+https://github.com/acme/unsafe.git",
  "https://github.com/acme/unsafe.git",
  "https://github.com/acme/unsafe",
  "https://github.com/acme/unsafe/tarball/main",
  "acme/unsafe",
  "github:acme/unsafe",
])("rejects Yarn Git preparation source %s before host execution", async source => {
  for (const location of ["manifest", "lockfile"]) {
    const root = await fixture();
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2", ...(location === "manifest" ? { dependencies: { unsafe: source } } : {}) }));
    await writeFile(join(root, "yarn.lock"), location === "manifest" ? "" : `__metadata:\n  version: 8\n"unsafe@npm:1.0.0":\n  version: 1.0.0\n  resolution: ${JSON.stringify(`unsafe@${source}`)}\n`);
    await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/protocol|Git dependencies/);
    await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
  }
});
it("installs and fingerprints pnpm workspaces without a root manifest", async () => {
  const root = await fixture();
  await rm(join(root, "package.json"));
  await writeFile(join(root, "pnpm-workspace.yaml"), 'packages: ["packages/*"]\n');
  await mkdir(join(root, "packages/member"), { recursive: true });
  await writeFile(join(root, "packages/member/package.json"), '{}');
  await installGitHubPullRequestWorkspace(root);
  expect(await readFile(join(root, ".git", "args.txt"), "utf8")).toContain("pnpm@10.34.6");
  await assertGitHubDependenciesCurrent(root);
  await writeFile(join(root, "packages/member/package.json"), '{"dependencies":{"example":"1.0.0"}}');
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});
it.each(["pnpm", "npm", "yarn"])("validates only selected %s workspaces and ignores independent fixtures", async manager => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: `${manager}@${manager === "pnpm" ? "10.34.6" : manager === "npm" ? "11.6.3" : "4.9.2"}`, ...(manager === "pnpm" ? {} : { workspaces: ["packages/member"] }) }));
  if (manager === "pnpm") await writeFile(join(root, "pnpm-workspace.yaml"), 'packages: ["packages/*", "!packages/fixture"]\n');
  else {
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, manager === "npm" ? "package-lock.json" : "yarn.lock"), manager === "npm" ? "{}" : "__metadata:\n  version: 8\n");
  }
  for (const directory of ["test/fixtures", "packages/fixture", "packages/member"]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "package.json"), directory.endsWith("member") ? "{}" : '{"dependencies":{"unsafe":"exec:./script.js"}}');
    if (!directory.endsWith("member")) await writeFile(join(root, directory, ".npmrc"), "cache=/srv/outside");
  }
  await installGitHubPullRequestWorkspace(root);
  await writeFile(join(root, "packages/member/package.json"), '{"dependencies":{"unsafe":"exec:./script.js"}}');
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/protocol/);
});

it.each(["pnpm", "npm", "yarn"])("selects workspace membership from the active %s manager only", async manager => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: `${manager}@${manager === "pnpm" ? "10.34.6" : manager === "npm" ? "11.6.3" : "4.9.2"}`, workspaces: [manager === "pnpm" ? "fixtures/*" : "packages/*"] }));
  await writeFile(join(root, "pnpm-workspace.yaml"), `packages: ["${manager === "pnpm" ? "packages/*" : "fixtures/*"}"]\n`);
  if (manager !== "pnpm") {
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, manager === "npm" ? "package-lock.json" : "yarn.lock"), manager === "npm" ? "{}" : "__metadata:\n  version: 8\n");
  }
  for (const directory of ["packages/member", "fixtures/independent"]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "package.json"), directory.startsWith("packages/") ? "{}" : '{"dependencies":{"unsafe":"exec:./script.js"}}');
  }
  await installGitHubPullRequestWorkspace(root);
  await writeFile(join(root, "packages/member/package.json"), '{"dependencies":{"unsafe":"exec:./script.js"}}');
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/protocol/);
});

it("ignores the unused manifest workspace paths in a pnpm install", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", workspaces: ["../../unused"] }));
  await installGitHubPullRequestWorkspace(root);
});

it.each(["file:./local", "./local"])("validates referenced local packages from %s", async source => {
  const root = await fixture();
  await mkdir(join(root, "local"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { local: source } }));
  await writeFile(join(root, "local/package.json"), '{"dependencies":{"unsafe":"exec:./script.js"}}');
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/protocol/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});


it("accepts checkout-relative pnpm patches and fingerprints their contents", async () => {
  const root = await fixture();
  await mkdir(join(root, "patches"));
  const patch = join(root, "patches", "safe.patch");
  await writeFile(patch, "first patch\n");
  await writeFile(join(root, "pnpm-workspace.yaml"), "patchedDependencies:\n  safe@1.0.0: patches/safe.patch\n");
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npatchedDependencies:\n  safe@1.0.0:\n    hash: abc\n    path: patches/safe.patch\n");
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
  await writeFile(patch, "second patch\n");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it.each(["/srv/unsafe.patch", "../../unsafe.patch", "patches/external/unsafe.patch"])("rejects escaped pnpm patch path %s", async path => {
  const root = await fixture();
  await mkdir(join(root, "patches"));
  await symlink(tmpdir(), join(root, "patches", "external"));
  await writeFile(join(root, "pnpm-workspace.yaml"), `patchedDependencies:\n  safe@1.0.0: ${path}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it.each(["optional!builtin<compat/typescript>", "~/patches/safe.patch", "%7E%2Fpatches%2Fsafe.patch"])("accepts safe Yarn patch locator %s", async patchPath => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await mkdir(join(root, "patches"));
  await writeFile(join(root, "patches", "safe.patch"), "first patch\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  const locator = `safe@patch:safe@npm%3A1.0.0#${patchPath}::version=1.0.0&hash=abc`;
  await writeFile(join(root, "yarn.lock"), `__metadata:\n  version: 8\n${JSON.stringify(locator)}:\n  version: 1.0.0\n  resolution: ${JSON.stringify(locator)}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
  if (!patchPath.includes("builtin")) {
    await writeFile(join(root, "patches", "safe.patch"), "second patch\n");
    await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
  }
});

it("fingerprints checkout-relative archive dependencies", async () => {
  const root = await fixture();
  await mkdir(join(root, "vendor"));
  const archive = join(root, "vendor", "pkg.tgz");
  await writeFile(archive, "first archive");
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { local: "file:./vendor/pkg.tgz" } }));
  await installGitHubPullRequestWorkspace(root);
  await writeFile(archive, "second archive");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it("rejects workspace extglobs that select an external symlink", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "vitehub-external-package-"));
  roots.push(outside);
  await writeFile(join(outside, "package.json"), JSON.stringify({ name: "outside" }));
  await mkdir(join(root, "packages", "local"), { recursive: true });
  await symlink(outside, join(root, "packages", "external"));
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.6.3", workspaces: ["packages/@(local|external)"] }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it("accepts a trusted GitHub release archive instead of preparing a Git repository", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { safe: "https://github.com/acme/pkg/releases/download/v1/pkg.tgz" } }));
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it("decodes a Yarn patch filename once and accepts grouped descriptors", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await mkdir(join(root, "patches"));
  await writeFile(join(root, "patches", "percent%25.patch"), "patch contents");
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2", description: "Not a dependency: patch:metadata#does-not-exist" }));
  const first = "safe@patch:safe@npm%3A1.0.0#~/patches/percent%2525.patch";
  const second = "safe@patch:safe@npm%3A1.0.0#optional!~/patches/percent%2525.patch";
  await writeFile(join(root, "yarn.lock"), `__metadata:\n  version: 8\n${JSON.stringify(`${first}, ${second}`)}:\n  version: 1.0.0\n  resolution: ${JSON.stringify(first)}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it.each([
  "safe@patch:safe@exec%3A./script.js#./patches/safe.patch",
  "safe@patch:safe@npm%3A1.0.0#/srv/unsafe.patch",
  "safe@patch:safe@npm%3A1.0.0#../../unsafe.patch",
])("rejects unsafe Yarn patch locator %s", async locator => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2", dependencies: { safe: locator } }));
  await writeFile(join(root, "yarn.lock"), "__metadata:\n  version: 8\n");
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Unsupported|Host-local/);
  await expect(readFile(join(root, ".git", "args.txt"))).rejects.toThrow();
});

it("fingerprints executable mode changes in local file directory dependencies", async () => {
  const root = await fixture();
  await mkdir(join(root, "local"));
  await writeFile(join(root, "package.json"), '{"dependencies":{"local":"file:./local"}}');
  await writeFile(join(root, "local/package.json"), '{}');
  const executable = join(root, "local/cli.js");
  await writeFile(executable, '#!/usr/bin/env node\n', { mode: 0o644 });
  await installGitHubPullRequestWorkspace(root);
  await chmod(executable, 0o755);
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it("fingerprints the source contents of local file directory dependencies", async () => {
  const root = await fixture();
  await mkdir(join(root, "vendor", "pkg"), { recursive: true });
  await writeFile(join(root, "vendor", "pkg", "package.json"), JSON.stringify({ name: "local", version: "1.0.0" }));
  await writeFile(join(root, "vendor", "pkg", "index.js"), "export const value = 1;");
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { local: "file:./vendor/pkg" } }));
  await installGitHubPullRequestWorkspace(root);
  await writeFile(join(root, "vendor", "pkg", "index.js"), "export const value = 2;");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it("decodes an encoded Yarn project-root patch selector before resolving it", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await mkdir(join(root, "patches"));
  await writeFile(join(root, "patches", "safe.patch"), "safe patch");
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  const locator = "safe@patch:safe@npm%3A1.0.0#%7E%2Fpatches%2Fsafe.patch::version=1.0.0&hash=abc";
  await writeFile(join(root, "yarn.lock"), `__metadata:\n  version: 8\n${JSON.stringify(locator)}:\n  version: 1.0.0\n  resolution: ${JSON.stringify(locator)}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it("rejects a Yarn patch relative to an unvalidated parent package filesystem", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await mkdir(join(root, "patches"));
  await writeFile(join(root, "patches", "safe.patch"), "checkout decoy");
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  const locator = "safe@patch:safe@npm%3A1.0.0#./patches/safe.patch::locator=parent%40npm%3A1.0.0";
  await writeFile(join(root, "yarn.lock"), `__metadata:\n  version: 8\n${JSON.stringify(locator)}:\n  version: 1.0.0\n  resolution: ${JSON.stringify(locator)}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/project.relative/);
});

it.each(["config", "missing/generated.js"])("rejects linked command targets inside canonical Git metadata: %s", async target => {
  const root = await fixture();
  await mkdir(join(root, "packages/local"), { recursive: true });
  await writeFile(join(root, ".git/config"), "protected Git configuration\n");
  await symlink("../../.git", join(root, "packages/local/meta"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { local: "link:./packages/local" } }));
  await writeFile(join(root, "packages/local/package.json"), JSON.stringify({ name: "local", bin: `meta/${target}` }));
  await expect(validateGitHubInstallInputs(root)).rejects.toThrow(/Git metadata/);
});

it("rejects symlinks inside copied local dependency contents", async () => {
  const root = await fixture();
  await mkdir(join(root, "vendor", "pkg"), { recursive: true });
  await writeFile(join(root, "vendor", "pkg", "package.json"), JSON.stringify({ name: "local", version: "1.0.0" }));
  await symlink(tmpdir(), join(root, "vendor", "pkg", "external"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { local: "file:./vendor/pkg" } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/regular files and directories/);
});

it("installs a private validated snapshot while the provider changes its checkout", async () => {
  const root = await fixture();
  await writeFile(join(root, ".npmrc"), "hoist=false\n");
  await writeFile(join(root, "bin", "corepack"), `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const checkout = ${JSON.stringify(root)};
writeFileSync(join(checkout, ".npmrc"), "cache=/srv/target\\n");
writeFileSync(join(checkout, "observed-config.txt"), readFileSync(".npmrc", "utf8"));
mkdirSync("node_modules", { recursive: true });
writeFileSync("node_modules/installed.txt", "snapshot dependencies");
`, { mode: 0o755 });
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Dependency inputs changed/);
  expect(await readFile(join(root, "observed-config.txt"), "utf8")).toBe("hoist=false\n");
  await expect(readFile(join(root, "node_modules", "installed.txt"))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "failed" });
});

it("runs package managers from a snapshot inside protected Git metadata", async () => {
  const root = await fixture();
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\npwd > "$HOME/../install-cwd.txt"\nmkdir -p node_modules\n', { mode: 0o755 });
  await installGitHubPullRequestWorkspace(root);
  const directory = (await readFile(join(root, ".git", "install-cwd.txt"), "utf8")).trim();
  expect(directory).toMatch(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.git/vitehub-dependency-snapshot-`));
});

it("keeps cached CommonJS managers executable in an ESM checkout", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@10.34.6" }));
  await writeFile(join(root, "bin", "corepack"), `#!/bin/sh
set -e
mkdir -p "$HOME/.cache" node_modules
printf 'require("node:util");' > "$HOME/.cache/manager.js"
node "$HOME/.cache/manager.js"
`, { mode: 0o755 });
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it("publishes refreshed dependencies and keeps workspace source links live", async () => {
  const root = await fixture();
  await mkdir(join(root, "packages", "local"), { recursive: true });
  await writeFile(join(root, "packages", "local", "package.json"), JSON.stringify({ name: "local", version: "1.0.0" }));
  await writeFile(join(root, "packages", "local", "index.js"), "export const value = 1;");
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nmkdir -p node_modules packages/local/node_modules\nprintf installed > packages/local/node_modules/installed.txt\nln -s ../packages/local node_modules/local\n');
  await installGitHubPullRequestWorkspace(root);
  expect(await readFile(join(root, "packages", "local", "node_modules", "installed.txt"), "utf8")).toBe("installed");
  await writeFile(join(root, "packages", "local", "index.js"), "export const value = 2;");
  expect(await readFile(join(root, "node_modules", "local", "index.js"), "utf8")).toBe("export const value = 2;");
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
});

it("removes obsolete root and workspace outputs when switching to and from Yarn PnP", async () => {
  const root = await fixture();
  const workspace = join(root, "packages", "local");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "local", version: "1.0.0" }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nmkdir -p node_modules packages/local/node_modules\nprintf old > packages/local/node_modules/installed.txt\n');
  await installGitHubPullRequestWorkspace(root);
  await rm(join(root, "pnpm-lock.yaml"));
  await rm(join(root, "pnpm-workspace.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2", workspaces: ["packages/local"] }));
  await writeFile(join(root, "yarn.lock"), "__metadata:\n  version: 8\n");
  await mkdir(join(root, ".yarn", "releases"), { recursive: true });
  await writeFile(join(root, ".yarn", "releases", "keep.txt"), "source configuration");
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nprintf pnp > .pnp.cjs\nprintf loader > .pnp.loader.mjs\nprintf data > .pnp.data.json\nmkdir -p .yarn/cache .yarn/unplugged\nprintf state > .yarn/install-state.gz\n');
  await installGitHubPullRequestWorkspace(root);
  for (const path of [join(root, "node_modules"), join(workspace, "node_modules")])
    await expect(readFile(join(path, "installed.txt"))).rejects.toThrow();
  const { lstat } = await import("node:fs/promises");
  await expect(lstat(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(workspace, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();

  await rm(join(root, "yarn.lock"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6" }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nmkdir -p node_modules\n');
  await installGitHubPullRequestWorkspace(root);
  for (const path of [".pnp.cjs", ".pnp.loader.mjs", ".pnp.data.json", ".yarn/cache", ".yarn/unplugged", ".yarn/install-state.gz"])
    await expect(lstat(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, ".yarn", "releases", "keep.txt"), "utf8")).toBe("source configuration");
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
});

it("removes obsolete workspace output when the next install omits that workspace", async () => {
  const root = await fixture();
  await mkdir(join(root, "packages", "old", "node_modules"), { recursive: true });
  await writeFile(join(root, "packages", "old", "node_modules", "stale.txt"), "obsolete");
  await installGitHubPullRequestWorkspace(root);
  await expect(readFile(join(root, "packages", "old", "node_modules", "stale.txt"))).rejects.toThrow();
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
});

it.each(['~1.2.1', '~2.2.10 || ^3.0.0', '~1.2', '~1'])("accepts the registry semver range %s without treating it as a home path", async source => {
  const root = await fixture();
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.6', peerDependencies: { safe: source } }));
  await writeFile(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npackages:\n  safe@1.2.1:\n    peerDependencies:\n      peer: ${JSON.stringify(source)}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
  expect(await readFile(join(root, '.git', 'args.txt'), 'utf8')).toContain('pnpm@10.34.6');
});

it.each(['~/private', '~other/private', 'file:~/private', 'file:~1.2.1'])("continues rejecting the host home source %s", async source => {
  const root = await fixture();
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { unsafe: source } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local|Git dependencies/);
  await expect(readFile(join(root, '.git', 'args.txt'))).rejects.toThrow();
});

it("ignores workspace npmrc files during root npm installs but validates root config", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.6.3", workspaces: ["packages/*"] }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  await mkdir(join(root, "packages", "child"), { recursive: true });
  await writeFile(join(root, "packages", "child", "package.json"), JSON.stringify({ name: "child" }));
  await writeFile(join(root, "packages", "child", ".npmrc"), "registry=https://example.com\n");
  await installGitHubPullRequestWorkspace(root);
  await writeFile(join(root, "packages", "child", ".npmrc"), "cache=/outside\n");
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
  await writeFile(join(root, ".npmrc"), "cache=/outside\n");
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/configuration/);
});
