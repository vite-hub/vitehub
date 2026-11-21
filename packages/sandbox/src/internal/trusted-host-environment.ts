const reservedCommandEnvironmentKeys = new Set([
  'CODEX_HOME',
  'HOME',
  'INIT_CWD',
  'OLDPWD',
  'PWD',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
])

export function isTrustedHostReservedCommandEnvironmentKey(name: string): boolean {
  return reservedCommandEnvironmentKeys.has(name)
}
