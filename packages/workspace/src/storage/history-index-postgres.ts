import { and, desc, eq, exists, getColumns, gte, inArray, isNotNull, isNull, lt, ne, notExists, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { sha256 } from "../core/path.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"
import { workspaceHistorySchema } from "./history-schema-postgres.ts"

import type { AnyRelations, SQL } from "drizzle-orm"
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { HistoryIndex, HistoryRevisionRow } from "./history-index.ts"
import type { HistoryFileIndex } from "./history-schema-postgres.ts"

const { workspaceHistoryWorkspaces: workspaces, workspaceHistoryRefs: refs, workspaceHistoryRevisions: revisions, workspaceHistoryObjects: objects, workspaceHistoryMetadata: metadata } = workspaceHistorySchema
const crossRef = alias(refs, "cross_ref")
const { fileIndex: _fileIndex, ...revisionColumns } = getColumns(revisions)

/** A Postgres Drizzle database with the tables of `workspaceHistorySchema` from `@vite-hub/workspace/blob-database/postgres`. */
export type PostgresHistoryDatabase = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>
type Transaction = Parameters<Parameters<PostgresHistoryDatabase["transaction"]>[0]>[0]

function active(workspace: string) {
  return sql`exists (select 1 from ${workspaces} where ${workspaces.workspace} = ${workspace} and not ${workspaces.deleted})`
}

const digestOf = sql`left(${objects.digest}, 64)`

function manifestDigests(where: SQL | undefined) {
  return sql`(select file.value->>'digest' from ${revisions} cross join lateral jsonb_each(${revisions.fileIndex}) as file where ${where})`
}

function textValues(values: string[]) {
  return sql`(select jsonb_array_elements_text(${JSON.stringify(values)}::text::jsonb))`
}

async function indexFiles(entries: HistoryRevisionRow["entries"]): Promise<HistoryFileIndex> {
  return Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([path, file]) => {
    const canonical = JSON.stringify(file, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, Reflect.get(value, key)]))
        : value)
    return [JSON.stringify(path), { digest: file.digest, size: file.size, fingerprint: await sha256(canonical) }] as const
  })))
}

async function lock(tx: Transaction, workspace: string): Promise<boolean> {
  const [row] = await tx.select({ deleted: workspaces.deleted }).from(workspaces).where(eq(workspaces.workspace, workspace)).for("update")
  return row !== undefined && !row.deleted
}

async function activeKeys(db: PostgresHistoryDatabase | Transaction, workspace: string, digests: string[]): Promise<Array<[string, string]>> {
  if (!digests.length) return []
  const rows = await db.select({ key: objects.digest }).from(objects)
    .where(and(eq(objects.workspace, workspace), gte(objects.size, 0), sql`${digestOf} in ${textValues(digests)}`))
  return rows.map(row => [row.key.slice(0, 64), row.key])
}

