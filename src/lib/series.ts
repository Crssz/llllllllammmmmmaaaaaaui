export const SERIES_LEN = 32;

// Append v to a fixed-length sliding window buffer. The buffer is treated as
// immutable: a new array is returned so consumers can use referential equality
// for memoization.
export function pushSeries(buf: number[], v: number, max = SERIES_LEN): number[] {
  const out = buf.length >= max ? buf.slice(buf.length - max + 1) : buf.slice();
  out.push(v);
  return out;
}
