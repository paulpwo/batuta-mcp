"""T3 tests: tracks, mixer and routing commands (spec 7.2, 7.3) incl. edition and recording safety."""

import unittest

from remote_script.BatutaMCP.recording_safety import RecordingSafety  # noqa: F401  (import check)

from .fake_lom import FakeDeviceStub, LomHarness

T0 = {"kind": "track", "index": 0}
T1 = {"kind": "track", "index": 1}
R0 = {"kind": "return", "index": 0}
M = {"kind": "master"}


def lite_full(**kwargs):
    return LomHarness(edition="lite", kinds=["midi"] * 8, **kwargs)


class TrackCase(unittest.TestCase):
    def setUp(self):
        self.h = LomHarness()

    def assertNoSideEffects(self):
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.h.song.log, [])

    def refused(self, name, args, reason, code="not_supported"):
        self.h.reset_log()
        error = self.h.error(name, args)
        self.assertEqual(error["code"], code)
        self.assertEqual(error["details"]["reason"], reason)
        self.assertNoSideEffects()
        return error


class TrackListGetTests(TrackCase):
    def test_list_shape_and_order(self):
        result = self.h.ok("track_list")
        self.assertEqual(result["total"], 4)
        self.assertIsNone(result["next_offset"])
        kinds = [(t["kind"], t.get("index")) for t in result["items"]]
        self.assertEqual(kinds, [("track", 0), ("track", 1), ("return", 0), ("master", None)])
        midi = result["items"][0]
        self.assertEqual(midi, {
            "kind": "track", "index": 0, "name": "1-MIDI", "color": 0x336699, "mute": False,
            "solo": False, "arm": False, "can_be_armed": True, "has_midi_input": True,
            "has_audio_input": False, "is_foldable": False, "fold_state": None,
            "group_track_index": None, "monitoring_state": 1, "device_count": 0})

    def test_return_and_master_have_null_fields(self):
        items = self.h.ok("track_list")["items"]
        ret, master = items[2], items[3]
        for key in ("arm", "monitoring_state", "fold_state", "group_track_index"):
            self.assertIsNone(ret[key], key)
        self.assertEqual(ret["name"], "A-Return")
        self.assertFalse(ret["mute"])
        for key in ("arm", "color", "mute", "solo", "monitoring_state"):
            self.assertIsNone(master[key], key)
        self.assertEqual(master["name"], "Master")

    def test_filters_and_paging(self):
        self.assertEqual(self.h.ok("track_list", {"include_returns": False})["total"], 3)
        self.assertEqual(self.h.ok("track_list", {"include_master": False})["total"], 3)
        page = self.h.ok("track_list", {"limit": 2})
        self.assertEqual((len(page["items"]), page["next_offset"]), (2, 2))
        page = self.h.ok("track_list", {"limit": 2, "offset": 3})
        self.assertEqual((len(page["items"]), page["next_offset"]), (1, None))
        self.assertEqual(self.h.error("track_list", {"limit": 0})["code"], "invalid_args")
        self.assertEqual(self.h.error("track_list", {"limit": 501})["code"], "invalid_args")

    def test_group_track_index_and_foldable(self):
        song = self.h.song
        song.tracks[0].is_foldable = True
        song.tracks[1].group_track = song.tracks[0]
        items = self.h.ok("track_list")["items"]
        self.assertEqual(items[1]["group_track_index"], 0)
        self.assertTrue(items[0]["is_foldable"])
        self.assertEqual(items[0]["fold_state"], False)

    def test_get_with_devices_and_slots(self):
        self.h.song.tracks[0].devices = [FakeDeviceStub("EQ Eight", "Eq8", 2, params=3)]
        result = self.h.ok("track_get", {"track": T0})
        self.assertEqual(result["track"]["name"], "1-MIDI")
        self.assertEqual(result["devices"], [{
            "path": [0], "name": "EQ Eight", "class_name": "Eq8", "type": "audio_effect",
            "is_active": True, "can_have_chains": False, "can_have_drum_pads": False,
            "parameter_count": 3}])
        self.assertIsNone(result["slots"])
        full = self.h.ok("track_get", {"track": T0, "include_clips": True})
        self.assertEqual(len(full["slots"]), 2)
        self.assertEqual(full["slots"][0], {
            "track": T0, "slot": 0, "has_clip": False, "is_playing": False,
            "is_recording": False, "is_triggered": False, "clip": None})

    def test_device_types_use_live_values(self):
        # Live's DeviceType: 1 instrument, 2 audio effect, 4 MIDI effect (owner's Lite run: Chord
        # came back with type null).
        self.h.song.tracks[0].devices = [FakeDeviceStub("Chord", "MidiChord", 4),
                                         FakeDeviceStub("Rack", "InstrumentGroupDevice", 1)]
        devices = self.h.ok("track_get", {"track": T0})["devices"]
        self.assertEqual([d["type"] for d in devices], ["midi_effect", "instrument"])

    def test_get_slot_with_clip_summary(self):
        from .fake_lom import FakeClip
        self.h.song.tracks[0].clip_slots[1].clip = FakeClip("Loop", True)
        slot = self.h.ok("track_get", {"track": T0, "include_clips": True})["slots"][1]
        self.assertEqual(slot["clip"], {"name": "Loop", "color": 255, "length": 4.0,
                                        "is_midi": True, "is_audio": False,
                                        "looping": True, "muted": False})

    def test_get_return_and_master_have_no_slots(self):
        self.assertIsNone(self.h.ok("track_get", {"track": R0, "include_clips": True})["slots"])
        self.assertIsNone(self.h.ok("track_get", {"track": M, "include_clips": True})["slots"])

    def test_not_found_and_name_guard(self):
        error = self.h.error("track_get", {"track": {"kind": "track", "index": 9}})
        self.assertEqual(error["code"], "not_found")
        self.assertEqual(error["details"]["what"], "track")
        self.assertEqual(error["details"]["index"], 9)
        error = self.h.error("track_get", {"track": {"kind": "track", "index": 0, "expect_name": "x"}})
        self.assertEqual(error["code"], "not_found")
        self.assertEqual(error["details"]["reason"], "name_mismatch")
        self.h.ok("track_get", {"track": {"kind": "track", "index": 0, "expect_name": "1-MIDI"}})
        self.assertEqual(self.h.error("track_get", {"track": {"kind": "master", "expect_name": "x"}})
                         ["details"]["reason"], "name_mismatch")

    def test_bad_track_ref_shapes(self):
        for ref in ({"kind": "track"}, {"kind": "return", "index": -1}, {"kind": "group", "index": 0},
                    {"kind": "master", "index": 0}, 3, "x", {"kind": "track", "index": True}):
            self.assertEqual(self.h.error("track_get", {"track": ref})["code"], "invalid_args", ref)

    def test_reads_never_mutate(self):
        self.h.reset_log()
        self.h.ok("track_list")
        self.h.ok("track_get", {"track": T0, "include_clips": True})
        self.h.ok("track_get", {"track": M})
        self.assertNoSideEffects()

    def test_strings_from_live_are_cleaned(self):
        self.h.song.tracks[0].name = "A\x00B‮C" + "x" * 300
        name = self.h.ok("track_list")["items"][0]["name"]
        self.assertNotIn("\x00", name)
        self.assertNotIn("‮", name)
        self.assertLessEqual(len(name), 128)


