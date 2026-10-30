import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, analyzeChannels } from '../src/analyze.ts';
import { buildWav, buildAiff, sine, concat, fade } from './helpers.ts';

const FS = 48000;

test('report shape and values for a stereo -23 dBFS sine WAV', () => {
  const s = sine(997, -23, 10, FS);
  const r = analyzeAudio(buildWav([s, s], FS, { bits: 24 }));
  assert.ok(r.ok);
  const rep = r.report;
  assert.deepEqual(Object.keys(rep), [
    'duration_s', 'sample_rate', 'channels', 'bit_depth', 'mono',
    'integrated_lufs', 'short_term_max_lufs', 'momentary_max_lufs', 'lra_lu',
    'true_peak_dbtp', 'true_peak_dbtp_per_channel', 'sample_peak_dbfs', 'rms_dbfs', 'crest_db',
    'spectrum', 'correlation', 'warnings',
  ]);
  assert.equal(rep.duration_s, 10);
  assert.equal(rep.sample_rate, FS);
  assert.equal(rep.channels, 2);
  assert.equal(rep.bit_depth, 24);
  assert.equal(rep.mono, false);
  assert.equal(rep.integrated_lufs, -23.0);
  assert.equal(rep.short_term_max_lufs, -23.0);
  assert.equal(rep.momentary_max_lufs, -23.0);
  assert.equal(rep.lra_lu, 0);
  assert.equal(rep.sample_peak_dbfs, -23.0);
  assert.equal(rep.rms_dbfs, -26.0);
  assert.equal(rep.crest_db, 3.0);
  assert.equal(rep.correlation, 1);
  assert.equal(rep.true_peak_dbtp_per_channel.length, 2);
  assert.ok(rep.true_peak_dbtp! >= rep.sample_peak_dbfs! - 0.05);
  assert.equal(rep.spectrum.length, 10);
  assert.deepEqual(rep.warnings, []);
});

test('mono: weight 1.0, mono flag, null correlation', () => {
  const s = sine(997, -20, 5, FS);
  const r = analyzeAudio(buildAiff([s], FS, { kind: 'sowt', bits: 16 }));
  assert.ok(r.ok);
  assert.equal(r.report.mono, true);
  assert.equal(r.report.correlation, null);
  assert.equal(r.report.integrated_lufs, -23.0);
  assert.equal(r.report.true_peak_dbtp_per_channel.length, 1);
});

test('silence yields nulls and a silence warning', () => {
  const z = new Float64Array(FS * 4);
  const r = analyzeChannels([z, z], FS, { bitDepth: 16 });
  assert.equal(r.integrated_lufs, null);
  assert.equal(r.momentary_max_lufs, null);
  assert.equal(r.short_term_max_lufs, null);
  assert.equal(r.lra_lu, null);
  assert.equal(r.sample_peak_dbfs, null);
  assert.equal(r.true_peak_dbtp, null);
  assert.equal(r.rms_dbfs, null);
  assert.equal(r.crest_db, null);
  assert.ok(r.warnings.includes('silence'));
});

test('short file warnings and clipping warning', () => {
  const s = fade(sine(1000, 0, 1, FS, 0.3), 2400);
  const loud = concat(s.map((v) => Math.max(-1, Math.min(1, v * 1.5))));
  const r = analyzeChannels([loud, loud], FS, { bitDepth: 16 });
  assert.ok(r.warnings.includes('clipping'));
  assert.ok(r.warnings.includes('too_short_for_short_term'));
  assert.ok(r.warnings.includes('too_short_for_lra'));
  assert.notEqual(r.integrated_lufs, null);
  const tiny = analyzeChannels([sine(1000, -20, 0.1, FS)], FS, { bitDepth: 16 });
  assert.equal(tiny.integrated_lufs, null);
  assert.ok(tiny.warnings.includes('too_short_for_integrated'));
});

test('typed errors: channel count, garbage, empty', () => {
  const s = sine(1000, -20, 1, FS);
  const three = analyzeAudio(buildWav([s, s, s], FS, { bits: 16 }));
  assert.ok(!three.ok && three.error.code === 'unsupported_channels');
  assert.ok(!analyzeAudio(new Uint8Array([1, 2, 3])).ok);
});
