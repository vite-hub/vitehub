import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm"

import { workspaceHistorySchema } from "./history-schema.ts"

import type { RuntimeDrizzleDatabase } from "@vite-hub/database"
import type { HistoryIndex } from "./history-index.ts"

const { workspaceHistoryWorkspaces: workspaces, workspaceHistoryRefs: refs, workspaceHistoryRevisions: revisions, workspaceHistoryObjects: objects, workspaceHistoryMetadata: metadata } = workspaceHistorySchema

/** A SQLite, libSQL, or D1 Drizzle database with the tables of `workspaceHistorySchema`. */
export type SqliteHistoryDatabase = RuntimeDrizzleDatabase<Record<string, unknown>>

function activeObject(workspace: string, digest: string | ReturnType<typeof sql>) {
  return sql`${objects.workspace} = ${workspace} and ${objects.size} >= 0
    and ${objects.digest} >= ${digest} and ${objects.digest} < ${digest} || '.'`
}

function active(workspace: string) {
  return sql`exists (select 1 from ${workspaces} where ${workspaces.workspace} = ${workspace} and ${workspaces.deleted} = 0)`
}

/** Each write is one atomic batch. */
export function sqliteHistoryIndex(db: SqliteHistoryDatabase): HistoryIndex {
  const ref = async (workspace: string, name: string) => {
    const [row] = await db.select().from(refs).where(and(eq(refs.workspace, workspace), eq(refs.ref, name), active(workspace)))
    return row
  }
  return {
    async claim(current, legacy) {
      const [currentRows, legacyRows] = await db.batch([
        db.select({ workspace: workspaces.workspace }).from(workspaces).where(eq(workspaces.workspace, current)),
        db.select({ workspace: workspaces.workspace }).from(workspaces).where(eq(workspaces.workspace, legacy ?? current)),
        db.insert(workspaces).select(sql`
          select ${current}, 0
          where not exists (
            select 1 from ${workspaces} where ${workspaces.workspace} = ${legacy ?? current}
          )
        `).onConflictDoNothing(),
      ])
      return currentRows[0]?.workspace ?? legacyRows[0]?.workspace ?? current
    },

    async deleted(workspace) {
      const [row] = await db.select({ deleted: workspaces.deleted }).from(workspaces).where(eq(workspaces.workspace, workspace))
      return row?.deleted
    },

    ref,

    async heads(workspace) {
      const heads = await db.select({ ref: refs.ref, head: refs.head }).from(refs)
        .where(and(eq(refs.workspace, workspace), isNotNull(refs.head), active(workspace)))
      if (!heads.length) return []
      const rows = await db.select().from(revisions).where(and(
        eq(revisions.workspace, workspace), eq(revisions.committed, true), inArray(revisions.id, heads.map(row => row.head!)), active(workspace),
      ))
      const byId = new Map(rows.map(row => [row.id, row]))
      return heads.flatMap(({ ref, head }) => {
        const revision = byId.get(head!)
        return revision ? [{ ref, revision }] : []
      })
    },

    async revision(workspace, id) {
      const [row] = await db.select().from(revisions).where(and(
        eq(revisions.workspace, workspace), eq(revisions.id, id), eq(revisions.committed, true), active(workspace),
      ))
      return row
    },

    async list(workspace, { ref, before, path, limit }) {
      const previousEntries = sql`
        coalesce((
          select previous.entries
          from ${revisions} as previous
          where previous.workspace = ${revisions.workspace}
            and previous.id = ${revisions.parentId}
            and previous.committed = 1
        ), '{}')
      `
      const pathFilter = path === undefined ? undefined : sql`(
        exists (
          select 1
          from json_each(${revisions.entries}) as current_file
          left join json_each(${previousEntries}) as previous_file
            on previous_file.key = current_file.key
          where (current_file.key = ${path} or substr(current_file.key, 1, length(${path}) + 1) = ${path} || '/')
            and (
              previous_file.key is null
              or json_extract(current_file.value, '$.digest') is not json_extract(previous_file.value, '$.digest')
              or json_extract(current_file.value, '$.size') is not json_extract(previous_file.value, '$.size')
              or json_extract(current_file.value, '$.mediaType') is not json_extract(previous_file.value, '$.mediaType')
              or json_extract(current_file.value, '$.metadata') is not json_extract(previous_file.value, '$.metadata')
            )
        )
        or exists (
          select 1
          from json_each(${previousEntries}) as previous_file
          left join json_each(${revisions.entries}) as current_file
            on current_file.key = previous_file.key
          where (previous_file.key = ${path} or substr(previous_file.key, 1, length(${path}) + 1) = ${path} || '/')
            and current_file.key is null
        )
      )`
      return await db.select().from(revisions).where(and(
        eq(revisions.workspace, workspace), eq(revisions.ref, ref), eq(revisions.committed, true),
        before === undefined ? undefined : lt(revisions.sequence, before),
        pathFilter,
        active(workspace),
      )).orderBy(desc(revisions.sequence)).limit(limit)
    },

    async usage(workspace) {
      const [result] = await db.values<[number, number]>(sql`
        select coalesce(sum(size), 0) as bytes, count(*) as objects from (
          select distinct json_extract(file.value, '$.digest') as digest,
            json_extract(file.value, '$.size') as size
          from ${revisions}, json_each(${revisions.entries}) as file
          where ${revisions.workspace} = ${workspace} and ${revisions.committed} = 1
            and ${active(workspace)}
        )
      `)
      return { bytes: result?.[0] ?? 0, objects: result?.[1] ?? 0 }
    },

    async objectKey(workspace, digest) {
      const [object] = await db.select({ key: objects.digest }).from(objects).where(activeObject(workspace, digest)).limit(1)
      return object?.key
    },

    async register(workspace, registry) {
      await db.insert(objects).select(sql`
        select ${workspaces.workspace}, json_extract(object.value, '$.key'), json_extract(object.value, '$.size')
        from ${workspaces}, json_each(${JSON.stringify(registry)}) as object
        where ${workspaces.workspace} = ${workspace} and ${workspaces.deleted} = 0
          and not exists (select 1 from ${objects} where ${activeObject(workspace, sql`json_extract(object.value, '$.digest')`)})
      `).onConflictDoNothing()
    },

    async objectKeys(workspace, digests) {
      return await db.values<[digest: string, key: string]>(sql`
        select needed.value, ${objects.digest}
        from json_each(${JSON.stringify(digests)}) as needed join ${objects} on ${activeObject(workspace, sql`needed.value`)}
      `)
    },

    async hasObject(workspace, key) {
      const [row] = await db.select({ key: objects.digest }).from(objects).where(and(eq(objects.workspace, workspace), eq(objects.digest, key), sql`${objects.size} >= 0`)).limit(1)
      return row !== undefined
    },

    async publish(workspace, { revision: row, ifHead, ifHeads, keys, complete }) {
      const objectsReady = sql`${complete} and not exists (
        select 1 from json_each(${JSON.stringify(keys)}) as verified
        where not exists (
          select 1 from ${objects}
          where ${objects.workspace} = ${workspace} and ${objects.digest} = verified.value and ${objects.size} >= 0
        )
      )`
      const [, , changed] = await db.batch([
        db.insert(refs).select(sql`
          select ${workspaces.workspace}, ${row.ref}, null, 0
          from ${workspaces} where ${workspaces.workspace} = ${workspace} and ${workspaces.deleted} = 0 and ${objectsReady}
        `).onConflictDoNothing(),
        db.insert(revisions).select(sql`
          select ${row.workspace}, ${row.id}, ${row.ref}, ${row.parentId}, ${row.sequence}, ${row.createdAt},
            ${row.message}, ${row.metadata === null ? null : JSON.stringify(row.metadata)},
            ${row.files}, ${row.bytes}, ${JSON.stringify(row.entries)}, 0
          from ${workspaces} where ${workspaces.workspace} = ${workspace} and ${workspaces.deleted} = 0 and ${objectsReady}
        `).onConflictDoNothing(),
        db.update(refs).set({ head: row.id, sequence: sql`${refs.sequence} + 1` }).where(and(
          eq(refs.workspace, workspace),
          eq(refs.ref, row.ref),
          sql`${refs.head} is ${ifHead}`,
          ...ifHeads.map(([expectedRef, expectedHead]) => expectedHead === null
            ? sql`(not exists (select 1 from ${refs} as cross_ref where cross_ref.workspace = ${workspace} and cross_ref.ref = ${expectedRef}) or exists (select 1 from ${refs} as cross_ref where cross_ref.workspace = ${workspace} and cross_ref.ref = ${expectedRef} and cross_ref.head is null))`
            : sql`exists (select 1 from ${refs} as cross_ref where cross_ref.workspace = ${workspace} and cross_ref.ref = ${expectedRef} and cross_ref.head is ${expectedHead})`),
          objectsReady,
          active(workspace),
        )).returning({ head: refs.head }),
        db.update(revisions).set({ committed: true }).where(and(eq(revisions.workspace, workspace), eq(revisions.id, row.id), sql`exists (select 1 from ${refs} where ${refs.workspace} = ${workspace} and ${refs.ref} = ${row.ref} and ${refs.head} = ${row.id})`, active(workspace))),
      ])
      return changed.length > 0
    },

    async deleteRef(workspace, ref, head) {
      const sameHead = sql`exists (select 1 from ${refs} where ${refs.workspace} = ${workspace} and ${refs.ref} = ${ref} and ${refs.head} is ${head})`
      const [, , removed] = await db.batch([
        db.update(objects).set({ size: -1 }).where(and(
          eq(objects.workspace, workspace),
          sql`${objects.size} >= 0`,
          sameHead,
          sql`substr(${objects.digest}, 1, 64) in (
            select json_extract(file.value, '$.digest')
            from ${revisions}, json_each(${revisions.entries}) as file
            where ${revisions.workspace} = ${workspace} and ${revisions.ref} = ${ref}
          )`,
          sql`substr(${objects.digest}, 1, 64) not in (
            select json_extract(file.value, '$.digest')
            from ${revisions}, json_each(${revisions.entries}) as file
            where ${revisions.workspace} = ${workspace} and ${revisions.ref} <> ${ref} and ${revisions.committed} = 1
          )`,
        )),
        db.delete(revisions).where(and(eq(revisions.workspace, workspace), eq(revisions.ref, ref), sameHead)),
        db.delete(refs).where(and(eq(refs.workspace, workspace), eq(refs.ref, ref), sql`${refs.head} is ${head}`)).returning({ ref: refs.ref }),
      ])
      return removed.length > 0
    },

    async markedObjects(workspace) {
      const rows = await db.select({ key: objects.digest }).from(objects).where(and(eq(objects.workspace, workspace), sql`${objects.size} < 0`))
      return rows.map(row => row.key)
    },

    async dropMarkedObjects(workspace, keys) {
      await db.delete(objects).where(and(eq(objects.workspace, workspace), inArray(objects.digest, keys), sql`${objects.size} < 0`))
    },

    async tombstone(workspace) {
      await db.batch([
        db.update(workspaces).set({ deleted: true }).where(eq(workspaces.workspace, workspace)),
        db.delete(refs).where(eq(refs.workspace, workspace)),
      ])
    },

    async objects(workspace) {
      const rows = await db.select({ key: objects.digest }).from(objects).where(eq(objects.workspace, workspace))
      return rows.map(row => row.key)
    },

    async purge(workspace) {
      await db.batch([
        db.delete(revisions).where(eq(revisions.workspace, workspace)),
        db.delete(objects).where(eq(objects.workspace, workspace)),
        db.delete(metadata).where(eq(metadata.workspace, workspace)),
      ])
    },

    async getMeta(workspace, key) {
      const [row] = await db.select().from(metadata).where(and(eq(metadata.workspace, workspace), eq(metadata.key, key), active(workspace)))
      return row?.value
    },

    async setMeta(workspace, key, value) {
      await db.insert(metadata).select(db.select({
        workspace: sql<string>`${workspace}`.as("workspace"), key: sql<string>`${key}`.as("key"), value: sql<unknown>`${JSON.stringify(value)}`.as("value"),
      }).from(workspaces).where(and(eq(workspaces.workspace, workspace), eq(workspaces.deleted, false)))).onConflictDoUpdate({ target: [metadata.workspace, metadata.key], set: { value: sql`${JSON.stringify(value)}` } })
    },

    async deleteMeta(workspace, key) {
      await db.delete(metadata).where(and(eq(metadata.workspace, workspace), eq(metadata.key, key)))
    },
  }
}
