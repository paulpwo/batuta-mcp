"""T3 cross-cutting checks: every spec section 7 command of group A is registered with the exact
classification, mutating commands open exactly one undo step, reads never mutate, and the
command set offers no save/open/export/generic-property access."""

import unittest

from remote_script.BatutaMCP.command_set import build_registry

from .fake_lom import LomHarness

T0 = {"kind": "track", "index": 0}
T1 = {"kind": "track", "index": 1}
R0 = {"kind": "return", "index": 0}
M = {"kind": "master"}

# name -> (mutating, destructive, conditions); straight from the spec section 7 tables.
SPEC_GROUP_A = {
    # 7.1 session, transport, meta (batch and catalog belong to the core)
    "song_info": (False, "never", ()), "song_set": (True, "never", ()),
    "transport": (True, "never", ()), "song_set_time": (True, "never", ()),
    "stop_all_clips": (True, "never", ()), "back_to_arranger": (True, "never", ()),
    "capture_midi": (True, "never", ()), "trigger_session_record": (True, "never", ()),
    "re_enable_automation": (True, "never", ()),
    # 7.2 tracks
    "track_list": (False, "never", ()), "track_get": (False, "never", ()),
    "track_create": (True, "never", ()), "track_delete": (True, "always", ()),
    "track_duplicate": (True, "never", ()), "track_set": (True, "never", ()),
    "track_select": (True, "never", ()), "track_stop_clips": (True, "never", ()),
    # 7.3 mixer and routing
    "mixer_get": (False, "never", ()), "mixer_set": (True, "conditional", ("volume", "volume_db")),
    "routing_get": (False, "never", ()), "routing_set": (True, "never", ()),
    # 7.4 scenes
    "scene_list": (False, "never", ()), "scene_create": (True, "never", ()),
    "scene_delete": (True, "always", ()), "scene_duplicate": (True, "never", ()),
    "scene_set": (True, "never", ()), "scene_fire": (True, "never", ()),
    "scene_capture": (True, "never", ()),
    # 7.5 cue points
    "cue_list": (False, "never", ()), "cue_create": (True, "never", ()),
    "cue_delete": (True, "always", ()), "cue_set": (True, "never", ()),
    "cue_jump": (True, "never", ()),
    # 7.13 undo and redo
    "undo_state": (False, "never", ()), "undo": (True, "conditional", ("steps",)),
    "redo": (True, "never", ()),
    # 7.14 meters
    "meters_get": (False, "never", ()),
}
NOT_WRAPPED = {"undo", "redo"}
# Wait for Live ticks, so they open their own undo step around the writes (still exactly one).
SELF_WRAPPED = {"transport", "cue_create", "cue_delete", "song_set_time", "cue_jump"}

# Valid sample arguments for every command (a fresh harness: 2 tracks, 1 return, 2 scenes, 1 cue).
SAMPLES = {
    "song_info": {}, "song_set": {"tempo": 99}, "transport": {"action": "start"},
    "song_set_time": {"time": 4}, "stop_all_clips": {}, "back_to_arranger": {},
    "capture_midi": {}, "trigger_session_record": {}, "re_enable_automation": {},
    "track_list": {}, "track_get": {"track": T0}, "track_create": {"type": "midi"},
    "track_delete": {"track": T1}, "track_duplicate": {"track": T0},
    "track_set": {"track": T0, "mute": True}, "track_select": {"track": T1},
    "track_stop_clips": {"track": T0},
    "mixer_get": {"track": M}, "mixer_set": {"track": T0, "volume": 0.5},
    "routing_get": {"track": T1}, "routing_set": {"track": T1, "output_type": "Ext. Out"},
    "scene_list": {}, "scene_create": {}, "scene_delete": {"scene": 1},
    "scene_duplicate": {"scene": 0}, "scene_set": {"scene": 0, "name": "x"},
    "scene_fire": {"scene": 0}, "scene_capture": {},
    "cue_list": {}, "cue_create": {"time": 8}, "cue_delete": {"index": 0},
    "cue_set": {"index": 0, "name": "n"}, "cue_jump": {"index": 0},
    "undo_state": {}, "undo": {}, "redo": {}, "meters_get": {"all": True},
}

FORBIDDEN_NAMES = ("save", "open", "export", "get_property", "set_property", "get_attr", "set_attr",
                   "eval", "exec", "call", "property_get", "property_set")


def fresh():
    h = LomHarness()
    h.song.add_cue(4.0, "A")
    h.song.undo_stack = ["a"]
    h.song.redo_stack = ["b"]
    h.reset_log()
    return h


