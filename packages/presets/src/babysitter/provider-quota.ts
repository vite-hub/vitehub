/** Inbox metadata that keeps quota breakers durable across restarts. */
export interface QuotaStore {
  metaNumber(key: string): Promise<number | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export const providerBlockedKey = "provider-quota-blocked-until";
export const providerStrikesKey = "provider-quota-strikes";
export const forgeBlockedKey = "forge-quota-blocked-until";

/** The longest provider cooldown, and the forge cooldown. */
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

/** A GitHub rate limit stops every forge request until it resets. */
export interface ForgeQuota {
  blockedUntil(): Promise<number>;
  block(): Promise<number>;
}

export function createForgeQuota(store: QuotaStore, now: () => number = Date.now): ForgeQuota {
  const blockedUntil = async () => await store.metaNumber(forgeBlockedKey) ?? 0;
  return {
    blockedUntil,
    async block() {
      const until = Math.max(await blockedUntil(), now() + maxQuotaCooldownMs);
      await store.setMeta(forgeBlockedKey, until);
      return until;
    },
  };
}
