Vendored from https://github.com/dmmulroy/anti-slop at commit
`6d538555cb151d4121ed51a27db81890eacf8ae9`.

Only the generic production rules are included. ViteHub follows the upstream
MIT license in `LICENSE`.

ViteHub extends the vendored rules where repository fixtures require lexical
type-parameter scope, generic type-alias substitution, or qualified type-name
resolution. Keep those local correctness fixes when refreshing the snapshot.
