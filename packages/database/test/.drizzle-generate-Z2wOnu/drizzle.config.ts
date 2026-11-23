export default {
  dialect: 'sqlite',
  out: './migrations',
  schema: './schema.ts',
  dbCredentials: { url: 'file:.vitehub/data/database/sqlite.db' },
}
