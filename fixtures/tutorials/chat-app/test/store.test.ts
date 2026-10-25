import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { textMessage } from "../shared/chat.ts";
import { openChatStore } from "../server/utils/store.ts";

test("history survives reopening, checks ownership, and rejects stale saves", () => {
  const directory = mkdtempSync(resolve(".chat-store-test-"));
  const filename = join(directory, "chat.sqlite");
  let store = openChatStore(filename);
  try {
    const thread = store.create("alice");
    const messages = [textMessage("user", "Hello"), textMessage("assistant", "Offline reply 1: Hello")];
    store.save("alice", thread.id, 0, messages);
    assert.equal(store.get("bob", thread.id), null);
    assert.deepEqual(store.list("bob"), []);
    assert.equal(store.remove("bob", thread.id), false);
    assert.throws(() => store.save("bob", thread.id, 1, []), /Chat changed/);
    assert.throws(() => store.save("alice", thread.id, 0, []), /Chat changed/);
    store.close();
    store = openChatStore(filename);
    assert.deepEqual(store.get("alice", thread.id)?.messages, messages);
    assert.equal(store.get("alice", thread.id)?.revision, 1);
    assert.equal(store.list("alice")[0]?.title, "Hello");
    assert.equal(store.remove("alice", thread.id), true);
    assert.equal(store.get("alice", thread.id), null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
