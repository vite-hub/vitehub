// Escaping for values of systemd unit files. `lineBreak` reports a value with a line break, which would end the setting.

/** systemd expands `%` specifiers in every value, and a line break ends the setting. */
export function systemdValue(value: string, lineBreak: () => never): string {
  if (/[\n\r]/.test(value)) lineBreak()
  return value.replaceAll("%", "%%")
}

/** Quotes an `ExecStart=` argument, where systemd also expands `$` variables. */
export function systemdExecArgument(value: string, lineBreak: () => never): string {
  const escaped = systemdValue(value, lineBreak).replaceAll("$", "$$$$")
  return /^[\w./@+:,=-]+$/.test(escaped) ? escaped : `"${escaped.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}

/** Quotes the `NAME=value` of an `Environment=` line. */
export function systemdAssignment(name: string, value: string, lineBreak: () => never): string {
  return `"${systemdValue(`${name}=${value}`, lineBreak).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}
