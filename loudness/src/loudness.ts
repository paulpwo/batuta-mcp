// BS.1770-5 / EBU R128 loudness: momentary, short-term, integrated, LRA (Tech 3342).
//
// All windows are multiples of a 10 ms "slice" (400 ms momentary = 40 slices,
// 3 s short-term = 300 slices), so one pass of per-slice weighted energy sums
// yields every measurement. Gating blocks and LRA windows always hop 100 ms
// (10 slices). The hop used for the momentary / short-term MAXIMA defaults to
// 100 ms (docs/01-protocol.md 10.6) and can be reduced (EBU Tech 3341 cases
// 13/14 need <= ~18 ms to stay within +-0.1 LU). Only complete slices count.

import { kWeight } from './kweight.ts';
import type { Samples } from './kweight.ts';

export interface LoudnessResult {
  /** Gated integrated loudness; null when undefined (< 400 ms or all below -70 LUFS). */
  integratedLufs: number | null;
  /** Max of 3 s windows at 100 ms hop; null when < 3 s or silent. */
  shortTermMaxLufs: number | null;
  /** Max of 400 ms windows at 100 ms hop; null when < 400 ms or silent. */
  momentaryMaxLufs: number | null;
  /** Loudness range (Tech 3342); null when no short-term window survives the gates. */
  lraLu: number | null;
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const LRA_RELATIVE_GATE_LU = -20;
const OFFSET = -0.691;

export function energyToLufs(energy: number): number {
  return energy > 0 ? OFFSET + 10 * Math.log10(energy) : -Infinity;
}

function lufsToEnergy(lufs: number): number {
  return Math.pow(10, (lufs - OFFSET) / 10);
}

/** Linear-interpolated percentile of an ascending-sorted array. */
function percentile(sorted: Float64Array, p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Compute loudness for 1 or 2 channels. Channel weights are 1.0 (L/R), and a
 * mono input is NOT compensated by +3.01 dB (docs/01-protocol.md 10.6).
 */
export interface LoudnessOptions {
  /** Channel weights (default 1.0 each). */
  weights?: number[];
  /** Hop in ms for the momentary and short-term maxima; multiple of 10 (default 100). */
  maxHopMs?: number;
}

export function computeLoudness(channels: Samples[], sampleRate: number, options: LoudnessOptions = {}): LoudnessResult {
  const weights = options.weights;
  const maxHop = Math.max(1, Math.round((options.maxHopMs ?? 100) / 10));
  const frames = channels.length > 0 ? channels[0].length : 0;
  const slice = Math.round(sampleRate * 0.01);
  const sliceCount = slice > 0 ? Math.floor(frames / slice) : 0;
  // Weighted K-filtered mean-square energy per complete 10 ms slice.
  const sliceEnergy = new Float64Array(sliceCount);
  for (let c = 0; c < channels.length; c++) {
    const w = weights ? weights[c] : 1.0;
    const y = kWeight(channels[c], sampleRate);
    for (let s = 0; s < sliceCount; s++) {
      let sum = 0;
      const end = (s + 1) * slice;
      for (let i = s * slice; i < end; i++) sum += y[i] * y[i];
      sliceEnergy[s] += (w * sum) / slice; // mean square over the slice
    }
  }

  const windowEnergies = (len: number, hop: number): Float64Array => {
    const n = sliceCount - len + 1;
    if (n <= 0) return new Float64Array(0);
    const count = Math.floor((n - 1) / hop) + 1;
    const out = new Float64Array(count);
    for (let w = 0; w < count; w++) {
      let sum = 0;
      const start = w * hop;
      for (let k = 0; k < len; k++) sum += sliceEnergy[start + k];
      out[w] = sum / len;
    }
    return out;
  };

  const momentary = windowEnergies(40, 10);
  const shortTerm = windowEnergies(300, 10);
  const momentaryForMax = maxHop === 10 ? momentary : windowEnergies(40, maxHop);
  const shortTermForMax = maxHop === 10 ? shortTerm : windowEnergies(300, maxHop);

  const maxLufs = (e: Float64Array): number | null => {
    let m = 0;
    for (let i = 0; i < e.length; i++) if (e[i] > m) m = e[i];
    return m > 0 ? energyToLufs(m) : null;
  };

  // Integrated: absolute gate, then relative gate (-10 LU below the abs-gated mean).
  const absEnergy = lufsToEnergy(ABSOLUTE_GATE_LUFS);
  const integratedLufs = gatedLoudness(momentary, absEnergy, RELATIVE_GATE_LU);

  // LRA: short-term windows, abs -70, relative -20 LU, P95 - P10.
  let lraLu: number | null = null;
  const stLoud: number[] = [];
  let absSum = 0;
  for (let i = 0; i < shortTerm.length; i++)
    if (shortTerm[i] > absEnergy) {
      stLoud.push(energyToLufs(shortTerm[i]));
      absSum += shortTerm[i];
    }
  if (stLoud.length > 0) {
    const relThreshold = energyToLufs(absSum / stLoud.length) + LRA_RELATIVE_GATE_LU;
    const kept = stLoud.filter((l) => l > relThreshold);
    if (kept.length > 0) {
      const sorted = Float64Array.from(kept).sort();
      lraLu = percentile(sorted, 0.95) - percentile(sorted, 0.1);
    }
  }

  return {
    integratedLufs,
    shortTermMaxLufs: maxLufs(shortTermForMax),
    momentaryMaxLufs: maxLufs(momentaryForMax),
    lraLu,
  };
}

function gatedLoudness(blocks: Float64Array, absEnergy: number, relativeLu: number): number | null {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < blocks.length; i++)
    if (blocks[i] > absEnergy) {
      sum += blocks[i];
      count++;
    }
  if (count === 0) return null;
  const relEnergy = lufsToEnergy(energyToLufs(sum / count) + relativeLu);
  let sum2 = 0;
  let count2 = 0;
  for (let i = 0; i < blocks.length; i++)
    if (blocks[i] > absEnergy && blocks[i] > relEnergy) {
      sum2 += blocks[i];
      count2++;
    }
  return count2 === 0 ? null : energyToLufs(sum2 / count2);
}
