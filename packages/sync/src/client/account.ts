// The account of the signed-in user, so a write queued before the first pull already belongs to it.
import { accountOf } from "../canonical.ts"

let known: string | null = null
let calls = 0

/** The account of the user that `setSyncUser()` named, or `null`. */
function knownAccount(): string | null {
  return known
}

async function setKnownUser(userId: string | null): Promise<void> {
  const call = ++calls
  // The writes queued while the account is worked out belong to nobody, not to the user before.
  known = null
  if (userId === null) return
  const account = await accountOf(userId)
  if (call === calls) known = account
}

export { knownAccount, setKnownUser }
