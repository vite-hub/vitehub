# Vite+ Migration Uses Vite 8 Peer Boundary

ViteHub's Vite+ migration sets Vite 8 as the minimum supported Vite peer boundary for package Vite Integrations. Older Vite compatibility can be revisited later if users require it, but current package metadata, examples, tests, and build workflows should not imply Vite 6 support.

## Considered Options

- Preserving existing Vite 6 peer ranges was rejected because the project is moving to Vite+ and should validate one modern Vite-first integration surface.
- Supporting older Vite versions immediately was rejected because ViteHub is still in active development and can add compatibility only when a real downstream need justifies the extra maintenance.

## Consequences

Package peer ranges that use Vite compatibility catalogs should converge on Vite 8 or newer. Compatibility code, examples, and tests that exist only for Vite 6 should be removed or deferred unless a later ADR reintroduces older Vite support.