class TrackCreateTests(TrackCase):
    def test_midi_appended_in_one_undo_step(self):
        result = self.h.ok("track_create", {"type": "midi"})
        self.assertEqual(result["track"]["kind"], "track")
        self.assertEqual(result["track"]["index"], 2)
        self.assertEqual(len(self.h.song.tracks), 3)
        self.assertIn("call:create_midi_track:-1", self.h.song.log)
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_audio_at_index_with_name_and_color(self):
        result = self.h.ok("track_create", {"type": "audio", "index": 0, "name": "Bass",
                                             "color": 255})
        self.assertEqual(result["track"]["index"], 0)
        self.assertEqual((result["track"]["name"], result["track"]["color"]), ("Bass", 255))
        self.assertEqual(self.h.song.tracks[0].name, "Bass")
        self.assertTrue(self.h.song.tracks[0].has_audio_input)

    def test_return_ignores_index(self):
        result = self.h.ok("track_create", {"type": "return", "index": 99})
        self.assertEqual(result["track"]["kind"], "return")
        self.assertEqual(result["track"]["index"], 1)
        self.assertEqual(len(self.h.song.return_tracks), 2)

    def test_invalid_args(self):
        bad = [{}, {"type": "group"}, {"type": "midi", "index": -2}, {"type": "midi", "name": "x" * 129},
               {"type": "midi", "color": 16777216}, {"type": "midi", "color": -1},
               {"type": "midi", "nope": 1}, {"type": "midi", "name": "a\x07"},
               {"type": "midi", "ears_internal": "yes"}]
        for args in bad:
            self.h.reset_log()
            self.assertEqual(self.h.error("track_create", args)["code"], "invalid_args", args)
            self.assertNoSideEffects()

    def test_index_beyond_count_is_out_of_range(self):
        self.h.reset_log()
        error = self.h.error("track_create", {"type": "midi", "index": 3})
        self.assertEqual(error["code"], "out_of_range")
        self.assertNoSideEffects()
        self.h.ok("track_create", {"type": "midi", "index": 2})

    def test_reserved_name_needs_the_internal_flag(self):
        self.h.reset_log()
        error = self.h.error("track_create", {"type": "audio", "name": "batuta-ears"})
        self.assertEqual((error["code"], error["details"]["reason"]), ("invalid_args", "reserved_name"))
        self.assertNoSideEffects()
        error = self.h.error("track_create", {"type": "audio", "name": "Other", "ears_internal": True})
        self.assertEqual(error["details"]["reason"], "reserved_name")
        error = self.h.error("track_create", {"type": "audio", "ears_internal": True})
        self.assertEqual(error["details"]["reason"], "reserved_name")
        self.assertNoSideEffects()

    def test_ears_flag_only_for_audio_tracks(self):
        self.h.reset_log()
        error = self.h.error("track_create", {"type": "midi", "name": "batuta-ears",
                                              "ears_internal": True})
        self.assertEqual(error["code"], "invalid_args")
        error = self.h.error("track_create", {"type": "return", "name": "batuta-ears",
                                              "ears_internal": True})
        self.assertEqual(error["code"], "invalid_args")
        self.assertNoSideEffects()

    def test_ears_track_is_registered_by_object_and_only_once(self):
        result = self.h.arm_ears()
        self.assertEqual(result["track"]["name"], "batuta-ears")
        self.assertIs(self.h.state.ears_track, self.h.song.tracks[-1])
        self.h.reset_log()
        error = self.h.error("track_create", {"type": "audio", "name": "batuta-ears",
                                              "ears_internal": True})
        self.assertEqual(error["details"]["reason"], "ears_exists")
        self.assertNoSideEffects()

    def test_ears_can_be_recreated_after_deleting_it(self):
        self.h.arm_ears()
        self.h.ok("track_delete", {"track": {"kind": "track", "index": 2, "expect_name": "batuta-ears"}})
        self.h.arm_ears()

    def test_edition_limit_lite_tracks(self):
        h = lite_full()
        for args in ({"type": "midi"}, {"type": "audio"}):
            h.reset_log()
            error = h.error("track_create", args)
            self.assertEqual(error["code"], "edition_limit")
            self.assertEqual(error["details"], {"resource": "tracks", "limit": 8, "current": 8,
                                                "edition": "lite"})
            self.assertEqual((h.song.events, h.song.log), ([], []))

    def test_last_free_slot_is_allowed(self):
        h = LomHarness(edition="lite", kinds=["midi"] * 7)
        h.ok("track_create", {"type": "midi"})
        self.assertEqual(len(h.song.tracks), 8)

    def test_ears_track_respects_edition_limit_and_creates_nothing(self):
        h = lite_full()
        error = h.error("track_create", {"type": "audio", "name": "batuta-ears", "ears_internal": True})
        self.assertEqual(error["code"], "edition_limit")
        self.assertEqual(len(h.song.tracks), 8)
        self.assertIsNone(h.state.ears_track)

    def test_edition_limit_lite_returns(self):
        h = LomHarness(edition="lite", returns=2)
        error = h.error("track_create", {"type": "return"})
        self.assertEqual(error["details"], {"resource": "returns", "limit": 2, "current": 2,
                                            "edition": "lite"})
        h = LomHarness(edition="lite", returns=1)
        h.ok("track_create", {"type": "return"})

    def test_unknown_edition_has_no_precheck(self):
        h = LomHarness(kinds=["midi"] * 9)
        h.ok("track_create", {"type": "midi"})

    def test_batch_projects_edition_counts_per_op(self):
        h = LomHarness(edition="lite", kinds=["midi"] * 7)
        error = h.error("batch", {"ops": [
            {"cmd": "track_create", "args": {"type": "midi"}},
            {"cmd": "track_create", "args": {"type": "midi"}}]})
        self.assertEqual(error["code"], "edition_limit")
        self.assertEqual(error["details"]["op_index"], 1)
        self.assertEqual((h.song.events, h.song.log), ([], []))

    def test_edition_limit_inside_batch_after_deletes_is_projected(self):
        h = LomHarness(edition="lite", kinds=["midi"] * 8)
        result = h.ok("batch", {"ops": [
            {"cmd": "track_delete", "args": {"track": T0}},
            {"cmd": "track_create", "args": {"type": "midi"}}]})
        self.assertEqual(result["executed"], 2)
        self.assertEqual(h.song.events, ["begin", "end"])


