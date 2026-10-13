/**
 * Count retention reads about `maxRecords` rows to find its cutoff. Age retention reads only the rows it deletes.
 * Stores run the count limit on about 1 in `ceil(maxRecords / 100)` prunes, so the terminal record count
 * can exceed `maxRecords` by about 1% between runs. Limits of 100 or fewer apply on every prune.
 */
export function countRetentionDue(maxRecords: false | number): boolean {
  return maxRecords !== false && Math.random() * Math.ceil(maxRecords / 100) < 1
}
