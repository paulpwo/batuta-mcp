"""T4a cross-cutting checks: every spec 7.6, 7.7 and 7.11 command is registered with the exact
classification, mutating commands open one undo step and none on a precheck rejection (also inside
batch), reads never mutate, and the Appendix A caps hold."""

import unittest

from remote_script.BatutaMCP.command_set import build_registry

from .clip_world import A, IMPORT, S, T0, T1, T2, M, put_arrangement, world
from .test_cmds_catalog_t3 import FORBIDDEN_NAMES

VOLUME = {"mixer": "volume", "track": T0}
STEPS = [{"time": 0, "duration": 1, "value": 0.5}]
NOTE = {"pitch": 60, "start_time": 0, "duration": 1}
FILE = "/Samples/a.wav"

# name -> (mutating, destructive, conditions); straight from the spec tables 7.6, 7.7 and 7.11.
SPEC_T4A = {
    "clip_list": (False, "never", ()), "clip_get": (False, "never", ()), "slot_status": (False, "never", ()),
    "clip_create": (True, "never", ()), "audio_clip_create": (True, "conditional", ("allow_overwrite",)),
    "clip_delete": (True, "always", ()), "clip_duplicate": (True, "conditional", ("allow_overwrite",)),
    "clip_set": (True, "never", ()), "clip_crop": (True, "always", ()), "clip_duplicate_loop": (True, "never", ()),
    "slot_fire": (True, "never", ()), "slot_stop": (True, "never", ()),
    "notes_get": (False, "never", ()), "notes_add": (True, "never", ()), "notes_remove": (True, "always", ()),
    "notes_modify": (True, "never", ()), "notes_quantize": (True, "never", ()),
    "envelope_list": (False, "never", ()), "envelope_get": (False, "never", ()),
    "envelope_set": (True, "conditional", ("replace",)), "envelope_clear": (True, "always", ()),
    "envelope_clear_all": (True, "always", ()),
    "arrangement_clips": (False, "never", ()), "arrangement_clip_create": (True, "never", ()),
    "arrangement_duplicate": (True, "conditional", ("allow_overwrite",)),
    "arrangement_commit_scene": (True, "conditional", ("allow_overwrite",)),
}

SAMPLES = {
    "clip_list": {"track": T0}, "clip_get": {"clip": S(T0, 0)}, "slot_status": {"track": T0, "slot": 0},
    "clip_create": {"track": T0, "slot": 1, "length": 4},
    "audio_clip_create": {"track": T1, "slot": 1, "file_path": FILE},
    "clip_delete": {"clip": S(T0, 0)},
    "clip_duplicate": {"from": {"track": T0, "slot": 0}, "to": {"track": T0, "slot": 1}},
    "clip_set": {"clip": S(T0, 0), "name": "x"}, "clip_crop": {"clip": S(T0, 0)},
    "clip_duplicate_loop": {"clip": S(T0, 0)}, "slot_fire": {"track": T0, "slot": 0},
    "slot_stop": {"track": T0, "slot": 0}, "notes_get": {"clip": S(T0, 0)},
    "notes_add": {"clip": S(T0, 0), "notes": [NOTE]}, "notes_remove": {"clip": S(T0, 0)},
    "notes_modify": {"clip": S(T0, 0), "notes": [{"note_id": 1, "velocity": 90}]},
    "notes_quantize": {"clip": S(T0, 0), "grid": "1/8"},
    "envelope_list": {"clip": S(T0, 0)}, "envelope_get": {"clip": S(T0, 0), "param": VOLUME},
    "envelope_set": {"clip": S(T0, 0), "param": VOLUME, "steps": STEPS},
    "envelope_clear": {"clip": S(T0, 0), "param": VOLUME}, "envelope_clear_all": {"clip": S(T0, 0)},
    "arrangement_clips": {"track": T0}, "arrangement_clip_create": {"track": T2, "start": 0, "length": 4},
    "arrangement_duplicate": {"source": S(T0, 0), "track": T0, "time": 0},
    "arrangement_commit_scene": {"scene": 0, "time": 32},
}

