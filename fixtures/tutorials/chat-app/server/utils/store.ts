import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { threadSchema, type ChatMessage, type ThreadSummary } from "../../shared/chat.ts";

export function openChatStore(filename: string) {
  mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, messages TEXT NOT NULL DEFAULT '[]',
      updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chats_owner ON chats(owner, updated);
  `);

  function get(owner: string, id: string) {
    const row = db.prepare("SELECT * FROM chats WHERE owner = ? AND id = ?").get(owner, id);
    if (!row) return null;
    return threadSchema.parse({ ...row, messages: JSON.parse(String(row.messages)) });
  }

  return {
    get,
    list(owner: string): ThreadSummary[] {
      return db.prepare("SELECT id, title FROM chats WHERE owner = ? ORDER BY updated DESC")
        .all(owner).map(row => ({ id: String(row.id), title: String(row.title) }));
    },
    create(owner: string) {
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO chats (id, owner, title, updated) VALUES (?, ?, ?, ?)")
        .run(id, owner, "New chat", Date.now());
      return get(owner, id)!;
    },
    save(owner: string, id: string, revision: number, messages: ChatMessage[]) {
      const title = messages[0]?.parts[0]?.text.slice(0, 60) || "New chat";
      const result = db.prepare(`UPDATE chats SET title = ?, messages = ?,
        revision = revision + 1, updated = ? WHERE owner = ? AND id = ? AND revision = ?`)
        .run(title, JSON.stringify(messages), Date.now(), owner, id, revision);
      if (result.changes !== 1) throw new Error("Chat changed. Reload its saved history.");
    },
    remove(owner: string, id: string) {
      return db.prepare("DELETE FROM chats WHERE owner = ? AND id = ?").run(owner, id).changes === 1;
    },
    close() { db.close(); },
  };
}

let store: ReturnType<typeof openChatStore> | undefined;
export function chatStore() {
  return store ??= openChatStore(process.env.CHAT_DB_PATH || ".data/chat.sqlite");
}

// This tutorial runs one Node process. The revision check also rejects stale tabs.
export const activeChats = new Set<string>();
