"""T3 review round 1: widened routing/duplicate guards, batch-level refusals, hygiene and fakes."""

import unittest

from remote_script.BatutaMCP import lom
from remote_script.BatutaMCP.recording_safety import RecordingSafety
from remote_script.BatutaMCP.errors import BatutaError
from remote_script.BatutaMCP.state import ScriptState

from unittest import mock

from .fake_lom import FakeClip, LomHarness
from .fakes import FakeRoutingType, FakeSong, FakeTrack

T0 = {"kind": "track", "index": 0}
T1 = {"kind": "track", "index": 1}
EARS = {"kind": "track", "index": 2}


def route(track, name):
    """Owner-style direct routing in the fake (bypasses the script)."""
    for item in track.available_input_routing_types:
        if item.display_name == name:
            track.input_routing_type = item
            return
    raise AssertionError(name)


def external_live(h):
    """Owner armed audio track 1 with its Ext. In input by hand."""
    h.song.tracks[1]._arm = True
    h.reset_log()


class Base(unittest.TestCase):
    def setUp(self):
        self.h = LomHarness()

    def reason(self, error):
        self.assertEqual(error["code"], "not_supported")
        return error["details"]["reason"]

    def assertClean(self):
        self.assertEqual((self.h.song.events, self.h.song.log), ([], []))


class RoutingWideningTests(Base):
    def test_owner_armed_audio_track_cannot_be_routed_to_an_external_input(self):
        audio = self.h.song.tracks[1]
        route(audio, "Resampling")
        audio._arm = True
        self.h.reset_log()
        error = self.h.error("routing_set", {"track": T1, "input_type": "Ext. In"})
        self.assertEqual(self.reason(error), "audio_arm_blocked")
        self.assertClean()
        self.assertEqual(audio.input_routing_type.display_name, "Resampling")

    def test_monitored_audio_track_cannot_be_routed_to_an_external_input(self):
        audio = self.h.song.tracks[1]
        route(audio, "1-MIDI")
        audio.current_monitoring_state = 0
        self.h.reset_log()
        error = self.h.error("routing_set", {"track": T1, "input_type": "Ext. In"})
        self.assertEqual(self.reason(error), "monitor_in_blocked")
        self.assertClean()

    def test_safe_targets_and_idle_tracks_stay_allowed(self):
        audio = self.h.song.tracks[1]
        route(audio, "Resampling")
        audio._arm = True
        self.h.ok("routing_set", {"track": T1, "input_type": "1-MIDI"})
        self.h.ok("routing_set", {"track": T1, "input_type": "No Input"})
        audio._arm = False
        self.h.ok("routing_set", {"track": T1, "input_type": "Ext. In"})

    def test_output_changes_are_not_affected(self):
        self.h.song.tracks[1]._arm = True
        self.h.ok("routing_set", {"track": T1, "output_type": "Ext. Out"})

    def test_refused_inside_batch_at_execution_time(self):
        audio = self.h.song.tracks[1]
        route(audio, "Resampling")
        audio._arm = True
        result = self.h.ok("batch", {"ops": [{"cmd": "routing_set",
                                              "args": {"track": T1, "input_type": "Ext. In"}}]})
        self.assertFalse(result["results"][0]["ok"])
        self.assertEqual(result["results"][0]["error"]["details"]["reason"], "audio_arm_blocked")


class DuplicateWideningTests(Base):
    def test_ears_track_cannot_be_duplicated(self):
        self.h.arm_ears()
        self.h.reset_log()
        error = self.h.error("track_duplicate", {"track": EARS})
        self.assertEqual(self.reason(error), "audio_arm_blocked")
        self.assertClean()

    def test_armed_audio_track_cannot_be_duplicated(self):
        audio = self.h.song.tracks[1]
        route(audio, "Resampling")
        audio._arm = True
        self.h.reset_log()
        self.assertEqual(self.reason(self.h.error("track_duplicate", {"track": T1})), "audio_arm_blocked")
        self.assertClean()
        self.assertEqual(len(self.h.song.tracks), 2)

    def test_same_refusals_inside_batch(self):
        self.h.arm_ears()
        self.h.song.tracks[1]._arm = True
        route(self.h.song.tracks[1], "Resampling")
        self.h.reset_log()
        for ref in (EARS, T1):
            result = self.h.ok("batch", {"ops": [{"cmd": "track_duplicate", "args": {"track": ref}}]})
            self.assertEqual(result["results"][0]["error"]["details"]["reason"], "audio_arm_blocked")
        self.assertNotIn("call:duplicate_track:2", self.h.song.log)

    def test_plain_unarmed_audio_and_armed_midi_can_be_duplicated(self):
        self.h.ok("track_duplicate", {"track": T1})
        self.h.song.tracks[0]._arm = True
        self.h.ok("track_duplicate", {"track": T0})


