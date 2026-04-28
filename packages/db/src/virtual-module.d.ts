declare module "virtual:@vitehub/db/config" {
  const config: {
    db: {
      connection: {
        url: string
      }
      drizzle: {
        casing?: "snake_case" | "camelCase"
      }
    }
  } | undefined
  export default config
}

declare module "virtual:@vitehub/db/schema" {
  const schema: Record<string, unknown>
  export default schema
}
