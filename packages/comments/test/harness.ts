import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"

import { defineComments } from "../src/index.ts"
import { installComments } from "../src/install.ts"
import { commentsTables } from "../src/tables.ts"

import type { CommentsDatabase } from "../src/operations-core/store.ts"
import type { DefineCommentsOptions, ElementAnchor } from "../src/types.ts"

/** The SQL of the live-site model, as `vitehub database generate` wrote it before one model, for migration fixtures. */
export const liveCommentsMigration = `
CREATE TABLE \`vitehub_comment_scope_counters\` (\`scope\` text PRIMARY KEY NOT NULL, \`last_number\` integer NOT NULL);
CREATE TABLE \`vitehub_comment_threads\` (\`id\` text PRIMARY KEY NOT NULL, \`scope\` text DEFAULT 'pages' NOT NULL, \`number\` integer DEFAULT 0 NOT NULL, \`page\` text NOT NULL, \`anchor\` text NOT NULL, \`context\` text, \`metadata\` text, \`status\` text NOT NULL, \`created_by\` text NOT NULL, \`resolved_by\` text, \`resolved_at\` integer, \`created_at\` integer NOT NULL, \`updated_at\` integer NOT NULL);
CREATE INDEX \`vitehub_comment_threads_page\` ON \`vitehub_comment_threads\` (\`page\`,\`status\`);
CREATE UNIQUE INDEX \`vitehub_comment_threads_number\` ON \`vitehub_comment_threads\` (\`scope\`,\`number\`);
CREATE INDEX \`vitehub_comment_threads_updated\` ON \`vitehub_comment_threads\` (\`updated_at\`);
CREATE TABLE \`vitehub_comments\` (\`id\` text PRIMARY KEY NOT NULL, \`thread_id\` text NOT NULL, \`body\` text NOT NULL, \`mentions\` text NOT NULL, \`author\` text NOT NULL, \`created_at\` integer NOT NULL, \`edited_at\` integer, FOREIGN KEY (\`thread_id\`) REFERENCES \`vitehub_comment_threads\`(\`id\`) ON UPDATE no action ON DELETE cascade);
CREATE INDEX \`vitehub_comments_thread\` ON \`vitehub_comments\` (\`thread_id\`,\`created_at\`);
CREATE TABLE \`vitehub_comment_forge\` (\`id\` text PRIMARY KEY NOT NULL, \`thread_id\` text, \`repository\` text NOT NULL, \`pull_request\` integer NOT NULL, \`remote_id\` text, \`node_id\` text, \`url\` text, \`digest\` text, \`posted_as\` text, \`minimized\` integer DEFAULT false NOT NULL, \`error\` text, \`updated_at\` integer NOT NULL);
CREATE INDEX \`vitehub_comment_forge_thread\` ON \`vitehub_comment_forge\` (\`thread_id\`);
CREATE INDEX \`vitehub_comment_forge_pull_request\` ON \`vitehub_comment_forge\` (\`repository\`,\`pull_request\`);
`

/** The SQL that creates the tables of `commentsSchema`. */
export const commentsMigration: string = commentsTables.map(statement => `${statement};`).join("\n")

export async function createDatabase(): Promise<CommentsDatabase> {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(commentsMigration)
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  return drizzle({ client }) as unknown as CommentsDatabase
}

/** Comments on an in-memory Database. Tests name their own policy; `{ authorize: undefined }` tests the default one. */
export async function createComments(options: DefineCommentsOptions = {}) {
  const comments = defineComments({ authorize: () => true, ...options })
  installComments(comments, { database: await createDatabase() })
  return comments
}

// The anchor that the overlay writes: an element anchor with every placement hint.
export const anchor = {
  kind: "element",
  selector: "main > h1",
  label: "h1 Pricing",
  x: 500,
  y: 250,
  page: { x: 200, y: 120 },
  viewport: { width: 1280 },
} satisfies ElementAnchor

export const ada = { id: "ada", name: "Ada" }
export const grace = { id: "grace", name: "Grace" }