class TrackDeleteDuplicateTests(TrackCase):
    def test_delete_track(self):
        result = self.h.ok("track_delete", {"track": T1, "expect_name": "2-AUDIO"})
        self.assertEqual(result["deleted"], {"kind": "track", "index": 1, "name": "2-AUDIO"})
        self.assertEqual(len(self.h.song.tracks), 1)
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_delete_return(self):
        result = self.h.ok("track_delete", {"track": R0})
        self.assertEqual(result["deleted"]["kind"], "return")
        self.assertEqual(self.h.song.return_tracks, [])

    def test_guards_and_bad_targets(self):
        self.h.reset_log()
        error = self.h.error("track_delete", {"track": T1, "expect_name": "nope"})
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_found", "name_mismatch"))
        error = self.h.error("track_delete", {"track": {"kind": "track", "index": 1, "expect_name": "z"}})
        self.assertEqual(error["details"]["reason"], "name_mismatch")
        self.assertEqual(self.h.error("track_delete", {"track": {"kind": "track", "index": 7}})["code"],
                         "not_found")
        self.assertEqual(self.h.error("track_delete", {"track": M})["code"], "invalid_args")
        self.assertNoSideEffects()
        self.assertEqual(len(self.h.song.tracks), 2)

    def test_duplicate_ok(self):
        result = self.h.ok("track_duplicate", {"track": T0})
        self.assertEqual(result["created"], 1)
        self.assertEqual(result["track"]["index"], 1)
        self.assertEqual(result["track"]["name"], "1-MIDI Copy")
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_duplicate_only_regular_tracks(self):
        for ref in (R0, M):
            self.assertEqual(self.h.error("track_duplicate", {"track": ref})["code"], "invalid_args")

    def test_duplicate_edition_limit_and_group_children(self):
        h = lite_full()
        self.assertEqual(h.error("track_duplicate", {"track": T0})["code"], "edition_limit")
        h = LomHarness(edition="lite", kinds=["midi"] * 7)
        h.song.tracks[0].is_foldable = True
        h.song.tracks[1].group_track = h.song.tracks[0]
        h.song.tracks[2].group_track = h.song.tracks[0]
        error = h.error("track_duplicate", {"track": T0})
        self.assertEqual(error["code"], "edition_limit")
        self.assertEqual(error["details"]["current"], 7)
        self.assertEqual(h.song.events, [])
        h.ok("track_duplicate", {"track": {"kind": "track", "index": 3}})

    def test_group_duplicate_reports_created_count(self):
        h = LomHarness(kinds=["midi"] * 3)
        h.song.tracks[0].is_foldable = True
        h.song.tracks[1].group_track = h.song.tracks[0]
        result = h.ok("track_duplicate", {"track": T0})
        self.assertEqual(result["created"], 2)
        self.assertEqual(result["track"]["name"], "1-MIDI Copy")

    def test_duplicate_of_external_live_track_refused(self):
        self.h.song.tracks[1]._arm = True
        self.refused("track_duplicate", {"track": T1}, "external_input_live")
        self.assertEqual(len(self.h.song.tracks), 2)

    def test_duplicate_of_track_with_external_device_refused(self):
        self.h.song.tracks[0].devices = [FakeDeviceStub("External Instrument", "ExternalInstrument", 1)]
        self.refused("track_duplicate", {"track": T0}, "external_input_live")

    def test_duplicate_of_plain_track_allowed_while_other_track_external(self):
        self.h.song.tracks[1]._arm = True
        self.h.ok("track_duplicate", {"track": T0})


