import { describe, expect, it, vi } from "vitest";
import { babysitterRepositories } from "../src/babysitter/repositories.ts";
import { PullRequestInbox } from "../src/babysitter/inbox/store.ts";

const installed = (repository: string, archived = false) => ({ repository, installationId: 1, archived });

describe("Babysitter repositories", () => {
  it("keeps an explicit allow list and never reads installations", async () => {
    const read = vi.fn(async () => [installed("acme/other")]);
    const repositories = babysitterRepositories({ repository: { allow: ["Acme/App"] } }, read);
    expect(repositories.source).toBe("allow");
    await expect(repositories.current()).resolves.toEqual(["acme/app"]);
    expect(repositories.observe("pull_request", { repository: { full_name: "acme/other" }, installation: { id: 1 } })).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(() => babysitterRepositories({ repository: { allow: ["not a repository"] } }, read)).toThrow(expect.objectContaining({ code: "PRESETS_BABYSITTER_REPOSITORIES_INVALID" }));
  });

  it("serves every installed repository except archived and denied ones", async () => {
    const read = vi.fn(async () => [installed("acme/app"), installed("Acme/Docs"), installed("acme/old", true), installed("acme/private")]);
    const repositories = babysitterRepositories({ repository: { deny: ["Acme/Private"] } }, read);
    expect(repositories.source).toBe("installations");
    await expect(repositories.current()).resolves.toEqual(["acme/app", "acme/docs"]);
  });

  it("reads installations again after the TTL or an installation event", async () => {
    let now = 0;
    let list = [installed("acme/app")];
    const read = vi.fn(async () => list);
    const repositories = babysitterRepositories({}, read, { ttlMs: 1000, now: () => now });
    await repositories.current();
    list = [installed("acme/app"), installed("acme/docs")];
    now = 999;
    await expect(repositories.current()).resolves.toEqual(["acme/app"]);
    now = 1000;
    await expect(repositories.current()).resolves.toEqual(["acme/app", "acme/docs"]);
    expect(read).toHaveBeenCalledTimes(2);

    // A delivery applies its own lists at once and makes the next read list the installations again.
    expect(repositories.observe("installation_repositories", { action: "removed", repositories_removed: [{ full_name: "acme/docs" }] })).toBe(true);
    expect(repositories.known()).toEqual(["acme/app"]);
    expect(repositories.observe("installation_repositories", { action: "added", repositories_added: [{ full_name: "acme/new" }] })).toBe(true);
    expect(repositories.known()).toEqual(["acme/app", "acme/new"]);
    list = [installed("acme/app"), installed("acme/new")];
    await expect(repositories.current()).resolves.toEqual(["acme/app", "acme/new"]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(repositories.observe("installation", { action: "deleted", repositories: [{ full_name: "acme/app" }, { full_name: "acme/new" }] })).toBe(true);
    expect(repositories.known()).toEqual([]);
  });

  it("adds a repository whose signed delivery arrives before the list has it", () => {
    const repositories = babysitterRepositories({ repository: { deny: ["acme/private"] } }, async () => []);
    expect(repositories.observe("pull_request", { repository: { full_name: "Acme/App" }, installation: { id: 1 } })).toBe(true);
    expect(repositories.observe("pull_request", { repository: { full_name: "acme/app" }, installation: { id: 1 } })).toBe(false);
    expect(repositories.observe("pull_request", { repository: { full_name: "acme/private" }, installation: { id: 1 } })).toBe(false);
    expect(repositories.observe("pull_request", { repository: { full_name: "acme/old", archived: true }, installation: { id: 1 } })).toBe(false);
    expect(repositories.known()).toEqual(["acme/app"]);
  });

  it("keeps the last list when the installation read fails", async () => {
    let fail = false;
    const repositories = babysitterRepositories({}, async () => {
      if (fail) throw new Error("GitHub is down");
      return [installed("acme/app")];
    }, { ttlMs: 0 });
    await repositories.current();
    fail = true;
    await expect(repositories.current()).rejects.toThrow("GitHub is down");
    expect(repositories.known()).toEqual(["acme/app"]);
  });

  it("lets the inbox admit deliveries from a repository that joins later", async () => {
    const repositories = babysitterRepositories({}, async () => []);
    const inbox = new PullRequestInbox({ path: ":memory:", repositories: () => repositories.known() });
    try {
      const delivery = { action: "opened", repository: { full_name: "acme/app" }, installation: { id: 1 }, pull_request: { number: 7, state: "open", head: { sha: "a".repeat(40), ref: "fix" }, base: { ref: "main" }, user: { login: "octocat" } } };
      await expect(inbox.ingest("before", "pull_request", delivery)).resolves.toMatchObject({ ignored: true, reason: "repository not configured" });
      repositories.observe("pull_request", delivery);
      await expect(inbox.ingest("after", "pull_request", delivery)).resolves.toMatchObject({ queued: [7] });
      expect((await inbox.all()).map(snapshot => `${snapshot.repository}#${snapshot.number}`)).toEqual(["acme/app#7"]);
    } finally {
      await inbox.close();
    }
  });
});
