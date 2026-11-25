const sum = sources => Object.values(sources).reduce((total, bytes) => total + bytes, 0)
const startupBudget = 1000

export function startupGrowth({ sources: offSources, unmapped: offUnmapped }, { sources: onSources, unmapped: onUnmapped }) {
  const added = Object.entries(onSources).filter(([source]) => !Object.hasOwn(offSources, source)).map(([source, bytes]) => ({ source, bytes }))
  const grown = Object.entries(onSources).filter(([source, bytes]) => Object.hasOwn(offSources, source) && bytes > offSources[source]).map(([source, bytes]) => ({ source, bytes: bytes - offSources[source] }))
  const bySize = (a, b) => b.bytes - a.bytes || a.source.localeCompare(b.source)
  const bytes = sum(onSources) - sum(offSources)
  const unmappedBytes = onUnmapped - offUnmapped
  const result = added.length || bytes > startupBudget ? "FAIL" : bytes + unmappedBytes > startupBudget ? "INCONCLUSIVE" : "PASS"
  return { added: added.sort(bySize), grown: grown.sort(bySize), bytes, unmappedBytes, result }
}