class TrackSetTests(TrackCase):
    def test_basic_properties(self):
        result = self.h.ok("track_set", {"track": T0, "name": "Lead", "color": 1234,
                                         "mute": True, "solo": True})["track"]
        self.assertEqual((result["name"], result["color"], result["mute"], result["solo"]),
                         ("Lead", 1234, True, True))
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_return_properties(self):
        result = self.h.ok("track_set", {"track": R0, "name": "Verb", "mute": True})["track"]
        self.assertEqual((result["kind"], result["name"], result["mute"]), ("return", "Verb", True))

    def test_master_accepts_no_fields(self):
        for args in ({"track": M, "name": "x"}, {"track": M, "mute": True}, {"track": M}):
            self.h.reset_log()
            self.assertEqual(self.h.error("track_set", args)["code"], "invalid_args", args)
            self.assertNoSideEffects()

    def test_needs_at_least_one_field_and_valid_types(self):
        bad = [{"track": T0}, {"track": T0, "mute": "yes"}, {"track": T0, "color": 2 ** 24},
               {"track": T0, "name": "x" * 129}, {"track": T0, "monitoring_state": 3},
               {"track": T0, "monitoring_state": -1}, {"track": T0, "fold_state": 2},
               {"track": T0, "extra": 1}]
        for args in bad:
            self.h.reset_log()
            self.assertEqual(self.h.error("track_set", args)["code"], "invalid_args", args)
            self.assertNoSideEffects()

    def test_arm_midi_track_allowed(self):
        self.assertTrue(self.h.ok("track_set", {"track": T0, "arm": True})["track"]["arm"])
        self.assertFalse(self.h.ok("track_set", {"track": T0, "arm": False})["track"]["arm"])

    def test_arm_audio_track_refused(self):
        self.refused("track_set", {"track": T1, "arm": True}, "audio_arm_blocked")
        self.assertFalse(self.h.song.tracks[1]._arm)

    def test_refusal_applies_before_any_field_is_written(self):
        self.refused("track_set", {"track": T1, "mute": True, "name": "z", "arm": True},
                     "audio_arm_blocked")
        self.assertFalse(self.h.song.tracks[1].mute)
        self.assertEqual(self.h.song.tracks[1].name, "2-AUDIO")

    def test_arm_on_return_is_refused_and_disarm_is_invalid(self):
        self.refused("track_set", {"track": R0, "arm": True}, "audio_arm_blocked")
        self.assertEqual(self.h.error("track_set", {"track": R0, "arm": False})["code"], "invalid_args")

    def test_arm_unarmable_midi_track_refused(self):
        self.h.song.tracks[0].can_be_armed = False
        self.refused("track_set", {"track": T0, "arm": True}, "audio_arm_blocked")

    def test_ears_track_arming_follows_input_safety(self):
        self.h.arm_ears()
        ears = {"kind": "track", "index": 2}
        self.refused("track_set", {"track": ears, "arm": True}, "audio_arm_blocked")  # Ext. In
        self.h.ok("routing_set", {"track": ears, "input_type": "Resampling"})
        self.assertTrue(self.h.ok("track_set", {"track": ears, "arm": True})["track"]["arm"])

    def test_ears_track_may_be_armed_with_a_track_input(self):
        self.h.arm_ears()
        ears = {"kind": "track", "index": 2}
        self.h.ok("routing_set", {"track": ears, "input_type": "1-MIDI", "input_channel": "Post Mixer"})
        self.h.ok("track_set", {"track": ears, "arm": True})

    def test_user_named_track_cannot_pretend_to_be_ears(self):
        self.h.song.tracks[1].name = "batuta-ears"  # renamed by hand in Live
        self.refused("track_set", {"track": T1, "arm": True}, "audio_arm_blocked")

    def test_renaming_the_real_ears_track_keeps_its_status(self):
        self.h.arm_ears()
        ears = {"kind": "track", "index": 2}
        self.h.ok("routing_set", {"track": ears, "input_type": "Resampling"})
        self.h.ok("track_set", {"track": ears, "name": "renamed"})
        self.h.ok("track_set", {"track": ears, "arm": True})

    def test_reserved_name_refused_on_rename(self):
        self.refused("track_set", {"track": T0, "name": "batuta-ears"}, "reserved_name",
                     code="invalid_args")

    def test_monitoring_in_refused_on_audio_but_not_midi(self):
        self.refused("track_set", {"track": T1, "monitoring_state": 0}, "monitor_in_blocked")
        self.assertEqual(self.h.ok("track_set", {"track": T0, "monitoring_state": 0})
                         ["track"]["monitoring_state"], 0)
        for state in (1, 2):
            self.assertEqual(self.h.ok("track_set", {"track": T1, "monitoring_state": state})
                             ["track"]["monitoring_state"], state)

    def test_monitoring_not_available_on_returns(self):
        self.assertEqual(self.h.error("track_set", {"track": R0, "monitoring_state": 1})["code"],
                         "invalid_args")

    def test_fold_state(self):
        self.assertEqual(self.h.error("track_set", {"track": T0, "fold_state": True})["code"],
                         "invalid_args")
        self.h.song.tracks[0].is_foldable = True
        self.assertTrue(self.h.ok("track_set", {"track": T0, "fold_state": True})["track"]["fold_state"])
        self.assertEqual(self.h.song.tracks[0].fold_state, 1)

    def test_not_found_and_guard(self):
        self.assertEqual(self.h.error("track_set", {"track": {"kind": "track", "index": 5}, "mute": True})
                         ["code"], "not_found")
        self.assertEqual(self.h.error("track_set", {"track": {"kind": "track", "index": 0,
                                                              "expect_name": "bad"}, "mute": True})
                         ["details"]["reason"], "name_mismatch")
        self.assertEqual(self.h.song.events, [])

    def test_batch_checks_arm_then_route_per_op_at_execution_time(self):
        self.h.arm_ears()
        ears = {"kind": "track", "index": 2}
        result = self.h.ok("batch", {"ops": [
            {"cmd": "routing_set", "args": {"track": ears, "input_type": "Resampling"}},
            {"cmd": "track_set", "args": {"track": ears, "arm": True}},
            {"cmd": "routing_set", "args": {"track": ears, "input_type": "Ext. In"}}]})
        flags = [r["ok"] for r in result["results"]]
        self.assertEqual(flags, [True, True, False])
        self.assertEqual(result["results"][2]["error"]["details"]["reason"], "audio_arm_blocked")
        self.assertTrue(result["partial"])

    def test_batch_arm_before_safe_routing_is_refused(self):
        self.h.arm_ears()
        ears = {"kind": "track", "index": 2}
        result = self.h.ok("batch", {"ops": [
            {"cmd": "track_set", "args": {"track": ears, "arm": True}},
            {"cmd": "routing_set", "args": {"track": ears, "input_type": "Resampling"}}]})
        self.assertFalse(result["results"][0]["ok"])
        self.assertEqual(result["executed"], 1)


