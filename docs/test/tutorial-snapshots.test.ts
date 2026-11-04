import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readTutorialSnapshots } from "../modules/tutorials/snapshots";

it("disables cached snapshots and their public assets when explicitly requested", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "tutorial-snapshots-"));
  try {
    const snapshots = { "first-agent": ["/_tutorials/snapshots/old.0.bin"] };
    await mkdir(resolve(dir, "snapshots"));
    await writeFile(resolve(dir, "snapshots/old.0.bin"), "stale dependencies");
    await writeFile(resolve(dir, "snapshots.json"), JSON.stringify(snapshots));
    await writeFile(resolve(dir, "first-agent-starter.zip"), "starter");

    // Dev without an explicit opt-out can still reuse the last build.
    expect(await readTutorialSnapshots(dir)).toEqual(snapshots);
    expect(await readTutorialSnapshots(dir, { disabled: true })).toBeUndefined();
    expect(await readdir(dir)).toEqual(["first-agent-starter.zip"]);
    expect(await readFile(resolve(dir, "first-agent-starter.zip"), "utf8")).toBe("starter");
    expect(await readTutorialSnapshots(dir)).toBeUndefined();
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});
