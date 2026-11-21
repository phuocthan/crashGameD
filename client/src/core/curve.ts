// Must match server/src/fair.js exactly so the client curve lines up with server settlement.
export const GROWTH = 0.00006;

export const multiplierAt = (elapsedMs: number) =>
  elapsedMs <= 0 ? 1 : Math.floor(Math.exp(GROWTH * elapsedMs) * 100) / 100;

/** Smooth (unrounded) value for drawing. */
export const rawMultiplierAt = (elapsedMs: number) => (elapsedMs <= 0 ? 1 : Math.exp(GROWTH * elapsedMs));

export const msForMultiplier = (m: number) => Math.log(m) / GROWTH;

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
