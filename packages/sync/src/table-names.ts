/**
 * The schema keys of `syncSchema` and their SQL names. Its own module, so the Vite plugin lists the tables without
 * loading Drizzle during config resolution.
 */
export const syncTableNames: Readonly<Record<string, string>> = {
  syncChanges: "vitehub_sync_changes",
  syncMutations: "vitehub_sync_mutations",
  syncState: "vitehub_sync_state",
}
