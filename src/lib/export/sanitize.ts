// Formula-injection guard (CSV/XLSX "CSV injection"). A text cell that starts with one of
// these characters can be read as a formula by Excel, Numbers, LibreOffice or Sheets
// (`=HYPERLINK(...)`, `+cmd|' /C calc'!A0`). Prefixing a single quote makes it literal
// text. Applied to every STRING cell; numbers are written as numbers and never touched.
const TRIGGER = /^[=+\-@\t\r]/;

export const neutralize = (s: string): string => (TRIGGER.test(s) ? `'${s}` : s);
