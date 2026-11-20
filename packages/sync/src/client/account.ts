// The account of the signed-in user, so a write queued before the first pull already belongs to it.
import { accountOf } from "../canonical.ts"

let known: string | null = null

const provisionalPrefix = "user:"

function provisionalAccount(account: string): string {
  return `${provisionalPrefix}${account}`
}

function isProvisionalAccount(account: string | null): boolean {
  return account?.startsWith(provisionalPrefix) === true
}

/** The account of the user that `setSyncUser()` named, or `null`. */
function knownAccount(): string | null {
  return known
}

function setKnownUser(userId: string | null): boolean {
  const next = userId === null ? null : provisionalAccount(accountOf(userId))
  if (known === next) return false
  known = next
  return true
}

export { isProvisionalAccount, knownAccount, provisionalAccount, setKnownUser }
