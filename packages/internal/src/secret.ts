const secretEncoder = new TextEncoder()

/**
 * Compares a request value with an expected secret in constant time for the length of `expected`. Returns `false`
 * when either value is missing or empty. It uses no Node API, so it also runs in Worker runtimes.
 */
export function isViteHubSecretEqual(actual: string | null | undefined, expected: string | null | undefined): boolean {
  if (!actual || !expected) return false
  const left = secretEncoder.encode(actual)
  const right = secretEncoder.encode(expected)
  let difference = left.length ^ right.length
  for (let index = 0; index < right.length; index += 1) difference |= (left[index] ?? 0) ^ right[index]!
  return difference === 0
}

/**
 * Compares the token of a `Bearer` `Authorization` header with an expected secret in constant time. The scheme is
 * case-insensitive. Returns `false` for another scheme or a missing value.
 */
export function isViteHubBearerSecretEqual(authorization: string | null | undefined, expected: string | null | undefined): boolean {
  return isViteHubSecretEqual(/^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1], expected)
}
