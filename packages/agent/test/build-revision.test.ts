import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBuildRevision } from "../src/internal/build-revision.ts";

test("the package build revision tracks source changes with an unchanged manifest version", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-build-revision-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src", "internal"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.0.4" }));
  const source = join(root, "src", "internal", "provider.ts");
  await writeFile(source, "export const repaired = false;");
  const original = agentBuildRevision(root);
  assert.equal(agentBuildRevision(root), original, "a restart or unchanged rebuild must not wake work again");
  await mkdir(join(root, "test"));
  await writeFile(join(root, "test", "provider.test.ts"), "// Test-only changes are not a worker release.");
  assert.equal(agentBuildRevision(root), original);
  await writeFile(source, "export const repaired = true;");
  const repaired = agentBuildRevision(root);
  assert.notEqual(repaired, original);
  assert.equal(agentBuildRevision(root), repaired);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.0.4", dependencies: { provider: "2.0.0" } }));
  assert.notEqual(agentBuildRevision(root), repaired, "provider dependency updates must change the revision too");
});


for (const changed of ['lockfile', 'catalog', 'bundled source', 'transitive source', 'build config']) {
  test(`the recovery revision tracks resolved workspace ${changed} changes`, async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-workspace-revision-'));
    t.onTestFinished(() => rm(workspace, { recursive: true, force: true }));
    const root = join(workspace, 'packages', 'agent');
    for (const name of ['agent', 'internal', 'runtime', 'unrelated']) {
      const directory = join(workspace, 'packages', name);
      await mkdir(join(directory, 'src'), { recursive: true });
      await writeFile(join(directory, 'src', 'index.ts'), 'export const fixed = false;');
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name: `@vite-hub/${name}`, version: '0.0.4',
        ...(name === 'agent' ? { devDependencies: { '@vite-hub/internal': 'workspace:*' } } : {}),
        ...(name === 'internal' ? { dependencies: { '@vite-hub/runtime': 'workspace:*' } } : {}),
      }));
    }
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: [packages/*]\ncatalog: { provider: 1.0.0 }\n');
    await writeFile(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await writeFile(join(root, 'vite.config.ts'), 'export default { pack: {} };');
    const original = agentBuildRevision(root);
    await writeFile(join(workspace, 'packages', 'unrelated', 'src', 'index.ts'), 'export const fixed = true;');
    assert.equal(agentBuildRevision(root), original, 'unreferenced sibling sources are not a worker release');
    const files: Record<string, string> = {
      lockfile: join(workspace, 'pnpm-lock.yaml'),
      catalog: join(workspace, 'pnpm-workspace.yaml'),
      'bundled source': join(workspace, 'packages', 'internal', 'src', 'index.ts'),
      'transitive source': join(workspace, 'packages', 'runtime', 'src', 'index.ts'),
      'build config': join(root, 'vite.config.ts'),
    };
    await writeFile(files[changed]!, 'changed resolved build input');
    assert.notEqual(agentBuildRevision(root), original);
    assert.equal(agentBuildRevision(root), agentBuildRevision(root), 'unchanged rebuilds retain their revision');
  });
}
