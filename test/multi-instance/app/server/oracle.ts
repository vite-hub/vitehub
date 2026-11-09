import postgres from "postgres"

// The oracle records what happened with its own Postgres client, so a check does not trust the primitive it tests.
const sql = postgres(process.env.MULTI_INSTANCE_ORACLE_URL ?? "", { max: 4, onnotice: () => {} })

export const instance = process.env.MULTI_INSTANCE_NAME ?? "unknown"

export async function record(kind: string, key: string) {
  await sql`insert into oracle_events (kind, key, instance) values (${kind}, ${key}, ${instance})`
}
