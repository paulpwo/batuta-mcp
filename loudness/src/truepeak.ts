// BS.1770 Annex 2 style true-peak meter: polyphase FIR oversampling, then the
// maximum absolute value. The interpolation filter is a Kaiser-windowed sinc
// (cutoff = the original Nyquist), generated at module load; it is normalised
// so every polyphase branch has unity DC gain. Phase 0 passes the original
// samples through unchanged, so true peak >= sample peak by construction.

import type { Samples } from './kweight.ts';

const TAPS_PER_PHASE = 24;
const KAISER_BETA = 5.5;

/** Oversampling factor: 4x below 96 kHz, 2x below 192 kHz, 1x from 192 kHz. */
export function oversamplingFactor(sampleRate: number): 1 | 2 | 4 {
  if (sampleRate < 96000) return 4;
  if (sampleRate < 192000) return 2;
  return 1;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-18 * sum) break;
  }
  return sum;
}

/** Polyphase bank: phases[p][k] multiplies x[n - k] to give output sample n*L + p. */
function designPhases(factor: number): Float64Array[] {
  const length = factor * TAPS_PER_PHASE;
  const centre = length / 2; // an integer multiple of `factor`: phase 0 is a pure delay
  const norm = besselI0(KAISER_BETA);
  const phases: Float64Array[] = [];
  for (let p = 0; p < factor; p++) phases.push(new Float64Array(TAPS_PER_PHASE));
  for (let j = 0; j < length; j++) {
    const t = (j - centre) / factor;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (2 * j) / length - 1;
    const window = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / norm;
    phases[j % factor][Math.floor(j / factor)] = sinc * window;
  }
  for (const ph of phases) {
    let sum = 0;
    for (const v of ph) sum += v;
    for (let k = 0; k < ph.length; k++) ph[k] /= sum;
  }
  return phases;
}

const BANKS = new Map<number, Float64Array[]>();

function bank(factor: number): Float64Array[] {
  let b = BANKS.get(factor);
  if (!b) {
    b = designPhases(factor);
    BANKS.set(factor, b);
  }
  return b;
}

/** Linear true peak (max |oversampled sample|) of one channel. */
export function truePeak(x: Samples, sampleRate: number): number {
  const factor = oversamplingFactor(sampleRate);
  let peak = 0;
  if (factor === 1) {
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }
  const phases = bank(factor);
  const T = TAPS_PER_PHASE;
  const total = x.length + T / 2; // flush the filter tail with implicit zeros
  for (let n = 0; n < total; n++) {
    for (let p = 0; p < factor; p++) {
      const h = phases[p];
      let acc = 0;
      // x[n - k] with out-of-range indices treated as zero
      const kMin = Math.max(0, n - (x.length - 1));
      const kMax = Math.min(T - 1, n);
      for (let k = kMin; k <= kMax; k++) acc += h[k] * x[n - k];
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** True peak in dBTP; -Infinity for silence or empty input. */
export function truePeakDb(x: Samples, sampleRate: number): number {
  const p = truePeak(x, sampleRate);
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}
