export function getVercelSchedulePath(name: string): string {
  return `/api/vitehub/schedules/vercel/${name.replace(/[^a-z0-9/_-]+/gi, "_")}`
}
