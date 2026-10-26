import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"

import { defineComments, installComments } from "../src/index.ts"

import type { CommentsDatabase } from "../src/store.ts"
import type { CommentAnchor, DefineCommentsOptions } from "../src/types.ts"

/** The SQL that `vitehub db generate` writes for `commentsSchema`. */
export const commentsMigration = `
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

export async function createDatabase(): Promise<CommentsDatabase> {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(commentsMigration)
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  return drizzle(client) as unknown as CommentsDatabase
}

export async function createComments(options: DefineCommentsOptions = {}) {
  const comments = defineComments(options)
  installComments(comments, { database: await createDatabase() })
  return comments
}

export const anchor: CommentAnchor = {
  selector: "main > h1",
  label: "h1 Pricing",
  x: 500,
  y: 250,
  page: { x: 200, y: 120 },
  viewport: { width: 1280 },
}

export const ada = { id: "ada", name: "Ada" }
export const grace = { id: "grace", name: "Grace" }