class BatchRefusalTests(Base):
    """Handler-side checks: a batch skips the precheck hook, so each op must refuse on its own."""

    def batch_error(self, name, args):
        response = self.h.run("batch", {"ops": [{"cmd": name, "args": args}]})
        self.assertFalse(response["ok"], (name, args))   # refused up front, nothing ran
        return response["error"]

    def test_scene_fire_empty_slot_on_armed_track(self):
        self.h.song.tracks[0]._arm = True
        external_live(self.h)
        error = self.batch_error("scene_fire", {"scene": 0})
        self.assertEqual(error["details"]["reason"], "external_input_live")
        self.assertFalse([e for e in self.h.song.log if e.startswith("call:scene.")])

    def test_scene_fire_transport_while_record_flags_on(self):
        external_live(self.h)
        for flag in ("record_mode", "session_record"):
            setattr(self.h.song, flag, True)
            self.h.reset_log()
            for name, args in (("scene_fire", {"scene": 1}), ("transport", {"action": "start"}),
                               ("transport", {"action": "continue"})):
                self.h.song.tracks[0].clip_slots[1].clip = FakeClip()
                error = self.batch_error(name, args)
                self.assertEqual(error["details"]["reason"], "external_input_live", (flag, name, args))
            self.assertFalse([e for e in self.h.song.log if "start_playing" in e or "scene." in e
                              or "continue_playing" in e])
            setattr(self.h.song, flag, False)

    def test_song_set_record_flags(self):
        external_live(self.h)
        for field in ("record_mode", "session_record", "arrangement_overdub"):
            error = self.batch_error("song_set", {field: True})
            self.assertEqual(error["details"]["reason"], "external_input_live", field)
            self.assertFalse(getattr(self.h.song, field))


class ArmEarsWithRecordingTests(Base):
    def test_ears_arm_refused_while_an_external_live_track_exists(self):
        self.h.arm_ears()
        route(self.h.song.tracks[2], "Resampling")
        external_live(self.h)
        error = self.h.error("track_set", {"track": EARS, "arm": True})
        self.assertEqual(self.reason(error), "external_input_live")
        self.assertClean()


class ReservedNameTests(Base):
    def test_variants_are_reserved(self):
        for name in ("Batuta-Ears", "batuta-ears ", " BATUTA-EARS", "BATUTA-ears\t".strip() + " "):
            self.h.reset_log()
            error = self.h.error("track_create", {"type": "audio", "name": name})
            self.assertEqual(error["details"]["reason"], "reserved_name", repr(name))
            error = self.h.error("track_set", {"track": T0, "name": name})
            self.assertEqual(error["details"]["reason"], "reserved_name", repr(name))
            self.assertClean()

    def test_internal_flag_needs_the_exact_name(self):
        error = self.h.error("track_create", {"type": "audio", "name": "Batuta-Ears",
                                               "ears_internal": True})
        self.assertEqual(error["details"]["reason"], "reserved_name")

    def test_unrelated_names_pass(self):
        self.h.ok("track_create", {"type": "audio", "name": "batuta ears"})


class SafeByCategoryTests(unittest.TestCase):
    def rs(self):
        state = ScriptState()
        track = FakeTrack("Vox", audio=True)
        song = FakeSong(tracks=[track])
        return RecordingSafety(state, lambda: song), track

    def typed(self, name, category):
        item = FakeRoutingType(name)
        item.category = category
        return item

    def test_category_wins_over_the_display_name(self):
        rs, track = self.rs()
        self.assertTrue(rs.is_input_safe(track, self.typed("Reamostragem", "resampling")))
        self.assertTrue(rs.is_input_safe(track, self.typed("Ohne Eingang", "No_Input")))
        self.assertFalse(rs.is_input_safe(track, self.typed("Resampling", "ext_in")))
        self.assertFalse(rs.is_input_safe(track, self.typed("No Input", "external")))

    def test_enum_category_is_read_through_its_name(self):
        rs, track = self.rs()
        self.assertTrue(rs.is_input_safe(track, self.typed("Reamostragem", EnumCategory("resampling"))))
        self.assertTrue(rs.is_input_safe(track, self.typed("x", EnumCategory("NoInput"))))
        self.assertFalse(rs.is_input_safe(track, self.typed("Resampling", EnumCategory("external_in"))))
        self.assertFalse(rs.is_input_safe(track, self.typed("No Input", EnumCategory("ext_in"))))

    def test_enum_without_a_usable_name_falls_back_to_the_english_name(self):
        rs, track = self.rs()
        self.assertTrue(rs.is_input_safe(track, self.typed("Resampling", EnumCategory(None))))
        self.assertFalse(rs.is_input_safe(track, self.typed("Reamostragem", EnumCategory(7))))

    def test_non_string_or_missing_category_falls_back_to_the_english_name(self):
        rs, track = self.rs()
        self.assertTrue(rs.is_input_safe(track, self.typed("Resampling", 3)))
        self.assertTrue(rs.is_input_safe(track, FakeRoutingType("No Input")))
        self.assertFalse(rs.is_input_safe(track, self.typed("Ext. In", 3)))
        self.assertFalse(rs.is_input_safe(track, FakeRoutingType("Reamostragem")))


