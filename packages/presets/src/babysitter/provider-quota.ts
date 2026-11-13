/** Inbox metadata that keeps quota breakers durable across restarts. */
export interface QuotaStore {
  metaNumber(key: string): Promise<number | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export const providerBlockedKey = "provider-quota-blocked-until";
export const providerStrikesKey = "provider-quota-strikes";
export const forgeBlockedKey = "forge-quota-blocked-until";

/** The longest provider or forge cooldown. */
export const maxQuotaCooldownMs = 60 * 60_000;
/** A success removes a strike only this long after the last cooldown ended. */
const strikeRecoveryMs = 30 * 60_000;

export interface ProviderQuota {
  /** End of the current model cooldown, or 0. */
  blockedUntil(): Promise<number>;
  strikes(): Promise<number>;
  /**
   * Opens a cooldown of `cooldownMs × 2^(strikes - 1)`, capped at one hour. Passes that fail
   * together escalate it once: a call during an open cooldown changes nothing.
   */
  block(): Promise<void>;
  /** A model pass succeeded. It removes one strike when the last cooldown ended 30 minutes ago. */
  succeeded(): Promise<void>;
  /** Concurrent model passes after rate limits: halved per strike, never below two, never above `cap`. */
  modelLimit(ownerLimit: number, cap: number): Promise<number>;
}

/**
 * Provider rate limits are short throughput windows, not an exhausted quota. A model 429 closes
 * model admission only; host work such as merges continues. Capacity returns one strike at a time.
 */
export function createProviderQuota(store: QuotaStore, cooldownMs: number, now: () => number = Date.now): ProviderQuota {
  const maxStrikes = Math.max(1, Math.ceil(Math.log2(maxQuotaCooldownMs / Math.max(1, cooldownMs))) + 1);
  const blockedUntil = async () => await store.metaNumber(providerBlockedKey) ?? 0;
  const strikes = async () => await store.metaNumber(providerStrikesKey) ?? 0;
  return {
    blockedUntil,
    strikes,
    async block() {
      if (await blockedUntil() > now()) return;
      const next = Math.min(await strikes() + 1, maxStrikes);
      await store.setMeta(providerStrikesKey, next);
      await store.setMeta(providerBlockedKey, now() + Math.min(cooldownMs * 2 ** (next - 1), maxQuotaCooldownMs));
    },
    async succeeded() {
      // A few passes still succeed between 429 bursts. Removing a strike for each of them kept
      // the cooldown at its minimum, so only a success well after the last cooldown counts.
      const current = await strikes();
      if (current > 0 && now() - await blockedUntil() > strikeRecoveryMs) await store.setMeta(providerStrikesKey, current - 1);
    },
    async modelLimit(ownerLimit, cap) {
      const strikeCount = await strikes();
      return Math.min(cap, Math.max(Math.min(2, ownerLimit), Math.floor(ownerLimit / 2 ** strikeCount)));
    },
  };
}

/** A GitHub rate limit stops every forge request for a while. */
export interface ForgeQuota {
  blockedUntil(): Promise<number>;
  /**
   * Blocks until `resetAt`, GitHub's `x-ratelimit-reset` or `retry-after`, when it is within an hour.
   * Otherwise starts at five minutes and doubles for repeated blocks. Leaves an active block unchanged.
   */
  block(resetAt?: number): Promise<number>;
}

const forgeStrikesKey = "forge-quota-strikes";
const forgeLastBlockKey = "forge-quota-last-block";
const firstForgeCooldownMs = 5 * 60_000;
/** A block that starts this soon after the previous one counts as a repeat. */
const forgeRepeatMs = 2 * 60 * 60_000;
const maxForgeStrikes = Math.ceil(Math.log2(maxQuotaCooldownMs / firstForgeCooldownMs)) + 1;

/**
 * The error does not say when the limit resets, and a secondary limit lifts within minutes. A block
 * lasts five minutes and doubles while blocks repeat within two hours, up to an hour, so an
 * exhausted hourly quota still waits out its reset. An error during a block leaves the block as it is.
 */
export function createForgeQuota(store: QuotaStore, now: () => number = Date.now): ForgeQuota {
  const blockedUntil = async () => await store.metaNumber(forgeBlockedKey) ?? 0;
  return {
    blockedUntil,
    async block(resetAt) {
      const at = now();
      const current = await blockedUntil();
      if (current > at) return current;
      const repeated = at - (await store.metaNumber(forgeLastBlockKey) ?? 0) < forgeRepeatMs;
      const strikes = repeated ? Math.min((await store.metaNumber(forgeStrikesKey) ?? 0) + 1, maxForgeStrikes) : 1;
      const escalated = at + Math.min(firstForgeCooldownMs * 2 ** (strikes - 1), maxQuotaCooldownMs);
      // GitHub's reset time wins when it names one within the longest block. Never shorten a longer block.
      const until = Math.max(current, resetAt !== undefined && resetAt > at && resetAt < at + maxQuotaCooldownMs ? resetAt : escalated);
      await store.setMeta(forgeStrikesKey, strikes);
      await store.setMeta(forgeLastBlockKey, at);
      await store.setMeta(forgeBlockedKey, until);
      return until;
    },
  };
}
