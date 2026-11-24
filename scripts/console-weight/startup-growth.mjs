const sum = sources => Object.values(sources).reduce((total, bytes) => total + bytes, 0)

export function startupGrowth(offSources, onSources) {
  const added = Object.entries(onSources).filter(([source]) => !Object.hasOwn(offSources, source)).map(([source, bytes]) => ({ source, bytes }))
  const grown = Object.entries(onSources).filter(([source, bytes]) => Object.hasOwn(offSources, source) && bytes > offSources[source]).map(([source, bytes]) => ({ source, bytes: bytes - offSources[source] }))
  const bySize = (a, b) => b.bytes - a.bytes || a.source.localeCompare(b.source)
  return { added: added.sort(bySize), grown: grown.sort(bySize), bytes: sum(onSources) - sum(offSources) }
}
