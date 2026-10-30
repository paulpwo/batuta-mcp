"""T4a tests: session clip envelopes (spec 7.7) and DeviceRef/ParamRef resolution."""

import unittest

from .clip_world import A, S, T0, T2, R0, M, ClipCase, add_device, put_arrangement, put_clip
from .fake_lom import FakeChainStub, FakeDeviceStub, FakeDrumPadStub, FakeRackStub

CLIP = S(T0, 0)
VOLUME = {"mixer": "volume", "track": T0}
PAN = {"mixer": "pan", "track": T0}
SEND0 = {"mixer": "send", "track": T0, "index": 0}
DEV_P1 = {"device": {"track": T0, "path": [0]}, "index": 1}
STEPS = [{"time": 0, "duration": 1, "value": 0.5}, {"time": 2, "duration": 2, "value": 0.8}]


class EnvelopeCase(ClipCase):
    def setUp(self):
        super().setUp()
        self.device = add_device(self.h, 0, 3, "Comp")
        self.rack = FakeRackStub("Rack", chains=[FakeChainStub("c", [FakeDeviceStub("Inner", "Eq", 2, 2)])])
        self.drums = FakeRackStub("Drums", drum_pads=[FakeDrumPadStub(
            36, [FakeChainStub("k", [FakeDeviceStub("Kick", "Eq", 2, 4)])])])
        self.h.song.tracks[0].devices.extend([self.rack, self.drums])
        self.clip = self.h.song.tracks[0].clip_slots[0].clip
        self.mixer = self.h.song.tracks[0].mixer_device
        self.h.reset_log()

    def make(self, param):
        envelope = self.clip.create_automation_envelope(param)
        self.h.reset_log()
        return envelope


class ArrangementRefusalTests(EnvelopeCase):
    def test_every_envelope_command_refuses_arrangement_clips(self):
        put_arrangement(self.h, 0, 8.0, 4.0)
        calls = {"envelope_list": {}, "envelope_get": {"param": VOLUME}, "envelope_set": {"param": VOLUME, "steps": STEPS},
                 "envelope_clear": {"param": VOLUME}, "envelope_clear_all": {}}
        for name, extra in calls.items():
            for index in (0, 5):  # the kind is refused before the clip is even looked up
                error = self.h.error(name, dict({"clip": A(T0, index)}, **extra))
                self.assertEqual((error["code"], self.reason(error)), ("not_supported", "arrangement"), name)
        self.assertNoSideEffects()

    def test_refused_inside_batch(self):
        put_arrangement(self.h, 0, 8.0, 4.0)
        error = self.batch_error("envelope_set", {"clip": A(T0, 0), "param": VOLUME, "steps": STEPS})
        self.assertEqual(self.reason(error), "arrangement")
        self.assertFalse([e for e in self.h.song.log if "envelope" in e])


class ListTests(EnvelopeCase):
    def test_nothing_without_envelopes(self):
        result = self.h.ok("envelope_list", {"clip": CLIP})
        self.assertEqual((result["envelopes"], result["truncated"]), ([], False))
        self.assertEqual(result["scanned"], 3 + 2 + 2 + 2 + 4)  # Comp, Rack, Inner, Drums, Kick
        self.assertNoSideEffects()

    def test_finds_mixer_device_and_nested_envelopes(self):
        self.make(self.mixer.volume)
        self.make(self.mixer.sends[0])
        self.make(self.device.parameters[1])
        self.make(self.rack.chains[0].devices[0].parameters[0])
        self.make(self.drums.drum_pads[0].chains[0].devices[0].parameters[3])
        found = self.h.ok("envelope_list", {"clip": CLIP})["envelopes"]
        self.assertEqual(found, [
            {"mixer": "volume", "track": T0, "name": "Volume"},
            {"mixer": "send", "track": T0, "index": 0, "name": "Send A"},
            {"device": {"track": T0, "path": [0]}, "index": 1, "name": "p1"},
            {"device": {"track": T0, "path": [1, {"chain": 0, "device": 0}]}, "index": 0, "name": "p0"},
            {"device": {"track": T0, "path": [2, {"drum_pad": 36, "chain": 0, "device": 0}]}, "index": 3,
             "name": "p3"},
        ])
        self.assertNoSideEffects()

    def test_listed_refs_round_trip_through_envelope_get(self):
        self.make(self.rack.chains[0].devices[0].parameters[0])
        ref = self.h.ok("envelope_list", {"clip": CLIP})["envelopes"][0]
        ref.pop("name")
        self.assertTrue(self.h.ok("envelope_get", {"clip": CLIP, "param": ref})["exists"])

    def test_device_scan_is_capped_at_1000_parameters(self):
        add_device(self.h, 0, 1100, "Big")
        result = self.h.ok("envelope_list", {"clip": CLIP})
        self.assertEqual((result["scanned"], result["truncated"]), (1000, True))

    def test_other_tracks_clips_only_see_their_own_track(self):
        put_clip(self.h, 2, 0, True)
        self.make(self.mixer.volume)
        self.assertEqual(self.h.ok("envelope_list", {"clip": S(T2, 0)})["envelopes"], [])


