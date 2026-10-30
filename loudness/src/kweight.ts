// BS.1770 K-weighting: a high-shelf ("pre-filter") followed by an RLB high-pass,
// both derived for any sample rate by the bilinear transform. The analog
// prototype constants are the ones used by libebur128; at 48 kHz they
// reproduce the coefficient table published in ITU-R BS.1770.

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface KWeightCoefficients {
  shelf: Biquad;
  highpass: Biquad;
}

export type Samples = Float32Array | Float64Array;

const SHELF_F0 = 1681.974450955533;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
const SHELF_VB_EXPONENT = 0.4996667741545416;
const HP_F0 = 38.13547087602444;
const HP_Q = 0.5003270373238773;

export function kWeightCoefficients(sampleRate: number): KWeightCoefficients {
  const kShelf = Math.tan((Math.PI * SHELF_F0) / sampleRate);
  const vh = Math.pow(10, SHELF_GAIN_DB / 20);
  const vb = Math.pow(vh, SHELF_VB_EXPONENT);
  const a0 = 1 + kShelf / SHELF_Q + kShelf * kShelf;
  const shelf: Biquad = {
    b0: (vh + (vb * kShelf) / SHELF_Q + kShelf * kShelf) / a0,
    b1: (2 * (kShelf * kShelf - vh)) / a0,
    b2: (vh - (vb * kShelf) / SHELF_Q + kShelf * kShelf) / a0,
    a1: (2 * (kShelf * kShelf - 1)) / a0,
    a2: (1 - kShelf / SHELF_Q + kShelf * kShelf) / a0,
  };
  const kHp = Math.tan((Math.PI * HP_F0) / sampleRate);
  const d = 1 + kHp / HP_Q + kHp * kHp;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (kHp * kHp - 1)) / d,
    a2: (1 - kHp / HP_Q + kHp * kHp) / d,
  };
  return { shelf, highpass };
}

/** Run one biquad (transposed direct form II) over x, writing into out. */
function runBiquad(c: Biquad, x: Samples, out: Float64Array): void {
  let z1 = 0;
  let z2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    out[i] = y;
  }
}

/** K-weight one channel. Returns a new Float64Array; the input is untouched. */
export function kWeight(x: Samples, sampleRate: number): Float64Array {
  const { shelf, highpass } = kWeightCoefficients(sampleRate);
  const out = new Float64Array(x.length);
  runBiquad(shelf, x, out);
  runBiquad(highpass, out, out); // in-place is safe: state holds the history
  return out;
}
