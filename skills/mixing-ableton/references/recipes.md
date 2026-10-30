# Recipes (starting points; re-measure after each)

One change, one measurement. All ratios, frequencies and step sizes are convention. Read parameter names, value, min and max with `get_device_parameters` before writing; never infer dB from a 0..1 value.

## Devices

| Edition | Allowed native devices |
|---|---|
| Standard / Suite | EQ Eight, Compressor, Glue Compressor, Limiter, Utility, Gate |
| Lite | Compressor, Limiter, Utility, plus Channel EQ and EQ Three. Lite has no EQ Eight, Glue Compressor, Multiband Dynamics or Gate (owner test 2026-10-27; verify with `get_browser_tree` or `search_browser`) |

Never Max for Live devices (blocked). Never a third-party plugin unless the user asks.

## Gain tools

- Track level: `set_track_volume` with `volume_db` (master with `track: "master"`). Increases above 6 dB per call, or any master target above 0 dB, trip the gain guard and need confirmation or are refused. Explain this to the user.
- Device gain (Utility Gain, Limiter gain, makeup): `set_device_parameter`; the same guard applies to dB gain parameters.
- After each `load_instrument_or_effect`, call `get_track_info` to confirm the device landed on the intended track and in the intended position.

## Fixes

| Problem | Recipe | Device |
|---|---|---|
| True peak too high | Ask the target first (-2 dBTP streaming above -14 LUFS, -1 dBTP club). A limiter's ceiling sets the peak; lowering its input does not. Set the ceiling about 1 dB below the target, re-measure `true_peak_dbtp`. If no limiter exists on the master, load one last in the chain | Limiter |
| Too quiet vs target | After the target is agreed, raise Limiter gain in small steps (at most 6 dB per call, usually 1 to 2 dB), ceiling fixed; re-measure true peak and crest each time. Stop if master `crest_db` falls below 5 dB | Limiter |
| Too loud vs target | Lower Limiter gain or master volume (decreases never trip the guard) | Limiter, Utility |
| Kick vs bass masking | High-pass the bass or cut the bass slightly where the kick sits (start 60-100 Hz, small steps), or cut the kick's low-mid. Sidechain compression from the kick if the user wants pumping | EQ Eight, Compressor |
| Low-end excess (non-bass track) | High-pass in small steps (start 80-120 Hz); re-measure the 63/125 Hz bands | EQ Eight (Lite: Channel EQ) |
| Muddy low-mids | Gentle cut 200-400 Hz, 1-3 dB, wide Q | EQ Eight |
| Harsh highs | Gentle cut 2-5 kHz, 1-2 dB, narrow only if one resonance is visible in the spectrum | EQ Eight |
| Over-compressed (crest low) | Lower ratio or raise threshold toward crest of about 8 dB or more. If the track has no compressor, say the source itself is compressed and let the user decide | Compressor |
| Uncontrolled dynamics (crest high) | Ratio 2:1 to 4:1, gain reduction peaks about 3 to 6 dB, then re-measure | Compressor |
| Noise between hits | Gate with threshold just above the noise; confirm it is noise and not reverb tails. Lite: no Gate, the user trims clips by hand | Gate |
| Mix glue | Glue Compressor on the master, ratio 2:1, 1 to 2 dB gain reduction, slow attack. Lite: skip | Glue Compressor |
| Mono / phase | Look for a phase flip or a widener; Utility mono or phase invert, checking parameters by min/max | Utility |
| Gain staging | Utility Gain or `set_track_volume` in small steps; aim for headroom on the master before the limiter | Utility |
| Latin percussion | Keep transients: less compression, slower attack | Compressor |

## When a re-measure does not move

True-peak problems: check the limiter ceiling and that the limiter is the last device. Everything else: check device order, bypass state (`set_device_enabled`) and that the measured source is the track that was changed. Never push harder.