class GetTests(EnvelopeCase):
    def test_missing_envelope(self):
        self.assertEqual(self.h.ok("envelope_get", {"clip": CLIP, "param": VOLUME}), {"exists": False, "points": []})
        self.assertNoSideEffects()

    def test_samples_value_at_time(self):
        envelope = self.make(self.mixer.volume)
        for step in STEPS:
            envelope.insert_step(step["time"], step["duration"], step["value"])
        self.h.reset_log()
        result = self.h.ok("envelope_get", {"clip": CLIP, "param": VOLUME, "points": 5})
        self.assertTrue(result["exists"])
        self.assertEqual(result["points"], [{"time": float(t), "value": v} for t, v in
                                            ((0, 0.5), (1, 0.5), (2, 0.8), (3, 0.8), (4, 0.8))])
        window = self.h.ok("envelope_get", {"clip": CLIP, "param": VOLUME, "points": 2, "from": 1, "to": 3})
        self.assertEqual([p["time"] for p in window["points"]], [1.0, 3.0])
        self.assertEqual(len(self.h.ok("envelope_get", {"clip": CLIP, "param": VOLUME})["points"]), 128)
        self.assertNoSideEffects()

    def test_argument_rules(self):
        self.make(self.mixer.volume)
        for extra in ({"points": 1}, {"points": 513}, {"from": 3, "to": 3}, {"from": 5}, {"from": -1}):
            error = self.h.error("envelope_get", dict({"clip": CLIP, "param": VOLUME}, **extra))
            self.assertEqual(error["code"], "invalid_args", extra)

    def test_parameters_of_other_tracks_are_refused(self):
        self.make(self.mixer.volume)
        other = {"mixer": "volume", "track": T2}
        for param in (other, {"mixer": "volume", "track": R0}, {"mixer": "volume", "track": M},
                      {"device": {"track": T2, "path": [0]}, "index": 0}):
            self.h.song.tracks[2].devices.append(FakeDeviceStub())
            error = self.h.error("envelope_get", {"clip": CLIP, "param": param})
            self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "param_track_mismatch"), param)

    def test_param_ref_resolution_errors(self):
        cases = [({"mixer": "send", "track": T0}, "invalid_args"),
                 ({"mixer": "volume", "track": T0, "index": 0}, "invalid_args"),
                 ({"mixer": "send", "track": T0, "index": 5}, "not_found"),
                 ({"device": {"track": T0, "path": [9]}, "index": 0}, "not_found"),
                 ({"device": {"track": T0, "path": [0]}, "index": 9}, "not_found"),
                 ({"device": {"track": T0, "path": [0, {"chain": 0, "device": 0}]}, "index": 0}, "not_found"),
                 ({"device": {"track": T0, "path": [1, {"chain": 3, "device": 0}]}, "index": 0}, "not_found"),
                 ({"device": {"track": T0, "path": [2, {"drum_pad": 40, "chain": 0, "device": 0}]}, "index": 0},
                  "not_found"),
                 ({"device": {"track": T0, "path": [1, {"return_chain": 0, "device": 0}]}, "index": 0}, "not_found"),
                 ({"device": {"track": T0, "path": [1, {"chain": 0, "device": 4}]}, "index": 0}, "not_found"),
                 ({"device": {"track": T0, "path": [{"chain": 0, "device": 0}]}, "index": 0}, "invalid_args"),
                 ({"device": {"track": T0, "path": [0, 1]}, "index": 0}, "invalid_args"),
                 ({"device": {"track": T0, "path": []}, "index": 0}, "invalid_args"),
                 ({"device": {"track": T0, "path": [0] * 9}, "index": 0}, "invalid_args"),
                 ({"mixer": "other", "track": T0}, "invalid_args"), ({"device": {"track": T0, "path": [0]}}, "invalid_args")]
        for param, code in cases:
            self.assertEqual(self.h.error("envelope_get", {"clip": CLIP, "param": param})["code"], code, param)
        self.assertNoSideEffects()


