/**
 * TIER 3 — Bollinger %B, ported directly from Meridian's
 * `backend/src/tools/bollinger.rs::percent_b` (read, not remembered):
 *
 * ```rust
 * let window = &closes[closes.len() - period..];
 * let mean = window.iter().sum::<f64>() / period as f64;
 * let variance = window.iter().map(|c| (c - mean).powi(2)).sum::<f64>() / period as f64;
 * let sd = variance.sqrt();
 * if sd <= 0.0 { return None; }
 * let upper = mean + 2.0 * sd;
 * let lower = mean - 2.0 * sd;
 * Some((last - lower) / (upper - lower))
 * ```
 *
 * Three details that matter and are easy to get subtly wrong:
 *  - POPULATION variance (divide by `period`), not sample variance
 *    (`period - 1`). Meridian divides by `period`.
 *  - `sd <= 0` returns null, NOT 0.5. A perfectly flat window has no
 *    bands, so %B is undefined rather than "mid-band" -- and an undefined
 *    reading must never be able to trigger an exit.
 *  - %B is deliberately unclamped: it exceeds 1.0 exactly when price has
 *    pierced the upper band, which IS the over-extension signal
 *    (`>= 1.0`) the exit rule keys on.
 *
 * Returns null (never a fabricated number) whenever the data is
 * insufficient -- fewer than `period` closes, or a degenerate window.
 */
export function computePercentB(closes: readonly number[], period: number, stdDevMultiplier: number): number | null {
  if (period <= 0 || closes.length < period) return null;

  const window = closes.slice(closes.length - period);
  if (window.some((c) => !Number.isFinite(c))) return null;

  const mean = window.reduce((sum, c) => sum + c, 0) / period;
  const variance = window.reduce((sum, c) => sum + (c - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;

  const upper = mean + stdDevMultiplier * sd;
  const lower = mean - stdDevMultiplier * sd;
  const last = window[window.length - 1];
  if (last === undefined || upper === lower) return null;

  return (last - lower) / (upper - lower);
}

/**
 * Collapses raw, irregularly-spaced price samples into one "close" per
 * fixed-width time bucket -- the last sample observed in each bucket,
 * which is what a candle close is.
 *
 * ADAPTATION, stated plainly: Meridian reads real OHLCV candles from an
 * external chart-indicators API keyed by token mint. No such feed exists
 * for Robinhood Chain, so Lunex derives its closes from the pool prices it
 * already polls every 15 seconds (`monitoring/priceHistoryRepository.ts`).
 * A 5-minute bucket therefore holds up to ~20 polls and closes on the last
 * one. This is a faithful reconstruction of the same quantity from a
 * different source, not a different indicator -- but it is NOT identical
 * to an exchange candle, and it only covers the period the bot has
 * actually been running.
 *
 * Samples must be passed oldest-first. Returns closes oldest-first.
 */
export function bucketSamplesToCloses(
  samples: readonly { price: number; observedAt: Date }[],
  bucketMs: number,
): number[] {
  if (bucketMs <= 0) return [];
  const closeByBucket = new Map<number, { price: number; at: number }>();

  for (const sample of samples) {
    if (!Number.isFinite(sample.price)) continue;
    const at = sample.observedAt.getTime();
    const bucket = Math.floor(at / bucketMs);
    const existing = closeByBucket.get(bucket);
    if (existing === undefined || at >= existing.at) {
      closeByBucket.set(bucket, { price: sample.price, at });
    }
  }

  return [...closeByBucket.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.price);
}
