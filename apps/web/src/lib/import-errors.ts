/**
 * The services report unreadable rows in English. This maps the known reasons to message keys
 * (under `import.rowErrors`) with their values, so the UI can say them in the user's language.
 */
export function rowErrorKey(message: string): { key: string; values: Record<string, string> } {
  const currency = /\((\w{3})\).*\((\w{3})\)/.exec(message);
  if (/currency/i.test(message) && currency) {
    return { key: 'currency', values: { row: currency[1]!, account: currency[2]! } };
  }
  if (/date/i.test(message)) return { key: 'date', values: {} };
  const decimals = /more than (\d+) decimals/i.exec(message);
  if (decimals) return { key: 'decimals', values: { digits: decimals[1]! } };
  if (/amount/i.test(message)) return { key: 'amount', values: {} };
  if (/description/i.test(message)) return { key: 'description', values: {} };
  return { key: 'other', values: {} };
}