class HygieneTests(Base):
    def test_scene_and_cue_names_are_cleaned_and_capped(self):
        dirty = "A\x00B‮C" + "x" * 300
        self.h.song.scenes[0].name = dirty
        self.h.song.add_cue(1.0, dirty)
        for name in (self.h.ok("scene_list")["items"][0]["name"],
                     self.h.ok("cue_list")["items"][0]["name"]):
            self.assertNotIn("\x00", name)
            self.assertNotIn("‮", name)
            self.assertLessEqual(len(name), 128)
            self.assertTrue(name.startswith("ABC"))

    def test_cue_delete_expect_time_tolerance_is_one_micro_beat(self):
        self.h.song.add_cue(4.0, "A")
        self.h.reset_log()
        error = self.h.error("cue_delete", {"index": 0, "expect_time": 4.0 + 2e-6})
        self.assertEqual(error["details"]["reason"], "time_mismatch")
        self.assertClean()
        self.h.ok("cue_delete", {"index": 0, "expect_time": 4.0 + 5e-7})

    def test_is_armed_fails_closed(self):
        class Raising:
            can_be_armed = True

            @property
            def arm(self):
                raise RuntimeError("unreadable")

        class Unarmable(Raising):
            can_be_armed = False

        class Plain:
            can_be_armed = True
            arm = False

        self.assertTrue(lom.is_armed(Raising()))
        self.assertFalse(lom.is_armed(Unarmable()))
        self.assertFalse(lom.is_armed(Plain()))

    def test_track_with_unreadable_arm_counts_as_armed_external_live(self):
        self.h.song.tracks[1]._arm_raises = True
        self.h.reset_log()
        error = self.h.error("trigger_session_record")
        self.assertEqual(error["details"]["reason"], "external_input_live")
        self.assertClean()

    def test_unreadable_arm_blocks_scene_fire_recording_check(self):
        self.h.song.tracks[1]._arm_raises = True  # fail closed: assumed armed, empty slot, external
        self.h.reset_log()
        self.assertEqual(self.h.error("scene_fire", {"scene": 0})["details"]["reason"],
                         "external_input_live")


class NearbyCueTests(Base):
    """Live toggles a cue within ~1e-3 beats of the playhead; the script refuses such neighbours."""

    def setUp(self):
        super().setUp()
        self.song = self.h.song
        self.song.add_cue(4.0, "A")
        self.song.add_cue(4.0005, "B")
        self.song._time = 2.5
        self.h.reset_log()

    def test_delete_of_the_second_close_cue_is_refused(self):
        error = self.h.error("cue_delete", {"index": 1, "expect_time": 4.0005})
        self.assertEqual((error["code"], error["details"]["reason"]), ("invalid_args", "cue_nearby"))
        self.assertEqual(error["details"]["nearby_cue"], {"name": "A", "time": 4.0})
        self.assertClean()
        self.assertEqual(len(self.song.cue_points), 2)

    def test_delete_of_the_first_close_cue_is_refused_too(self):
        error = self.h.error("cue_delete", {"index": 0})
        self.assertEqual(error["details"]["nearby_cue"]["name"], "B")
        self.assertClean()

    def test_create_next_to_a_cue_is_refused(self):
        for time in (4.0004, 4.0 - 9e-4, 4.00049):
            error = self.h.error("cue_create", {"time": time})
            self.assertEqual(error["details"]["reason"], "cue_nearby", time)
            self.assertIn("nearby_cue", error["details"])
            self.assertClean()
        self.h.ok("cue_create", {"time": 4.0 + 3e-3})

    def test_batch_path_refuses_per_op(self):
        for name, args in (("cue_delete", {"index": 1, "expect_time": 4.0005}),
                           ("cue_create", {"time": 4.0002})):
            result = self.h.ok("batch", {"ops": [{"cmd": name, "args": args}]})
            self.assertEqual(result["results"][0]["error"]["details"]["reason"], "cue_nearby", name)
        self.assertEqual([c.name for c in self.song.cue_points], ["A", "B"])
        self.assertNotIn("call:set_or_delete_cue", self.song.log)

    def test_cue_far_enough_apart_is_deletable(self):
        self.song.add_cue(9.0, "C")
        self.h.ok("cue_delete", {"index": 2, "expect_time": 9.0})

    def test_delete_verifies_which_cue_vanished(self):
        # If the precheck window were too small, Live removes A while we aimed at B: never report success.
        with mock.patch.object(lom, "CUE_TOGGLE_WINDOW", 1e-9):
            error = self.h.error("cue_delete", {"index": 1, "expect_time": 4.0005})
        self.assertEqual(error["code"], "lom_error")
        self.assertTrue(error["details"]["partial"])
        self.assertEqual(error["details"]["deleted_cue"], {"name": "A", "time": 4.0})
        self.assertEqual(self.song.current_song_time, 2.5)

    def test_create_backstop_reports_the_removed_cue(self):
        with mock.patch.object(lom, "CUE_TOGGLE_WINDOW", 1e-9):
            error = self.h.error("cue_create", {"time": 4.0004})
        self.assertEqual(error["details"]["deleted_cue"]["name"], "A")
        self.assertEqual(self.song.current_song_time, 2.5)


