// Single entry point: bytes (or decoded channels) in, the docs/01-protocol.md 10.6 report out.

import { parseAudio } from './audiofile.ts';
import type { AudioError, ParseOptions } from './audiofile.ts';
import { computeLoudness } from './loudness.ts';
import { truePeakDb } from './truepeak.ts';
import { bandSpectrum, correlation, linearToDb, rmsOfChannels, samplePeak } from './stats.ts';
import type { Samples } from './kweight.ts';

export interface SpectrumBand {
  center_hz: number;
  level_db: number | null;
}

export interface AnalysisReport {
  duration_s: number;
  sample_rate: number;
  channels: number;
  bit_depth: number;
  mono: boolean;
  integrated_lufs: number | null;
  short_term_max_lufs: number | null;
  momentary_max_lufs: number | null;
  lra_lu: number | null;
  true_peak_dbtp: number | null;
  true_peak_dbtp_per_channel: Array<number | null>;
  sample_peak_dbfs: number | null;
  rms_dbfs: number | null;
  crest_db: number | null;
  spectrum: SpectrumBand[];
  correlation: number | null;
  warnings: string[];
}

export type AnalyzeResult = { ok: true; report: AnalysisReport } | { ok: false; error: AudioError };

const round1 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/** Analyse decoded channels (1 or 2). Throws RangeError for other channel counts. */
export function analyzeChannels(channels: Samples[], sampleRate: number, meta: { bitDepth: number }): AnalysisReport {
  if (channels.length < 1 || channels.length > 2) throw new RangeError(`unsupported channel count ${channels.length}`);
  const frames = channels[0].length;
  const warnings: string[] = [];
  const loud = computeLoudness(channels, sampleRate);

  const perChannelTp = channels.map((c) => truePeakDb(c, sampleRate));
  const tpMax = Math.max(...perChannelTp);
  const peakLin = Math.max(...channels.map((c) => samplePeak(c)));
  const peakDb = linearToDb(peakLin);
  const rmsDb = linearToDb(rmsOfChannels(channels));
  const silent = peakLin === 0;

  if (silent) warnings.push('silence');
  if (!silent && peakDb >= 0) warnings.push('clipping');
  if (frames < 0.4 * sampleRate) warnings.push('too_short_for_integrated');
  if (frames < 3 * sampleRate) {
    warnings.push('too_short_for_short_term');
    warnings.push('too_short_for_lra');
  } else if (!silent && loud.lraLu === null) warnings.push('lra_undefined_after_gating');
  if (!silent && loud.integratedLufs === null && frames >= 0.4 * sampleRate) warnings.push('below_absolute_gate');

  const corr = channels.length === 2 ? correlation(channels[0], channels[1]) : null;
  return {
    duration_s: Math.round((frames / sampleRate) * 1000) / 1000,
    sample_rate: sampleRate,
    channels: channels.length,
    bit_depth: meta.bitDepth,
    mono: channels.length === 1,
    integrated_lufs: round1(loud.integratedLufs),
    short_term_max_lufs: round1(loud.shortTermMaxLufs),
    momentary_max_lufs: round1(loud.momentaryMaxLufs),
    lra_lu: round1(loud.lraLu),
    true_peak_dbtp: round1(tpMax),
    true_peak_dbtp_per_channel: perChannelTp.map(round1),
    sample_peak_dbfs: round1(peakDb),
    rms_dbfs: round1(rmsDb),
    crest_db: silent ? null : round1(peakDb - rmsDb),
    spectrum: bandSpectrum(channels, sampleRate).map((b) => ({ center_hz: b.centerHz, level_db: round1(b.levelDb) })),
    correlation: corr === null ? null : Math.round(corr * 1000) / 1000,
    warnings,
  };
}

/** Parse a WAV/AIFF buffer and analyse it. Never throws. */
export function analyzeAudio(bytes: Uint8Array, options: ParseOptions = {}): AnalyzeResult {
  const parsed = parseAudio(bytes, options);
  if (!parsed.ok) return parsed;
  const a = parsed.audio;
  try {
    return { ok: true, report: analyzeChannels(a.channels, a.sampleRate, { bitDepth: a.bitDepth }) };
  } catch (e) {
    return { ok: false, error: { code: 'malformed', message: `analysis failed: ${(e as Error).message}` } };
  }
}