/** Each write is one transaction that locks the identity row. */
export function postgresHistoryIndex(db: PostgresHistoryDatabase): HistoryIndex {
  return {
    async claim(current, legacy) {
      try {
        const rows = await db.select({ workspace: workspaces.workspace }).from(workspaces)
          .where(inArray(workspaces.workspace, legacy === undefined ? [current] : [current, legacy]))
        if (rows.some(row => row.workspace === current)) return current
        if (legacy !== undefined && rows.some(row => row.workspace === legacy)) return legacy
        await db.insert(workspaces).values({ workspace: current }).onConflictDoNothing()
        return current
      }
      catch (error) {
        const cause: unknown = error instanceof Error ? error.cause : undefined
        if ([error, cause].some(value => value instanceof Error && "code" in value && value.code === "42P01")) {
          throw workspaceErrorDiagnostics.WORKSPACE_POSTGRES_HISTORY_SCHEMA_MISSING({ cause: error })
        }
        throw error
      }
    },

    async deleted(workspace) {
      const [row] = await db.select({ deleted: workspaces.deleted }).from(workspaces).where(eq(workspaces.workspace, workspace))
      return row?.deleted
    },

    async ref(workspace, ref) {
      const [row] = await db.select({ ref: refs.ref, head: refs.head, sequence: refs.sequence }).from(refs)
        .where(and(eq(refs.workspace, workspace), eq(refs.ref, ref), active(workspace)))
      return row
    },

    async heads(workspace) {
      const heads = await db.select({ ref: refs.ref, head: refs.head }).from(refs)
        .where(and(eq(refs.workspace, workspace), isNotNull(refs.head), active(workspace)))
      if (!heads.length) return []
      const rows = await db.select(revisionColumns).from(revisions).where(and(
        eq(revisions.workspace, workspace), eq(revisions.committed, true), sql`${revisions.id} in ${textValues(heads.map(row => row.head!))}`, active(workspace),
      ))
      const byId = new Map(rows.map(row => [row.id, row]))
      return heads.flatMap(({ ref, head }) => {
        const revision = byId.get(head!)
        return revision ? [{ ref, revision }] : []
      })
    },

    async revision(workspace, id) {
      const [row] = await db.select(revisionColumns).from(revisions).where(and(
        eq(revisions.workspace, workspace), eq(revisions.id, id), eq(revisions.committed, true), active(workspace),
      ))
      return row
    },

    async list(workspace, { ref, before, path, limit }) {
      const previousIndex = sql`coalesce((
        select previous.file_index from ${revisions} as previous
        where previous.workspace = ${revisions.workspace} and previous.id = ${revisions.parentId} and previous.committed
      ), '{}'::jsonb)`
      const encodedPath = JSON.stringify(path)
      const encodedPrefix = JSON.stringify(`${path}/`).slice(0, -1)
      const inPath = (key: SQL) => sql`(${key} = ${encodedPath} or starts_with(${key}, ${encodedPrefix}))`
      const pathFilter = path === undefined ? undefined : sql`(
        exists (
          select 1
          from jsonb_each(${revisions.fileIndex}) as current_file
          left join jsonb_each(${previousIndex}) as previous_file on previous_file.key = current_file.key
          where ${inPath(sql`current_file.key`)}
            and current_file.value is distinct from previous_file.value
        )
        or exists (
          select 1
          from jsonb_each(${previousIndex}) as previous_file
          where ${inPath(sql`previous_file.key`)} and not (${revisions.fileIndex} ? previous_file.key)
        )
      )`
      return await db.select(revisionColumns).from(revisions).where(and(
        eq(revisions.workspace, workspace), eq(revisions.ref, ref), eq(revisions.committed, true),
        before === undefined ? undefined : lt(revisions.sequence, before),
        pathFilter,
        active(workspace),
      )).orderBy(desc(revisions.sequence)).limit(limit)
    },

    async usage(workspace) {
      const [result] = await db.execute<{ bytes: number | string, objects: number | string }>(sql`
        select coalesce(sum(used.size), 0) as bytes, count(*) as objects from (
          select distinct file.value->>'digest' as digest, (file.value->>'size')::bigint as size
          from ${revisions} cross join lateral jsonb_each(${revisions.fileIndex}) as file
          where ${revisions.workspace} = ${workspace} and ${revisions.committed} and ${active(workspace)}
        ) as used
      `, "objects")
      return { bytes: Number(result?.bytes ?? 0), objects: Number(result?.objects ?? 0) }
    },

    async objectKey(workspace, digest) {
      const [object] = await db.select({ key: objects.digest }).from(objects)
        .where(and(eq(objects.workspace, workspace), gte(objects.size, 0), eq(digestOf, digest))).limit(1)
      return object?.key
    },

    async register(workspace, registry) {
      await db.transaction(async (tx) => {
        if (!await lock(tx, workspace)) return
        const registered = new Set((await activeKeys(tx, workspace, registry.map(object => object.digest))).map(([digest]) => digest))
        const missing = registry.filter(object => !registered.has(object.digest))
        if (missing.length) await tx.execute(sql`
          insert into ${objects} (workspace, digest, size)
          select ${workspace}, key, size from jsonb_to_recordset(${JSON.stringify(missing)}::text::jsonb) as entry(key text, size bigint)
          on conflict do nothing
        `)
      })
    },

    async objectKeys(workspace, digests) {
      return await activeKeys(db, workspace, digests)
    },

    async hasObject(workspace, key) {
      const [row] = await db.select({ key: objects.digest }).from(objects)
        .where(and(eq(objects.workspace, workspace), eq(objects.digest, key), gte(objects.size, 0))).limit(1)
      return row !== undefined
    },

    async publish(workspace, { revision, ifHead, ifHeads, keys, complete }) {
      if (!complete) return false
      const fileIndex = await indexFiles(revision.entries)
      return await db.transaction(async (tx) => {
        if (!await lock(tx, workspace)) return false
        const uploaded = [...new Set(keys)]
        if (uploaded.length) {
          const ready = await tx.select({ key: objects.digest }).from(objects)
            .where(and(eq(objects.workspace, workspace), sql`${objects.digest} in ${textValues(uploaded)}`, gte(objects.size, 0)))
          if (ready.length !== uploaded.length) return false
        }
        await tx.insert(refs).values({ workspace, ref: revision.ref }).onConflictDoNothing()
        await tx.insert(revisions).values({ ...revision, fileIndex, committed: false }).onConflictDoNothing()
        const crossHead = (ref: string, head: SQL) => tx.select({ ref: crossRef.ref }).from(crossRef)
          .where(and(eq(crossRef.workspace, workspace), eq(crossRef.ref, ref), head))
        const changed = await tx.update(refs).set({ head: revision.id, sequence: sql`${refs.sequence} + 1` }).where(and(
          eq(refs.workspace, workspace),
          eq(refs.ref, revision.ref),
          ifHead === null ? isNull(refs.head) : eq(refs.head, ifHead),
          ...ifHeads.map(([ref, head]) => head === null
            ? notExists(crossHead(ref, isNotNull(crossRef.head)))
            : exists(crossHead(ref, eq(crossRef.head, head)))),
        )).returning({ head: refs.head })
        if (!changed.length) return false
        await tx.update(revisions).set({ committed: true }).where(and(eq(revisions.workspace, workspace), eq(revisions.id, revision.id)))
        return true
      })
    },

    async deleteRef(workspace, ref, head) {
      return await db.transaction(async (tx) => {
        if (!await lock(tx, workspace)) return false
        const [current] = await tx.select({ head: refs.head }).from(refs).where(and(eq(refs.workspace, workspace), eq(refs.ref, ref)))
        if (!current || current.head !== head) return false
        await tx.update(objects).set({ size: -1 }).where(and(
          eq(objects.workspace, workspace),
          gte(objects.size, 0),
          sql`${digestOf} in ${manifestDigests(and(eq(revisions.workspace, workspace), eq(revisions.ref, ref)))}`,
          sql`${digestOf} not in ${manifestDigests(and(eq(revisions.workspace, workspace), ne(revisions.ref, ref), eq(revisions.committed, true)))}`,
        ))
        await tx.delete(revisions).where(and(eq(revisions.workspace, workspace), eq(revisions.ref, ref)))
        await tx.delete(refs).where(and(eq(refs.workspace, workspace), eq(refs.ref, ref)))
        return true
      })
    },

    async markedObjects(workspace) {
      const rows = await db.select({ key: objects.digest }).from(objects).where(and(eq(objects.workspace, workspace), lt(objects.size, 0)))
      return rows.map(row => row.key)
    },

    async dropMarkedObjects(workspace, keys) {
      if (!keys.length) return
      await db.delete(objects).where(and(eq(objects.workspace, workspace), sql`${objects.digest} in ${textValues(keys)}`, lt(objects.size, 0)))
    },

    async tombstone(workspace) {
      await db.transaction(async (tx) => {
        await tx.update(workspaces).set({ deleted: true }).where(eq(workspaces.workspace, workspace))
        await tx.delete(refs).where(eq(refs.workspace, workspace))
      })
    },

    async objects(workspace) {
      const rows = await db.select({ key: objects.digest }).from(objects).where(eq(objects.workspace, workspace))
      return rows.map(row => row.key)
    },

    async purge(workspace) {
      await db.transaction(async (tx) => {
        await tx.delete(revisions).where(eq(revisions.workspace, workspace))
        await tx.delete(objects).where(eq(objects.workspace, workspace))
        await tx.delete(metadata).where(eq(metadata.workspace, workspace))
      })
    },

    async getMeta(workspace, key) {
      const [row] = await db.select({ value: metadata.value }).from(metadata)
        .where(and(eq(metadata.workspace, workspace), eq(metadata.key, key), active(workspace)))
      return row?.value
    },

    async setMeta(workspace, key, value) {
      await db.transaction(async (tx) => {
        if (!await lock(tx, workspace)) return
        await tx.insert(metadata).values({ workspace, key, value: value === null ? sql`'null'::json` : value }).onConflictDoUpdate({ target: [metadata.workspace, metadata.key], set: { value: sql`excluded.value` } })
      })
    },

    async deleteMeta(workspace, key) {
      await db.delete(metadata).where(and(eq(metadata.workspace, workspace), eq(metadata.key, key)))
    },
  }
}