class TrackSelectStopTests(TrackCase):
    def test_select(self):
        result = self.h.ok("track_select", {"track": T1})
        self.assertEqual(result, {"selected_track": T1})
        self.assertIs(self.h.song.view.selected_track, self.h.song.tracks[1])
        self.assertEqual(self.h.ok("track_select", {"track": M}), {"selected_track": M})
        self.assertEqual(self.h.ok("track_select", {"track": R0})["selected_track"], R0)
        self.assertEqual(self.h.undo_steps(), 3)

    def test_select_not_found(self):
        self.assertEqual(self.h.error("track_select", {"track": {"kind": "track", "index": 8}})["code"],
                         "not_found")
        self.assertEqual(self.h.song.events, [])

    def test_stop_clips_track_only(self):
        self.assertEqual(self.h.ok("track_stop_clips", {"track": T0}), {})
        self.assertIn("call:track.stop_all_clips", self.h.song.log)
        for ref in (R0, M):
            self.assertEqual(self.h.error("track_stop_clips", {"track": ref})["code"], "invalid_args")


class MixerGetTests(TrackCase):
    def test_track_mixer(self):
        result = self.h.ok("mixer_get", {"track": T0})
        self.assertEqual(result["volume"], {"value": 0.85, "min": 0.0, "max": 1.0,
                                            "display": "0.0 dB", "volume_db": 0.0})
        self.assertEqual(result["pan"], {"value": 0.0, "min": -1.0, "max": 1.0, "display": "C"})
        self.assertEqual(result["sends"], [{"index": 0, "name": "A-Return", "value": 0.0,
                                            "min": 0.0, "max": 1.0, "display": "-inf dB"}])
        self.assertTrue(result["track_activator"])
        self.assertEqual(result["crossfade_assign"], 1)
        self.assertIsNone(result["cue_volume"])
        self.assertIsNone(result["crossfader"])

    def test_master_mixer(self):
        result = self.h.ok("mixer_get", {"track": M})
        self.assertEqual(result["sends"], [])
        self.assertIsNone(result["crossfade_assign"])
        self.assertEqual(result["cue_volume"]["value"], 0.85)
        self.assertEqual(result["crossfader"]["min"], -1.0)

    def test_return_mixer(self):
        self.assertEqual(self.h.ok("mixer_get", {"track": R0})["sends"], [])

    def test_volume_db_is_null_for_inf_or_unparsable_text(self):
        mixer = self.h.song.tracks[0].mixer_device
        mixer.volume._value = 0.0
        self.assertIsNone(self.h.ok("mixer_get", {"track": T0})["volume"]["volume_db"])
        mixer.volume._text = lambda raw: "weird"
        self.assertIsNone(self.h.ok("mixer_get", {"track": T0})["volume"]["volume_db"])
        mixer.volume._text = lambda raw: "−6,5 dB"
        self.assertEqual(self.h.ok("mixer_get", {"track": T0})["volume"]["volume_db"], -6.5)

    def test_read_never_mutates(self):
        self.h.reset_log()
        for ref in (T0, R0, M):
            self.h.ok("mixer_get", {"track": ref})
        self.assertNoSideEffects()


