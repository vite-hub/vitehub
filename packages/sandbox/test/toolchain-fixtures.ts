import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const fixtureNodeVersion = "22.1.0";
export const fixturePnpmVersion = "10.2.0";
export const fixtureYarnVersion = "4.1.0";

/** The platform suffix that the Sandbox toolchain detects on this test host. */
export function hostPlatformSuffix() {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  return `${os}-${process.arch}`;
}

export function hostIndexFile() {
  return process.platform === "darwin" ? `osx-${process.arch}-tar` : `linux-${process.arch}`;
}

/**
 * Serve a Node.js distribution and an npm registry from local fixtures.
 * Fake `node` prints its version and runs other scripts with `sh`.
 */
export async function startToolchainFixture(options: {
  nodeChecksum?: string;
  pnpmIntegrity?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-toolchain-fixture-"));
  const suffix = hostPlatformSuffix();
  const nodeArchive = `node-v${fixtureNodeVersion}-${suffix}.tar.gz`;
  const nodeDirectory = join(root, `node-v${fixtureNodeVersion}-${suffix}`);
  await mkdir(join(nodeDirectory, "bin"), { recursive: true });
  await writeExecutable(join(nodeDirectory, "bin", "node"), [
    "#!/bin/sh",
    "case \"$1\" in",
    `  -v|--version) echo v${fixtureNodeVersion} ;;`,
    "  *) script=$1; shift; exec sh \"$script\" \"$@\" ;;",
    "esac",
  ]);
  await execFileAsync("tar", ["-czf", join(root, nodeArchive), "-C", root, `node-v${fixtureNodeVersion}-${suffix}`]);
  const pnpmDirectory = join(root, "pnpm", "package");
  await mkdir(join(pnpmDirectory, "bin"), { recursive: true });
  await writeFile(join(pnpmDirectory, "package.json"), JSON.stringify({ name: "pnpm", version: fixturePnpmVersion }));
  await writeFile(join(pnpmDirectory, "bin", "pnpm.cjs"), `echo ${fixturePnpmVersion}\n`);
  await writeFile(join(pnpmDirectory, "bin", "pnpx.cjs"), "echo pnpx\n");
  await execFileAsync("tar", ["-czf", join(root, "pnpm.tgz"), "-C", join(root, "pnpm"), "package"]);
  const yarnDirectory = join(root, "yarn", "package");
  const yarnScript = `echo ${fixtureYarnVersion}\n`;
  await mkdir(join(yarnDirectory, "bin"), { recursive: true });
  await writeFile(join(yarnDirectory, "bin", "yarn.js"), yarnScript);
  await execFileAsync("tar", ["-czf", join(root, "yarn.tgz"), "-C", join(root, "yarn"), "package"]);
  const nodeBytes = await readFile(join(root, nodeArchive));
  const pnpmBytes = await readFile(join(root, "pnpm.tgz"));
  const yarnBytes = await readFile(join(root, "yarn.tgz"));
  const nodeChecksum = options.nodeChecksum ?? createHash("sha256").update(nodeBytes).digest("hex");
  const pnpmIntegrity = options.pnpmIntegrity ?? `sha512-${createHash("sha512").update(pnpmBytes).digest("base64")}`;
  const requests: string[] = [];
  const releases = ["23.0.0", "22.2.0", fixtureNodeVersion, "20.5.0"].map(version => ({
    files: [hostIndexFile()],
    lts: version.startsWith("22.") ? "Jod" : version.startsWith("20.") ? "Iron" : false,
    version: `v${version}`,
  }));
  const server = createServer((request, response) => {
    const path = request.url || "/";
    requests.push(path);
    const send = (body: string | Uint8Array, type = "application/octet-stream") => {
      response.writeHead(200, { "content-type": type });
      response.end(body);
    };
    if (path === "/dist/index.json") return send(JSON.stringify(releases), "application/json");
    if (path === `/dist/v${fixtureNodeVersion}/SHASUMS256.txt`) return send(`${nodeChecksum}  ${nodeArchive}\n0000  other.tar.gz\n`, "text/plain");
    if (path === `/dist/v${fixtureNodeVersion}/${nodeArchive}`) return send(nodeBytes);
    if (path === `/registry/pnpm/${fixturePnpmVersion}`) {
      return send(JSON.stringify({
        bin: { pnpm: "bin/pnpm.cjs", pnpx: "./bin/pnpx.cjs" },
        dist: { integrity: pnpmIntegrity, tarball: `${base}/registry/pnpm/-/pnpm-${fixturePnpmVersion}.tgz` },
        name: "pnpm",
        version: fixturePnpmVersion,
      }), "application/json");
    }
    if (path === "/registry/pnpm") {
      return send(JSON.stringify({ versions: { "9.0.0": {}, [fixturePnpmVersion]: {}, "11.0.0": {} } }), "application/json");
    }
    if (path === `/registry/pnpm/-/pnpm-${fixturePnpmVersion}.tgz`) return send(pnpmBytes);
    if (path === `/registry/@yarnpkg%2Fcli-dist/${fixtureYarnVersion}`) {
      return send(JSON.stringify({
        bin: { yarn: "bin/yarn.js", yarnpkg: "bin/yarn.js" },
        dist: { integrity: `sha512-${createHash("sha512").update(yarnBytes).digest("base64")}`, tarball: `${base}/registry/yarn.tgz` },
        name: "@yarnpkg/cli-dist",
        version: fixtureYarnVersion,
      }), "application/json");
    }
    if (path === "/registry/yarn.tgz") return send(yarnBytes);
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    environment: {
      VITEHUB_NODE_DIST_URL: `${base}/dist`,
      VITEHUB_NPM_REGISTRY_URL: `${base}/registry`,
    },
    nodeArchive,
    pnpmSha512Hex: createHash("sha512").update(pnpmBytes).digest("hex"),
    yarnSha512Hex: createHash("sha512").update(yarnScript).digest("hex"),
    requests,
    root,
    count(path: string) {
      return requests.filter(request => request === path).length;
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    },
  };
}

export async function writeExecutable(path: string, lines: readonly string[]) {
  await writeFile(path, `${lines.join("\n")}\n`);
  await chmod(path, 0o755);
}

/** A project directory with the given files. */
export async function writeProject(directory: string, files: Readonly<Record<string, string | object>>) {
  await mkdir(directory, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    await writeFile(join(directory, path), typeof contents === "string" ? contents : JSON.stringify(contents));
  }
}