class CatalogCoverageTests(unittest.TestCase):
    def test_every_spec_command_is_registered_with_the_exact_classification(self):
        registry = build_registry()
        entries = {e["name"]: e for e in registry.catalog_entries()}
        missing = sorted(set(SPEC_GROUP_A) - set(entries))
        self.assertEqual(missing, [])
        for name, (mutating, destructive, conditions) in SPEC_GROUP_A.items():
            entry = entries[name]
            self.assertEqual(entry["mutating"], mutating, name)
            self.assertEqual(entry["destructive"], destructive, name)
            self.assertEqual(sorted(entry["conditions"]), sorted(conditions), name)

    def test_group_a_has_37_commands_and_samples_cover_them_all(self):
        self.assertEqual(len(SPEC_GROUP_A), 37)
        self.assertEqual(set(SAMPLES), set(SPEC_GROUP_A))

    def test_no_dangerous_command_names(self):
        for name in build_registry().names():
            for word in FORBIDDEN_NAMES:
                self.assertNotIn(word, name.split("_"), name)

    def test_undo_wrapping_flags(self):
        registry = build_registry()
        for name in SPEC_GROUP_A:
            self.assertEqual(registry.get(name).undo_wrapped, name not in NOT_WRAPPED | SELF_WRAPPED, name)

    def test_edition_deltas_declared_for_batch_projection(self):
        registry = build_registry()
        self.assertEqual(registry.get("track_create").edition_delta({"type": "midi"}), {"tracks": 1})
        self.assertEqual(registry.get("track_create").edition_delta({"type": "return"}), {"returns": 1})
        self.assertEqual(registry.get("track_delete").edition_delta({"track": T0}), {"tracks": -1})
        self.assertEqual(registry.get("track_delete").edition_delta({"track": R0}), {"returns": -1})
        self.assertEqual(registry.get("track_duplicate").edition_delta({"track": T0}), {"tracks": 1})
        for name in ("scene_create", "scene_duplicate", "scene_capture"):
            self.assertEqual(registry.get(name).edition_delta({"scene": 0}), {"scenes": 1}, name)
        self.assertEqual(registry.get("scene_delete").edition_delta({"scene": 0}), {"scenes": -1})
        self.assertIsNone(registry.get("track_set").edition_delta)


class UndoStepCountTests(unittest.TestCase):
    def test_each_mutating_command_opens_exactly_one_undo_step(self):
        for name, (mutating, _, _) in SPEC_GROUP_A.items():
            if not mutating:
                continue
            h = fresh()
            response = h.run(name, SAMPLES[name])
            self.assertTrue(response["ok"], (name, response))
            expected = [] if name in NOT_WRAPPED else ["begin", "end"]
            self.assertEqual(h.song.events, expected, name)

    def test_reads_never_mutate_or_open_an_undo_step(self):
        for name, (mutating, _, _) in SPEC_GROUP_A.items():
            if mutating:
                continue
            h = fresh()
            response = h.run(name, SAMPLES[name])
            self.assertTrue(response["ok"], (name, response))
            self.assertEqual((h.song.events, h.song.log), ([], []), name)

    def test_prechecks_reject_without_an_undo_step_or_write(self):
        rejects = [
            ("track_create", {"type": "midi", "index": 99}),
            ("track_delete", {"track": T1, "expect_name": "wrong"}),
            ("track_set", {"track": T1, "arm": True}),
            ("mixer_set", {"track": T0, "volume": 5}),
            ("routing_set", {"track": T1, "input_type": "nope"}),
            ("scene_delete", {"scene": 1, "expect_name": "wrong"}),
            ("scene_set", {"scene": 9, "name": "x"}),
            ("cue_delete", {"index": 5}),
            ("cue_set", {"index": 5, "name": "x"}),
            ("track_select", {"track": {"kind": "track", "index": 9}}),
            ("transport", {"action": "pause"}),
        ]
        for name, args in rejects:
            h = fresh()
            response = h.run(name, args)
            self.assertFalse(response["ok"], name)
            self.assertEqual((h.song.events, h.song.log), ([], []), name)

    def test_every_mutating_command_note_mutation_marks_partial_on_late_failure(self):
        h = fresh()

        def boom(index):
            raise RuntimeError("late failure")
        h.song.delete_track = boom
        error = h.error("track_delete", {"track": T1})
        self.assertEqual(error["code"], "lom_error")
        self.assertTrue(error["details"]["partial"])
        self.assertEqual(h.song.events, ["begin", "end"])


class RecordingSafetyMatrixTests(unittest.TestCase):
    """Spec 5.6 rule 4: with an external-live track every record-start command is refused."""

    def external_live(self):
        h = fresh()
        h.song.tracks[1]._arm = True
        h.reset_log()
        return h

    def test_record_start_commands_are_refused(self):
        refused = [("song_set", {"record_mode": True}), ("song_set", {"session_record": True}),
                   ("song_set", {"arrangement_overdub": True}), ("trigger_session_record", {}),
                   ("trigger_session_record", {"record_length": 4}),
                   ("batch", {"ops": [{"cmd": "trigger_session_record", "args": {}}],
                              "stop_on_error": True})]
        for name, args in refused:
            h = self.external_live()
            response = h.run(name, args)
            if name == "batch":   # refused up front: nothing ran
                self.assertEqual(response["error"]["details"]["reason"], "external_input_live")
                self.assertEqual((h.song.events, h.song.log), ([], []))
                continue
            self.assertEqual(response["error"]["details"]["reason"], "external_input_live", (name, args))
            self.assertEqual((h.song.events, h.song.log), ([], []), (name, args))

    def test_other_commands_stay_allowed(self):
        h = self.external_live()
        for name, args in (("mixer_set", {"track": T0, "volume": 0.4}),
                           ("transport", {"action": "start"}), ("song_set", {"tempo": 90}),
                           ("scene_set", {"scene": 0, "name": "ok"}),
                           ("track_set", {"track": T0, "mute": True})):
            self.assertTrue(h.run(name, args)["ok"], name)

    def test_external_device_in_a_rack_chain_counts_as_external_live(self):
        from .fakes import FakeChain, FakeDevice
        h = fresh()
        rack = FakeDevice("Rack", "AudioEffectGroupDevice",
                          chains=[FakeChain([FakeDevice("External Audio Effect", "ExternalAudioEffect")])])
        h.song.return_tracks[0].devices = [rack]
        h.reset_log()
        self.assertEqual(h.error("trigger_session_record")["details"]["reason"], "external_input_live")


if __name__ == "__main__":
    unittest.main()
