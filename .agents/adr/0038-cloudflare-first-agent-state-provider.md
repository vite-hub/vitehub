# Cloudflare-First Agent State Provider

ViteHub will design Agent State Provider as a provider-neutral runtime contract, but the first durable implementation may be Cloudflare-first because the immediate production failure is in Cloudflare-hosted Chat Webhook Autowiring. This keeps the API shaped for future providers while allowing the first implementation to replace the current community chat state backend with a built-in durable path.

## Considered Options

- Wrapping the current Chat SDK state adapter shape directly was rejected as the public design center because it would make Chat History the boundary instead of Agent-owned runtime state.
- Waiting for every provider before shipping durable Agent state was rejected because hosted Chat History and invocation coordination need a reliable first-party production path now.

## Consequences

Cloudflare-specific storage, binding, and coordination details should stay behind Provider Selection and Provider Output. The public Agent State Provider contract must remain suitable for later Vercel, local, database-backed, or other hosted implementations.
