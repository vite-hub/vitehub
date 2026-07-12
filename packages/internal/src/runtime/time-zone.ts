// Intl accepts some non-IANA abbreviations (for example, "PST"), while
// supportedValuesOf("timeZone") omits IANA links. Keep the slashless names
// from tzdb explicit, then let Intl decide whether the runtime supports them.
const slashlessIanaTimeZones = new Set([
  "CET",
  "CST6CDT",
  "Cuba",
  "EET",
  "EST",
  "EST5EDT",
  "Egypt",
  "Eire",
  "Factory",
  "GB",
  "GB-Eire",
  "GMT",
  "GMT+0",
  "GMT-0",
  "GMT0",
  "Greenwich",
  "HST",
  "Hongkong",
  "Iceland",
  "Iran",
  "Israel",
  "Jamaica",
  "Japan",
  "Kwajalein",
  "Libya",
  "MET",
  "MST",
  "MST7MDT",
  "NZ",
  "NZ-CHAT",
  "Navajo",
  "PRC",
  "PST8PDT",
  "Poland",
  "Portugal",
  "ROC",
  "ROK",
  "Singapore",
  "Turkey",
  "UCT",
  "UTC",
  "Universal",
  "W-SU",
  "WET",
  "Zulu",
])

export function isIanaTimeZone(timeZone: unknown): timeZone is string {
  if (
    typeof timeZone !== "string" ||
    (!timeZone.includes("/") && !slashlessIanaTimeZones.has(timeZone))
  ) {
    return false
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return true
  }
  catch {
    return false
  }
}