class EnumCategory:
    """Stands in for a Live enum member: not a string, but it has a `name`."""

    def __init__(self, name):
        self.name = name


class HandlerEditionRecheckTests(unittest.TestCase):
    """The batch precheck projects counts assuming earlier ops succeed; handlers re-check for real."""

    def lite(self, **kwargs):
        h = LomHarness(edition="lite", **kwargs)
        h.song.limits = {"tracks": 8, "scenes": 16, "returns": 2}
        h.reset_log()
        return h

    def failing_delete_then(self, h, delete, create):
        return h.ok("batch", {"stop_on_error": False, "ops": [delete, create]})

    def test_scene_create_duplicate_capture(self):
        for name, args in (("scene_create", {}), ("scene_duplicate", {"scene": 0}), ("scene_capture", {})):
            h = self.lite(scenes=16)
            result = self.failing_delete_then(
                h, {"cmd": "scene_delete", "args": {"scene": 0, "expect_name": "nope"}},
                {"cmd": name, "args": args})
            self.assertFalse(result["results"][0]["ok"])
            self.assertEqual(result["results"][1]["error"]["code"], "edition_limit", name)
            self.assertEqual(len(h.song.scenes), 16)
            self.assertFalse([e for e in h.song.log if "scene" in e and e.startswith("call:")], name)

    def test_track_create_duplicate_and_return(self):
        for name, args, kinds, returns in (("track_create", {"type": "midi"}, ["midi"] * 8, 1),
                                           ("track_duplicate", {"track": T0}, ["midi"] * 8, 1),
                                           ("track_create", {"type": "return"}, ["midi"], 2)):
            h = self.lite(kinds=kinds, returns=returns)
            target = {"kind": "return", "index": 0} if args.get("type") == "return" else T0
            result = self.failing_delete_then(
                h, {"cmd": "track_delete", "args": {"track": target, "expect_name": "nope"}},
                {"cmd": name, "args": args})
            self.assertEqual(result["results"][1]["error"]["code"], "edition_limit", (name, args))
            self.assertFalse([e for e in h.song.log if e.startswith("call:create") or
                              e.startswith("call:duplicate")])

    def test_fake_enforces_lite_limits_like_live(self):
        h = self.lite(kinds=["midi"] * 8)
        with self.assertRaises(RuntimeError):
            h.song.create_midi_track(-1)


class FakeCoverageTests(Base):
    def test_group_and_return_tracks_and_no_input_type(self):
        h = LomHarness(kinds=["midi", "midi", "audio"])
        h.song.make_group(0, [1])
        items = h.ok("track_list")["items"]
        self.assertTrue(items[0]["is_foldable"])
        self.assertEqual(items[1]["group_track_index"], 0)
        self.assertEqual(items[3]["kind"], "return")
        self.assertIn("No Input", h.ok("routing_get", {"track": T0})["input"]["available_types"])
        h.ok("routing_set", {"track": {"kind": "track", "index": 2}, "input_type": "No Input"})


if __name__ == "__main__":
    unittest.main()