# One LOM-dependent refusal per mutating command: it must happen before the undo step opens.
REJECTED = {
    "clip_create": {"track": T0, "slot": 0, "length": 4},
    "audio_clip_create": {"track": T0, "slot": 1, "file_path": FILE},
    "clip_delete": {"clip": S(T0, 1)},
    "clip_duplicate": {"from": {"track": T0, "slot": 0}, "to": {"track": T0, "slot": 0}},
    "clip_set": {"clip": S(T0, 0), "loop_start": 9},
    "clip_crop": {"clip": S(T0, 1)},
    "clip_duplicate_loop": {"clip": A(T0, 0)},
    "slot_fire": {"track": T0, "slot": 9}, "slot_stop": {"track": T0, "slot": 9},
    "notes_add": {"clip": S(T1, 0), "notes": [NOTE]}, "notes_remove": {"clip": S(T1, 0)},
    "notes_modify": {"clip": S(T0, 0), "notes": [{"note_id": 99, "velocity": 5}]},
    "notes_quantize": {"clip": S(T1, 0), "grid": "1/8"},
    "envelope_set": {"clip": A(T0, 0), "param": VOLUME, "steps": STEPS},
    "envelope_clear": {"clip": A(T0, 0), "param": VOLUME}, "envelope_clear_all": {"clip": A(T0, 0)},
    "arrangement_clip_create": {"track": T1, "start": 0, "length": 4},
    "arrangement_duplicate": {"source": S(T0, 0), "track": T0, "time": 8},
    "arrangement_commit_scene": {"scene": 0, "time": 8},
}


def fresh():
    h = world(IMPORT)
    put_arrangement(h, 0, 8.0, 4.0, True, "Arr")
    return h


class CatalogCoverageTests(unittest.TestCase):
    def test_every_spec_command_is_registered_with_the_exact_classification(self):
        entries = {e["name"]: e for e in build_registry().catalog_entries()}
        self.assertEqual(sorted(set(SPEC_T4A) - set(entries)), [])
        for name, (mutating, destructive, conditions) in SPEC_T4A.items():
            entry = entries[name]
            self.assertEqual(entry["mutating"], mutating, name)
            self.assertEqual(entry["destructive"], destructive, name)
            self.assertEqual(sorted(entry["conditions"]), sorted(conditions), name)

    def test_group_has_26_commands_and_samples_cover_them_all(self):
        self.assertEqual(len(SPEC_T4A), 26)  # 17 clips and notes + 5 envelopes + 4 arrangement
        self.assertEqual(set(SAMPLES), set(SPEC_T4A))
        self.assertEqual(set(REJECTED), {n for n, spec in SPEC_T4A.items() if spec[0]})

    def test_no_dangerous_command_names(self):
        for name in build_registry().names():
            for word in FORBIDDEN_NAMES:
                self.assertNotIn(word, name.split("_"), name)

    def test_all_group_commands_are_undo_wrapped(self):
        registry = build_registry()
        # arrangement_duplicate / arrangement_commit_scene open their own step: they wait for the
        # playhead restore (T9j), and still make exactly one undo step.
        self_wrapped = {"arrangement_duplicate", "arrangement_commit_scene"}
        for name in SPEC_T4A:
            self.assertEqual(registry.get(name).undo_wrapped, name not in self_wrapped, name)

    def test_edition_deltas_for_batch_projection(self):
        registry = build_registry()
        duplicate = registry.get("clip_duplicate").edition_delta
        self.assertEqual(duplicate({"from": {"track": T0, "slot": 0}}), {"scenes": 1})
        self.assertIsNone(duplicate({"from": {"track": T0, "slot": 0}, "to": {"track": T0, "slot": 1}}))
        for name in SPEC_T4A:
            if name != "clip_duplicate":
                self.assertIsNone(registry.get(name).edition_delta, name)

    def test_the_only_path_bearing_command_is_audio_clip_create(self):
        registry = build_registry()
        for name in SPEC_T4A:
            self.assertEqual("file_path" in str(registry.get(name).schema), name == "audio_clip_create", name)


