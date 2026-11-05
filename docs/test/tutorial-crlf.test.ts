import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { expect, it } from "vitest";

import { buildRunnableTutorial, readWorkspaceVersions } from "../modules/tutorials/build";
import { runnableTutorials } from "../modules/tutorials/list";

it("builds the same tutorial from LF and CRLF Markdown", async () => {
  const docsRoot = resolve(import.meta.dirname, "..");
  const contentDir = await mkdtemp(resolve(tmpdir(), "vitehub-tutorial-crlf-"));
  const source = runnableTutorials[0]!;
  const input = {
    source,
    contentDir: resolve(docsRoot, "content"),
    fixturesDir: resolve(docsRoot, "../fixtures/tutorials"),
    versions: await readWorkspaceVersions(resolve(docsRoot, "..")),
  };
  try {
    for (const page of [source.page.slice(1), "docs/getting-started/installation"]) {
      const target = resolve(contentDir, `${page}.md`);
      await mkdir(dirname(target), { recursive: true });
      const markdown = await readFile(resolve(input.contentDir, `${page}.md`), "utf8");
      await writeFile(target, markdown.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"));
    }
    await expect(buildRunnableTutorial({ ...input, contentDir })).resolves.toEqual(await buildRunnableTutorial(input));
  }
  finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});
