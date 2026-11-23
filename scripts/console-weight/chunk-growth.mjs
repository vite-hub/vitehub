export function chunkGrowth(offChunks, onChunks) {
  const unmatchedOff = new Map(Object.entries(offChunks))
  const unmatchedOn = new Map(Object.entries(onChunks))
  for (const [name, chunk] of unmatchedOn) {
    if (unmatchedOff.get(name)?.fingerprint !== chunk.fingerprint) continue
    unmatchedOff.delete(name)
    unmatchedOn.delete(name)
  }

  const namesByFingerprint = new Map()
  for (const [name, { fingerprint }] of unmatchedOff) {
    if (!namesByFingerprint.has(fingerprint)) namesByFingerprint.set(fingerprint, { shared: [], renamed: [] })
    const names = namesByFingerprint.get(fingerprint)
    const candidates = unmatchedOn.has(name) ? names.shared : names.renamed
    candidates.push(name)
  }
  for (const [name, { fingerprint }] of unmatchedOn) {
    const names = namesByFingerprint.get(fingerprint)
    const matchedName = names?.renamed.pop() ?? names?.shared.pop()
    if (matchedName === undefined) continue
    unmatchedOff.delete(matchedName)
    unmatchedOn.delete(name)
  }

  return [...unmatchedOn].flatMap(([name, chunk]) => {
    const before = unmatchedOff.get(name)?.owners ?? {}
    return Object.entries(chunk.owners).filter(([owner, bytes]) => bytes > (before[owner] ?? 0)).map(([owner, bytes]) => ({ chunk: name, owner, bytes: bytes - (before[owner] ?? 0), added: !Object.hasOwn(offChunks, name) }))
  })
}
