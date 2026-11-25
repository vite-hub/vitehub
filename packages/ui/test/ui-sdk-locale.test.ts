import { parseDate } from "@ui-sdk/core/date";
import { describe, expect, it } from "vitest";

const options = { referenceDate: "2026-01-01" };

describe("patched ui-sdk date parsing", () => {
  it("keeps unambiguous ISO input and Kyrgyz numeric round trips", () => {
    expect(parseDate("2026-01-16", "ky-KG", options)).toBe("2026-01-16");
    expect(parseDate("2026-05-01", "ky-KG", options)).toBe("2026-01-05");
  });

  it.each(["ha", "ak", "ff", "sg", "sat", "ksh"])("keeps %s numeric order for compact digits", (locale) => {
    expect(parseDate("260116", locale, options)).toBe("2026-01-16");
  });

  it.each(["ha", "ff", "sg", "sat"])("reads %s dates typed with the short-date separator in short-date order", (locale) => {
    expect(parseDate("01/05", locale, options)).toBe("2026-05-01");
  });

  it.each(["ak", "ksh"])("keeps %s numeric order for omitted years", (locale) => {
    expect(parseDate("01/05", locale, options)).toBe("2026-01-05");
  });

  it("still accepts localized short-date order", () => {
    expect(parseDate("1/5/26", "zu-ZA", options)).toBe("2026-01-05");
    expect(parseDate("5/1/26", "ky-KG", options)).toBe("2026-01-05");
  });

  it("expands a padded short era year but preserves literal numeric era years", () => {
    const reference = { referenceDate: "2126-01-01" };
    expect(parseDate("16.10.08 R", "de-DE-u-ca-japanese", reference)).toBe("2126-10-16");
    expect(parseDate("16.10.8 R", "de-DE-u-ca-japanese", reference)).toBe("2026-10-16");
    // ROC numeric 1926 and short 2026 are identical: retain the documented numeric preference.
    expect(parseDate("16.10.15 Minguo", "de-DE-u-ca-roc", options)).toBe("1926-10-16");
  });
});
