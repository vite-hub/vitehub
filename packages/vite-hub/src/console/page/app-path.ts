/** The path of a page below the app base: `/portal/pricing/` under `/portal/` is `/pricing`, and `/portal` is `/`. */
export function appPathname(pathname: string, base: string): string {
  const prefix = base.replace(/\/+$/, "")
  const below = prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`)) ? pathname.slice(prefix.length) : pathname
  return below.length > 1 ? below.replace(/\/+$/, "") || "/" : below || "/"
}