class SetTests(EnvelopeCase):
    def test_creates_the_envelope_and_inserts_steps(self):
        result = self.h.ok("envelope_set", {"clip": CLIP, "param": VOLUME, "steps": STEPS})
        self.assertEqual(result, {"inserted": 2})
        envelope = self.clip.automation_envelope(self.mixer.volume)
        self.assertEqual(envelope.steps, [(0.0, 1.0, 0.5), (2.0, 2.0, 0.8)])
        self.assertEqual(self.h.song.log.count("call:clip.create_automation_envelope"), 1)
        self.assertOneUndoStep()

    def test_device_and_send_params(self):
        self.h.ok("envelope_set", {"clip": CLIP, "param": DEV_P1, "steps": STEPS[:1]})
        self.h.ok("envelope_set", {"clip": CLIP, "param": SEND0, "steps": STEPS[:1]})
        self.assertIsNotNone(self.clip.automation_envelope(self.device.parameters[1]))
        self.assertIsNotNone(self.clip.automation_envelope(self.mixer.sends[0]))

    def test_without_replace_steps_are_added_to_the_existing_envelope(self):
        self.make(self.mixer.volume).insert_step(0, 1, 0.1)
        self.h.reset_log()
        self.h.ok("envelope_set", {"clip": CLIP, "param": VOLUME, "steps": STEPS[:1]})
        self.assertEqual(len(self.clip.automation_envelope(self.mixer.volume).steps), 2)
        self.assertNotIn("call:clip.clear_envelope", self.h.song.log)
        self.assertNotIn("call:clip.create_automation_envelope", self.h.song.log)

    def test_replace_clears_first(self):
        self.make(self.mixer.volume).insert_step(0, 1, 0.1)
        self.h.reset_log()
        self.h.ok("envelope_set", {"clip": CLIP, "param": VOLUME, "steps": STEPS[:1], "replace": True})
        self.assertEqual(self.clip.automation_envelope(self.mixer.volume).steps, [(0.0, 1.0, 0.5)])
        order = [e for e in self.h.song.log if "envelope" in e]
        self.assertEqual(order[:2], ["call:clip.clear_envelope", "call:clip.create_automation_envelope"])

    def test_range_violations_write_nothing(self):
        cases = [([{"time": 5, "duration": 1, "value": 0.5}], "steps[0].time"),
                 ([{"time": 3, "duration": 2, "value": 0.5}], "steps[0].duration"),
                 ([{"time": 0, "duration": 1, "value": 0.5}, {"time": 0, "duration": 1, "value": 1.5}], "steps[1].value"),
                 ([{"time": 0, "duration": 1, "value": -0.1}], "steps[0].value")]
        for steps, field in cases:
            error = self.h.error("envelope_set", {"clip": CLIP, "param": VOLUME, "steps": steps})
            self.assertEqual((error["code"], error["details"]["field"]), ("out_of_range", field))
        self.assertNoSideEffects()

    def test_schema_rules(self):
        bad_steps = [[], [{"time": 0, "duration": 0, "value": 0.5}], [{"time": -1, "duration": 1, "value": 0.5}],
                     [{"time": 0, "duration": 1}], [{"time": 0, "duration": 1, "value": True}],
                     [{"time": 0, "duration": 0.001, "value": 0.5}] * 1025]
        for steps in bad_steps:
            self.assertEqual(self.h.error("envelope_set", {"clip": CLIP, "param": VOLUME, "steps": steps})["code"],
                             "invalid_args")
        self.assertEqual(self.h.error("envelope_set", {"clip": CLIP, "param": VOLUME, "steps": STEPS,
                                                       "replace": 1})["code"], "invalid_args")
        self.assertNoSideEffects()

    def test_param_of_another_track_and_missing_clip(self):
        error = self.h.error("envelope_set", {"clip": CLIP, "param": {"mixer": "volume", "track": T2}, "steps": STEPS})
        self.assertEqual(self.reason(error), "param_track_mismatch")
        self.assertEqual(self.h.error("envelope_set", {"clip": S(T0, 1), "param": VOLUME, "steps": STEPS})["code"],
                         "not_found")
        self.assertNoSideEffects()

    def test_batch_path_checks_per_op(self):
        error = self.batch_error("envelope_set", {"clip": CLIP, "param": VOLUME,
                                                  "steps": [{"time": 0, "duration": 1, "value": 7}]})
        self.assertEqual(error["code"], "out_of_range")
        self.assertFalse([e for e in self.h.song.log if "envelope" in e])


class ClearTests(EnvelopeCase):
    def test_clear_one(self):
        self.make(self.mixer.volume)
        self.make(self.mixer.panning)
        self.assertEqual(self.h.ok("envelope_clear", {"clip": CLIP, "param": PAN}), {})
        self.assertIsNone(self.clip.automation_envelope(self.mixer.panning))
        self.assertIsNotNone(self.clip.automation_envelope(self.mixer.volume))
        self.assertOneUndoStep()

    def test_clear_all(self):
        self.make(self.mixer.volume)
        self.make(self.mixer.panning)
        self.assertEqual(self.h.ok("envelope_clear_all", {"clip": CLIP}), {})
        self.assertEqual(self.clip._envelopes, [])
        self.assertOneUndoStep()

    def test_refusals(self):
        self.assertEqual(self.h.error("envelope_clear", {"clip": S(T0, 2), "param": VOLUME})["code"], "not_found")
        self.assertEqual(self.reason(self.h.error("envelope_clear", {"clip": CLIP, "param": {"mixer": "pan", "track": T2}})),
                         "param_track_mismatch")
        self.assertEqual(self.h.error("envelope_clear_all", {"clip": S(T0, 2)})["code"], "not_found")
        self.assertNoSideEffects()
        self.assertEqual(self.reason(self.batch_error("envelope_clear", {"clip": CLIP, "param": {"mixer": "pan", "track": T2}})),
                         "param_track_mismatch")
        self.assertFalse([e for e in self.h.song.log if "clear" in e])


if __name__ == "__main__":
    unittest.main()