class UndoStepTests(unittest.TestCase):
    def test_each_mutating_command_opens_exactly_one_undo_step(self):
        for name, (mutating, _, _) in SPEC_T4A.items():
            if not mutating:
                continue
            h = fresh()
            response = h.run(name, SAMPLES[name])
            self.assertTrue(response["ok"], (name, response))
            self.assertEqual(h.song.events, ["begin", "end"], name)

    def test_reads_never_mutate(self):
        for name, (mutating, _, _) in SPEC_T4A.items():
            if mutating:
                continue
            h = fresh()
            self.assertTrue(h.run(name, SAMPLES[name])["ok"], name)
            self.assertEqual((h.song.events, h.song.log), ([], []), name)

    def test_rejections_happen_before_any_undo_step_or_write(self):
        for name, args in REJECTED.items():
            h = fresh()
            response = h.run(name, args)
            self.assertFalse(response["ok"], name)
            self.assertIn(response["error"]["code"], ("invalid_args", "not_found", "not_supported"), name)
            self.assertEqual((h.song.events, h.song.log), ([], []), name)

    def test_the_same_rejections_hold_per_op_inside_batch(self):
        for name, args in REJECTED.items():
            h = fresh()
            result = h.ok("batch", {"ops": [{"cmd": name, "args": args}]})
            self.assertFalse(result["results"][0]["ok"], name)
            self.assertEqual(h.song.events, ["begin", "end"], name)  # the batch's own single step
            self.assertEqual(h.song.log, [], name)  # but the refused op wrote nothing


class RecordingSafetyInBatchTests(unittest.TestCase):
    def test_slot_fire_guards_hold_inside_batch(self):
        h = fresh()
        h.song.tracks[1]._arm = True
        h.reset_log()
        for args in ({"track": T0, "slot": 0, "record_length": 4}, {"track": T0, "slot": 1, "record_length": 4}):
            response = h.run("batch", {"ops": [{"cmd": "slot_fire", "args": args}]})
            self.assertEqual(response["error"]["details"]["reason"], "external_input_live")  # up front
        self.assertEqual(h.song.log, [])


class CapTests(unittest.TestCase):
    def test_appendix_a_caps(self):
        h = fresh()
        note = dict(NOTE)
        self.assertEqual(h.ok("notes_add", {"clip": S(T0, 0), "notes": [note] * 2000}), {"added": 2000})
        for name, args in (("notes_add", {"clip": S(T0, 0), "notes": [note] * 2001}),
                           ("notes_modify", {"clip": S(T0, 0), "notes": [{"note_id": 1, "velocity": 5}] * 2001}),
                           ("notes_remove", {"clip": S(T0, 0), "note_ids": list(range(2001))}),
                           ("notes_get", {"clip": S(T0, 0), "limit": 5001}),
                           ("envelope_set", {"clip": S(T0, 0), "param": VOLUME, "steps": STEPS * 1025}),
                           ("envelope_get", {"clip": S(T0, 0), "param": VOLUME, "points": 513}),
                           ("clip_list", {"track": T0, "limit": 501}),
                           ("arrangement_clips", {"track": T0, "limit": 501})):
            self.assertEqual(h.error(name, args)["code"], "invalid_args", name)
        h.ok("notes_get", {"clip": S(T0, 0), "limit": 5000})
        h.ok("envelope_get", {"clip": S(T0, 0), "param": VOLUME, "points": 512})
        h.ok("envelope_set", {"clip": S(T0, 0), "param": VOLUME,
                              "steps": [{"time": 0, "duration": 0.001, "value": 0.5}] * 1024})

    def test_note_response_stays_under_the_frame_limit(self):
        h = fresh()
        h.ok("notes_add", {"clip": S(T0, 0), "notes": [dict(NOTE, start_time=i / 7.0, pitch=i % 128,
                                                              velocity=100.123456789, probability=0.123456789)
                                                         for i in range(2000)]})
        page = h.ok("notes_get", {"clip": S(T0, 0), "time_span": 10000, "limit": 5000})
        import json
        self.assertLess(len(json.dumps(page)), 1_048_576)


if __name__ == "__main__":
    unittest.main()