class MixerSetTests(TrackCase):
    def mixer(self, index=0):
        return self.h.song.tracks[index].mixer_device

    def test_volume_pan_sends_in_one_undo_step(self):
        result = self.h.ok("mixer_set", {"track": T0, "volume": 0.5, "pan": -0.25,
                                         "sends": [{"index": 0, "value": 0.3}]})
        self.assertEqual(self.mixer().volume.value, 0.5)
        self.assertEqual(self.mixer().panning.value, -0.25)
        self.assertEqual(self.mixer().sends[0].value, 0.3)
        self.assertEqual(result["mixer"], self.h.ok("mixer_get", {"track": T0}))
        self.assertEqual(self.h.song.events, ["begin", "end"] + [])

    def test_volume_db_mapping(self):
        for target in (-60.0, -12.0, -6.0, 0.0, 3.0, 6.0):
            result = self.h.ok("mixer_set", {"track": T0, "volume_db": target})
            self.assertAlmostEqual(result["mixer"]["volume"]["volume_db"], target, delta=0.1)
        self.h.ok("mixer_set", {"track": T0, "volume_db": -70})
        self.assertLess(self.mixer().volume.value, 0.01)

    def test_volume_and_volume_db_are_exclusive(self):
        self.h.reset_log()
        self.assertEqual(self.h.error("mixer_set", {"track": T0, "volume": 0.5, "volume_db": -3})["code"],
                         "invalid_args")
        self.assertNoSideEffects()

    def test_out_of_range_values_are_not_clamped_and_leave_no_trace(self):
        cases = [({"volume": 1.5}, "volume", 0.0, 1.0), ({"volume": -0.1}, "volume", 0.0, 1.0),
                 ({"pan": 1.1}, "pan", -1.0, 1.0), ({"volume_db": 7}, "volume_db", -70, 6),
                 ({"volume_db": -70.5}, "volume_db", -70, 6),
                 ({"sends": [{"index": 0, "value": 2}]}, "send", 0.0, 1.0)]
        for fields, name, low, high in cases:
            self.h.reset_log()
            args = dict(fields, track=T0)
            error = self.h.error("mixer_set", args)
            self.assertEqual(error["code"], "out_of_range", fields)
            self.assertEqual((error["details"]["min"], error["details"]["max"]), (low, high))
            self.assertEqual(error["details"]["field"], name)
            self.assertNoSideEffects()
        self.assertEqual(self.mixer().volume.value, 0.85)

    def test_nothing_applied_when_a_later_field_is_invalid(self):
        self.assertEqual(self.h.error("mixer_set", {"track": T0, "volume": 0.2, "pan": 2})["code"],
                         "out_of_range")
        self.assertEqual(self.mixer().volume.value, 0.85)

    def test_send_errors(self):
        error = self.h.error("mixer_set", {"track": T0, "sends": [{"index": 1, "value": 0.1}]})
        self.assertEqual((error["code"], error["details"]["what"]), ("not_found", "send"))
        bad = [{"sends": []}, {"sends": [{"index": 0}]}, {"sends": [{"index": -1, "value": 0}]},
               {"sends": [{"index": 0, "value": 0.1}, {"index": 0, "value": 0.2}]},
               {"sends": [{"index": i, "value": 0} for i in range(13)]}, {}]
        for fields in bad:
            self.assertEqual(self.h.error("mixer_set", dict(fields, track=T0))["code"],
                             "invalid_args", fields)
        self.assertEqual(self.h.song.events, [])

    def test_crossfade_assign(self):
        self.h.ok("mixer_set", {"track": T0, "crossfade_assign": 2})
        self.assertEqual(self.mixer().crossfade_assign, 2)
        self.assertEqual(self.h.error("mixer_set", {"track": T0, "crossfade_assign": 3})["code"],
                         "invalid_args")
        self.assertEqual(self.h.error("mixer_set", {"track": M, "crossfade_assign": 1})["code"],
                         "invalid_args")

    def test_master_only_fields(self):
        self.h.ok("mixer_set", {"track": M, "cue_volume": 0.5, "crossfader": -0.5, "volume": 0.7})
        master = self.h.song.master_track.mixer_device
        self.assertEqual((master.cue_volume.value, master.crossfader.value, master.volume.value),
                         (0.5, -0.5, 0.7))
        for field, value in (("cue_volume", 0.5), ("crossfader", 0.0)):
            self.assertEqual(self.h.error("mixer_set", {"track": T0, field: value})["code"],
                             "invalid_args")
        self.assertEqual(self.h.error("mixer_set", {"track": M, "cue_volume": 2})["code"], "out_of_range")

    def test_returns_and_master_volume_pan(self):
        self.h.ok("mixer_set", {"track": R0, "volume": 0.4, "pan": 0.5})
        self.assertEqual(self.h.song.return_tracks[0].mixer_device.volume.value, 0.4)
        self.h.ok("mixer_set", {"track": M, "volume_db": -3})

    def test_volume_db_not_derivable(self):
        self.mixer().volume._text = lambda raw: "n/a"
        self.h.reset_log()
        error = self.h.error("mixer_set", {"track": T0, "volume_db": -6})
        self.assertEqual(error["code"], "invalid_args")
        self.assertNoSideEffects()

    def test_not_found_and_guard(self):
        self.assertEqual(self.h.error("mixer_set", {"track": {"kind": "return", "index": 4},
                                                    "volume": 0.5})["code"], "not_found")
        self.assertEqual(self.h.error("mixer_set", {"track": {"kind": "track", "index": 0,
                                                              "expect_name": "no"}, "volume": 0.5})
                         ["details"]["reason"], "name_mismatch")

    def test_catalog_marks_gain_guard_conditions(self):
        entry = {e["name"]: e for e in self.h.ok("catalog")["commands"]}["mixer_set"]
        self.assertEqual(entry["destructive"], "conditional")
        self.assertEqual(sorted(entry["conditions"]), ["volume", "volume_db"])


