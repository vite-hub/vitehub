import { normalizeKey } from "unstorage"

export function normalizeKVListPrefix(prefix = ""): string {
  const normalized = normalizeKey(prefix)
  const path = prefix.split("?")[0] ?? ""
  return normalized && /[:/\\]$/.test(path) ? `${normalized}:` : normalized
}
