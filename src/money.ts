/**
 * Money is integer minor units (cents), never floats.
 *
 * The original schema stored `bpm REAL` and any billing math in JS floats.
 * Ledger/price math in floats drifts (0.1 + 0.2 !== 0.3). All monetary values
 * in this codebase are integers; formatting happens only at the edge.
 */
export type Cents = number & { readonly __brand: "Cents" };

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) {
    throw new Error(`Money must be an integer number of cents, got ${n}`);
  }
  return n as Cents;
}

export function addCents(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

export function subCents(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

/** Parse a decimal string like "9.99" into 999 cents without float error. */
export function parseAmountToCents(input: string): Cents {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid money string: ${input}`);
  const [, sign, whole, frac = ""] = m;
  const padded = (frac + "00").slice(0, 2);
  const total = Number(whole) * 100 + Number(padded);
  return cents(sign === "-" ? -total : total);
}

export function formatCents(c: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(c / 100);
}