class RoutingTests(TrackCase):
    def test_get_midi_track(self):
        result = self.h.ok("routing_get", {"track": T0})
        self.assertEqual(result["input"], {"type": "All Ins", "channel": "-",
                                           "available_types": ["All Ins", "2-AUDIO", "No Input"],
                                           "available_channels": ["-"]})
        self.assertEqual(result["output"]["type"], "Master")
        self.assertEqual(result["output"]["available_types"], ["Master", "Ext. Out"])

    def test_get_audio_return_master(self):
        audio = self.h.ok("routing_get", {"track": T1})
        self.assertEqual(audio["input"]["available_types"], ["Ext. In", "Resampling", "1-MIDI", "No Input"])
        self.assertEqual(audio["input"]["available_channels"], ["1/2", "3/4"])
        self.assertIsNone(self.h.ok("routing_get", {"track": R0})["input"])
        master = self.h.ok("routing_get", {"track": M})
        self.assertIsNone(master["input"])
        self.assertEqual(master["output"]["type"], "Master")

    def test_get_never_mutates(self):
        self.h.reset_log()
        for ref in (T0, T1, R0, M):
            self.h.ok("routing_get", {"track": ref})
        self.assertNoSideEffects()

    def test_set_in_documented_order(self):
        result = self.h.ok("routing_set", {"track": T1, "input_type": "1-MIDI",
                                           "input_channel": "Post Mixer",
                                           "output_type": "Ext. Out", "output_channel": "3/4"})
        audio = self.h.song.tracks[1]
        self.assertEqual(audio.input_routing_type.display_name, "1-MIDI")
        self.assertEqual(audio.input_routing_channel.display_name, "Post Mixer")
        self.assertEqual(audio.output_routing_type.display_name, "Ext. Out")
        self.assertEqual(audio.output_routing_channel.display_name, "3/4")
        self.assertEqual(result["routing"], self.h.ok("routing_get", {"track": T1}))
        order = [e.split(".")[-1] for e in self.h.song.log if "routing" in e]
        self.assertEqual(order, ["input_routing_type", "input_routing_channel",
                                 "output_routing_type", "output_routing_channel"])
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_set_requires_a_field(self):
        self.assertEqual(self.h.error("routing_set", {"track": T0})["code"], "invalid_args")
        self.assertEqual(self.h.error("routing_set", {"track": T0, "input_type": 3})["code"], "invalid_args")

    def test_unknown_type_is_not_found_and_lists_options(self):
        self.h.reset_log()
        error = self.h.error("routing_set", {"track": T1, "input_type": "Nope"})
        self.assertEqual(error["code"], "not_found")
        self.assertIn("Resampling", error["details"]["available"])
        self.assertNoSideEffects()

    def test_unknown_channel_after_applying_type_reports_partial(self):
        error = self.h.error("routing_set", {"track": T1, "input_type": "1-MIDI", "input_channel": "Nope"})
        self.assertEqual(error["code"], "not_found")
        self.assertTrue(error["details"]["partial"])
        self.assertEqual(self.h.song.tracks[1].input_routing_type.display_name, "1-MIDI")

    def test_channel_only_uses_current_type(self):
        self.h.ok("routing_set", {"track": T1, "input_channel": "3/4"})
        self.assertEqual(self.h.song.tracks[1].input_routing_channel.display_name, "3/4")

    def test_ambiguous_names_are_never_auto_picked(self):
        self.h.song.tracks[0].name = "Ext. In"  # a track named like the external input (test j)
        self.h.reset_log()
        error = self.h.error("routing_set", {"track": T1, "input_type": "Ext. In"})
        self.assertEqual((error["code"], error["details"]["reason"]), ("invalid_args", "ambiguous_name"))
        self.assertEqual(len(error["details"]["candidates"]), 2)
        self.assertNoSideEffects()
        self.assertEqual(self.h.song.tracks[1].input_routing_type.display_name, "Ext. In")

    def test_ambiguous_duplicate_track_names(self):
        self.h.ok("track_create", {"type": "midi", "name": "Dup"})
        self.h.ok("track_create", {"type": "midi", "name": "Dup"})
        self.h.reset_log()
        self.assertEqual(self.h.error("routing_set", {"track": T1, "input_type": "Dup"})["details"]["reason"],
                         "ambiguous_name")
        self.assertNoSideEffects()

    def test_no_input_on_return_or_master(self):
        for ref in (R0, M):
            self.assertEqual(self.h.error("routing_set", {"track": ref, "input_type": "x"})["code"],
                             "invalid_args")
            self.assertEqual(self.h.error("routing_set", {"track": ref, "input_channel": "x"})["code"],
                             "invalid_args")
        self.assertEqual(self.h.song.events, [])

    def test_output_routing_on_return(self):
        self.h.ok("routing_set", {"track": R0, "output_type": "Ext. Out", "output_channel": "3/4"})
        self.assertEqual(self.h.song.return_tracks[0].output_routing_channel.display_name, "3/4")

    def test_armed_ears_track_cannot_be_routed_to_an_external_input(self):
        self.h.arm_ears()
        ears = {"kind": "track", "index": 2}
        self.h.ok("routing_set", {"track": ears, "input_type": "Resampling"})
        self.h.ok("track_set", {"track": ears, "arm": True})
        self.h.reset_log()
        error = self.h.error("routing_set", {"track": ears, "input_type": "Ext. In"})
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "audio_arm_blocked"))
        self.assertNoSideEffects()
        self.h.ok("routing_set", {"track": ears, "input_type": "1-MIDI"})

    def test_unarmed_ears_track_may_be_routed_anywhere(self):
        self.h.arm_ears()
        self.h.ok("routing_set", {"track": {"kind": "track", "index": 2}, "input_type": "Ext. In"})


if __name__ == "__main__":
    unittest.main()
