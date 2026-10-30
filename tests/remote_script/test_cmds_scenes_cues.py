"""T3 tests: scenes (spec 7.4) and cue points (spec 7.5)."""

import unittest
from unittest import mock

from remote_script.BatutaMCP.dispatcher import Job, RunningJob

from .fake_lom import FakeClip, LomHarness

S = {"kind": "track", "index": 0}


class SceneCase(unittest.TestCase):
    def setUp(self):
        self.h = LomHarness()

    def assertNoSideEffects(self):
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.h.song.log, [])


class SceneListCreateTests(SceneCase):
    def test_list_shape_paging_and_no_mutation(self):
        self.h.reset_log()
        result = self.h.ok("scene_list")
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["items"][0], {"index": 0, "name": "Scene 1", "color": 0x222222,
                                              "tempo": None, "time_signature": None,
                                              "is_triggered": False})
        page = self.h.ok("scene_list", {"limit": 1})
        self.assertEqual((len(page["items"]), page["next_offset"]), (1, 1))
        self.assertNoSideEffects()

    def test_enabled_tempo_and_signature_are_reported(self):
        scene = self.h.song.scenes[1]
        scene.tempo, scene.tempo_enabled = 130.0, True
        scene.time_signature_numerator, scene.time_signature_denominator = 3, 4
        scene.time_signature_enabled = True
        item = self.h.ok("scene_list")["items"][1]
        self.assertEqual((item["tempo"], item["time_signature"]), (130.0, [3, 4]))

    def test_tempo_without_enabled_flag_uses_positive_value(self):
        for scene in self.h.song.scenes:
            del scene.tempo_enabled
        self.h.song.scenes[0].tempo = 128.0
        items = self.h.ok("scene_list")["items"]
        self.assertEqual((items[0]["tempo"], items[1]["tempo"]), (128.0, None))

    def test_create_appends_by_default(self):
        result = self.h.ok("scene_create")
        self.assertEqual(result["scene"]["index"], 2)
        self.assertEqual(len(self.h.song.scenes), 3)
        self.assertIn("call:create_scene:-1", self.h.song.log)
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_create_at_index_with_fields(self):
        result = self.h.ok("scene_create", {"index": 0, "name": "Intro", "color": 99, "tempo": 100})
        scene = result["scene"]
        self.assertEqual((scene["index"], scene["name"], scene["color"], scene["tempo"]),
                         (0, "Intro", 99, 100))
        self.assertTrue(self.h.song.scenes[0].tempo_enabled)

    def test_create_invalid(self):
        for args in ({"index": -2}, {"name": "x" * 129}, {"tempo": 19}, {"tempo": 1000},
                     {"color": -1}, {"nope": 1}):
            self.assertEqual(self.h.error("scene_create", args)["code"], "invalid_args", args)
        self.h.reset_log()
        self.assertEqual(self.h.error("scene_create", {"index": 3})["code"], "out_of_range")
        self.assertNoSideEffects()

    def test_edition_limit(self):
        h = LomHarness(edition="lite", scenes=16)
        for name in ("scene_create", "scene_capture"):
            error = h.error(name)
            self.assertEqual(error["code"], "edition_limit")
            self.assertEqual(error["details"], {"resource": "scenes", "limit": 16, "current": 16,
                                                "edition": "lite"})
        self.assertEqual(h.error("scene_duplicate", {"scene": 0})["code"], "edition_limit")
        self.assertEqual((h.song.events, h.song.log), ([], []))
        h = LomHarness(edition="lite", scenes=15)
        h.ok("scene_create")

    def test_capture(self):
        result = self.h.ok("scene_capture")
        self.assertEqual(result["scene"]["index"], 2)
        self.assertIn("call:capture_and_insert_scene", self.h.song.log)
        self.assertEqual(self.h.song.events, ["begin", "end"])


class SceneDeleteDuplicateSetTests(SceneCase):
    def test_delete_with_guard(self):
        self.h.reset_log()
        error = self.h.error("scene_delete", {"scene": 1, "expect_name": "Other"})
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_found", "name_mismatch"))
        self.assertEqual(self.h.error("scene_delete", {"scene": 5})["code"], "not_found")
        self.assertNoSideEffects()
        result = self.h.ok("scene_delete", {"scene": 1, "expect_name": "Scene 2"})
        self.assertEqual(result["deleted"], {"index": 1, "name": "Scene 2"})
        self.assertEqual(len(self.h.song.scenes), 1)
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_scene_index_must_be_a_non_negative_integer(self):
        for value in (-1, 1.5, "0", True, None, {"name": "x"}):
            self.assertEqual(self.h.error("scene_delete", {"scene": value})["code"], "invalid_args", value)

    def test_duplicate(self):
        result = self.h.ok("scene_duplicate", {"scene": 0})
        self.assertEqual(result["scene"]["index"], 1)
        self.assertEqual(result["scene"]["name"], "Scene 1")
        self.assertEqual(len(self.h.song.scenes), 3)
        self.assertEqual(self.h.error("scene_duplicate", {"scene": 9})["code"], "not_found")

    def test_set_fields(self):
        result = self.h.ok("scene_set", {"scene": 0, "name": "Verse", "color": 7, "tempo": 90.5,
                                        "time_signature": [7, 8]})["scene"]
        self.assertEqual((result["name"], result["color"], result["tempo"], result["time_signature"]),
                         ("Verse", 7, 90.5, [7, 8]))
        scene = self.h.song.scenes[0]
        self.assertTrue(scene.tempo_enabled and scene.time_signature_enabled)
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_set_null_disables_tempo_and_signature(self):
        self.h.ok("scene_set", {"scene": 0, "tempo": 90, "time_signature": [3, 4]})
        result = self.h.ok("scene_set", {"scene": 0, "tempo": None, "time_signature": None})["scene"]
        self.assertEqual((result["tempo"], result["time_signature"]), (None, None))
        scene = self.h.song.scenes[0]
        self.assertFalse(scene.tempo_enabled or scene.time_signature_enabled)

    def test_set_invalid(self):
        bad = [{"scene": 0}, {"scene": 0, "tempo": 19}, {"scene": 0, "tempo": "9"},
               {"scene": 0, "time_signature": [0, 4]}, {"scene": 0, "time_signature": [4, 3]},
               {"scene": 0, "time_signature": [100, 4]}, {"scene": 0, "time_signature": [4]},
               {"scene": 0, "time_signature": [4, 4, 4]}, {"scene": 0, "time_signature": "4/4"},
               {"scene": 0, "name": "a\x1b"}, {"name": "x"}]
        for args in bad:
            self.assertEqual(self.h.error("scene_set", args)["code"], "invalid_args", args)
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.h.error("scene_set", {"scene": 8, "name": "x"})["code"], "not_found")

    def test_signature_disable_unsupported_without_the_property(self):
        scene = self.h.song.scenes[0]
        del scene.time_signature_enabled
        error = self.h.error("scene_set", {"scene": 0, "time_signature": None})
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "live_version"))
        self.assertEqual(self.h.song.events, [])


class SceneFireTests(SceneCase):
    def make_external_live_by_monitoring(self):
        self.h.song.tracks[1].current_monitoring_state = 0  # the owner monitors the mic by hand
        self.h.reset_log()

    def test_fire_variants(self):
        self.assertEqual(self.h.ok("scene_fire", {"scene": 1}), {})
        self.h.ok("scene_fire", {"scene": 0, "force_legato": True, "can_select_scene_on_launch": False})
        self.h.ok("scene_fire", {"scene": 0, "as_selected": True, "force_legato": True})
        fired = [e for e in self.h.song.log if e.startswith("call:scene.")]
        self.assertEqual(fired, ["call:scene.fire:False:True", "call:scene.fire:True:False",
                                 "call:scene.fire_as_selected:True"])
        self.assertEqual(self.h.undo_steps(), 3)

    def test_invalid_and_not_found(self):
        for args in ({}, {"scene": 0, "force_legato": 1}, {"scene": 0, "x": 1}):
            self.assertEqual(self.h.error("scene_fire", args)["code"], "invalid_args")
        self.assertEqual(self.h.error("scene_fire", {"scene": 7})["code"], "not_found")
        self.assertEqual(self.h.song.events, [])

    def test_armed_midi_track_may_record_without_external_input(self):
        self.h.song.tracks[0]._arm = True
        self.h.ok("scene_fire", {"scene": 0})

    def test_empty_slot_on_armed_track_refused_while_external_live(self):
        self.make_external_live_by_monitoring()
        self.h.song.tracks[0]._arm = True
        error = self.h.error("scene_fire", {"scene": 0})
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "external_input_live"))
        self.assertNoSideEffects()

    def test_armed_track_with_clip_does_not_record_so_fire_is_allowed(self):
        self.make_external_live_by_monitoring()
        self.h.song.tracks[0]._arm = True
        self.h.song.tracks[0].clip_slots[0].clip = FakeClip()
        self.h.ok("scene_fire", {"scene": 0})

    def test_unarmed_tracks_never_block_scene_fire(self):
        self.make_external_live_by_monitoring()
        self.h.ok("scene_fire", {"scene": 1})

    def test_fire_refused_while_record_flags_on_and_external_live(self):
        self.make_external_live_by_monitoring()
        self.h.song.session_record = True
        self.h.reset_log()
        error = self.h.error("scene_fire", {"scene": 0})
        self.assertEqual(error["details"]["reason"], "external_input_live")
        self.assertNoSideEffects()
        self.h.song.session_record = False
        self.h.song.record_mode = True
        self.assertEqual(self.h.error("scene_fire", {"scene": 0, "as_selected": True})["code"], "not_supported")

    def test_a_monitoring_in_that_needs_the_owner_refuses_the_batch_up_front(self):
        self.h.song.tracks[0]._arm = True
        response = self.h.run("batch", {"ops": [
            {"cmd": "scene_fire", "args": {"scene": 0}},
            {"cmd": "track_set", "args": {"track": {"kind": "track", "index": 1},
                                          "monitoring_state": 0}}]})
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["details"]["reason"], "monitor_in_blocked")
        self.assertFalse([e for e in self.h.song.log if e.startswith("call:scene.")])


class CueCase(unittest.TestCase):
    def setUp(self):
        self.h = LomHarness()
        self.song = self.h.song
        self.song.add_cue(4.0, "A")
        self.song.add_cue(16.0, "B")
        self.song._time = 2.5
        self.h.reset_log()

    def assertNoSideEffects(self):
        self.assertEqual(self.song.events, [])
        self.assertEqual(self.song.log, [])


class CueListCreateTests(CueCase):
    def test_list_sorted_with_paging_and_no_mutation(self):
        self.song.add_cue(1.0, "Z")
        self.h.reset_log()
        result = self.h.ok("cue_list")
        self.assertEqual(result["items"], [{"index": 0, "name": "Z", "time": 1.0},
                                           {"index": 1, "name": "A", "time": 4.0},
                                           {"index": 2, "name": "B", "time": 16.0}])
        self.assertEqual(self.h.ok("cue_list", {"limit": 2, "offset": 2})["items"][0]["name"], "B")
        self.assertNoSideEffects()

    def test_create_restores_the_playhead(self):
        result = self.h.ok("cue_create", {"time": 8, "name": "Drop"})
        self.assertEqual(result["cue"], {"index": 1, "name": "Drop", "time": 8.0})
        self.assertEqual(self.song.current_song_time, 2.5)
        self.assertEqual(self.song.log.count("call:set_or_delete_cue"), 1)
        self.assertEqual(self.song.events, ["begin", "end"])

    def test_create_without_name(self):
        self.assertEqual(self.h.ok("cue_create", {"time": 0})["cue"]["name"], "")

    def test_create_refused_while_playing(self):
        self.song.is_playing = True
        self.h.reset_log()
        error = self.h.error("cue_create", {"time": 8})
        self.assertEqual((error["code"], error["details"]["reason"]), ("invalid_args", "transport_running"))
        self.assertNoSideEffects()

    def test_create_refuses_a_time_that_would_toggle_a_cue_off(self):
        for time in (4.0, 4.0 + 5e-7, 4.0 - 9e-7):
            self.h.reset_log()
            error = self.h.error("cue_create", {"time": time})
            self.assertEqual(error["code"], "invalid_args", time)
            self.assertNoSideEffects()
        # Within Live's toggle window (1e-3) the precheck refuses too (see test_cmds_review_t3).
        error = self.h.error("cue_create", {"time": 4.0 + 2e-6})
        self.assertEqual(error["details"]["reason"], "cue_nearby")
        self.assertNoSideEffects()
        self.h.ok("cue_create", {"time": 4.0 + 5e-3})

    def test_create_invalid_args(self):
        for args in ({}, {"time": -1}, {"time": "1"}, {"time": 1, "name": "x" * 129},
                     {"time": 1, "name": "a\x00"}, {"time": 1, "x": 1}):
            self.assertEqual(self.h.error("cue_create", args)["code"], "invalid_args", args)
        self.assertNoSideEffects()

    def test_playhead_restored_even_when_live_raises(self):
        def boom():
            raise RuntimeError("no")
        self.song.set_or_delete_cue = boom
        error = self.h.error("cue_create", {"time": 8})
        self.assertEqual(error["code"], "lom_error")
        self.assertEqual(self.song.current_song_time, 2.5)

    def test_create_fails_cleanly_if_live_did_not_add_the_cue(self):
        self.song.set_or_delete_cue = lambda: None
        error = self.h.error("cue_create", {"time": 8})
        self.assertEqual(error["code"], "lom_error")
        self.assertEqual(self.song.current_song_time, 2.5)


class _CueWrapper:
    """A fresh wrapper per access, like Live's: equal while alive, equal to nothing once deleted."""

    def __init__(self, cue):
        self._cue = cue

    def __eq__(self, other):
        return isinstance(other, _CueWrapper) and not self._cue._dead and self._cue is other._cue

    __hash__ = None

    def __getattr__(self, name):
        return getattr(self._cue, name)


def live_cue_wrappers(song):
    wrapped = property(lambda s: [_CueWrapper(cue) for cue in sorted(s._cues, key=lambda c: c.time)])
    return mock.patch.object(type(song), "cue_points", wrapped)


class CueTickCase(CueCase):
    """Real Live applies a playhead write on its next tick; the owner's Lite run showed the damage
    (F-T9-10): the toggle ran at the old playhead, the second create toggled that cue off."""

    def setUp(self):
        super().setUp()
        self.song.lag = True
        self.song._time = 68.0  # transport stopped, playhead parked at 68
        self.h.reset_log()

    def times(self):
        return [cue.time for cue in self.song.cue_points]


class CueTickCreateTests(CueTickCase):
    def test_create_lands_at_the_requested_time_not_at_the_playhead(self):
        result = self.h.ok("cue_create", {"time": 8, "name": "Drop"})
        self.assertEqual(result["cue"], {"index": 1, "name": "Drop", "time": 8.0})
        self.assertEqual(self.times(), [4.0, 8.0, 16.0])
        self.assertEqual(self.song.current_song_time, 68.0)
        self.assertEqual(self.song.events, ["begin", "end"])

    def test_two_creates_in_a_row_both_survive(self):
        self.h.ok("cue_create", {"time": 8})
        self.h.ok("cue_create", {"time": 20})
        self.assertEqual(self.times(), [4.0, 8.0, 16.0, 20.0])
        self.assertEqual(self.song.current_song_time, 68.0)

    def test_toggle_runs_on_a_later_tick_than_the_seek(self):
        self.h.ok("cue_create", {"time": 8})
        sequence = [e for e in self.song.log if e.startswith("call:set_or_delete_cue")]
        self.assertEqual(sequence, ["call:set_or_delete_cue"])
        self.assertEqual(self.times(), [4.0, 8.0, 16.0])  # not at 68

    def test_playhead_that_does_not_move_fails_without_toggling(self):
        self.song.seek_blocked = True
        error = self.h.error("cue_create", {"time": 8})
        self.assertEqual((error["code"], error["details"]["exception"]), ("lom_error", "PlayheadNotReached"))
        self.assertFalse(error["details"]["partial"])
        self.assertNotIn("call:set_or_delete_cue", self.song.log)
        self.assertEqual(self.times(), [4.0, 16.0])
        self.assertEqual(self.song.current_song_time, 68.0)
        self.assertEqual(self.song.events, [])

    def test_a_cue_created_at_the_wrong_time_is_toggled_back_off(self):
        real = self.song.set_or_delete_cue
        calls = []

        def misplaced():
            calls.append(1)
            if len(calls) == 1:
                self.song.add_cue(99.0)  # Live put the cue somewhere else
            else:
                real()
        self.song.set_or_delete_cue = misplaced
        error = self.h.error("cue_create", {"time": 8})
        self.assertEqual((error["code"], error["details"]["exception"]), ("lom_error", "WrongCueTime"))
        self.assertFalse(error["details"]["partial"])
        self.assertEqual(self.times(), [4.0, 16.0])
        self.assertEqual(self.song.current_song_time, 68.0)
        self.assertEqual(self.song.events, ["begin", "end"])

    def test_a_nearby_cue_toggled_off_is_reported_without_reading_the_dead_cue(self):
        def steals():
            cue = self.song._cues[0]
            self.song._cues.remove(cue)
            cue._dead = True
        self.song.set_or_delete_cue = steals
        error = self.h.error("cue_create", {"time": 8})
        self.assertEqual((error["code"], error["details"]["exception"]), ("lom_error", "CueToggledOff"))
        self.assertEqual(error["details"]["deleted_cue"], {"name": "A", "time": 4.0})
        self.assertEqual(self.song.current_song_time, 68.0)

    def test_playhead_is_restored_when_the_client_goes_away_mid_command(self):
        command, args = self.h.registry.prepare_call("cue_create", {"time": 8})
        running = self.h.dispatcher.start(Job(1, 1, command, args, self.h.clock() + 5, {}))
        self.assertIsInstance(running, RunningJob)
        self.assertIsNone(self.h.dispatcher.resume(running, None))  # tick 1: seek written
        self.song.tick()
        running.close()
        self.song.tick()
        self.assertEqual(self.song.current_song_time, 68.0)
        self.assertEqual(self.times(), [4.0, 16.0])

    def test_refused_inside_batch_because_it_needs_ticks(self):
        result = self.h.ok("batch", {"ops": [{"cmd": "cue_create", "args": {"time": 8}}]})
        self.assertEqual(result["results"][0]["error"]["details"]["reason"], "needs_ticks")
        self.assertEqual(self.times(), [4.0, 16.0])

    def test_checks_before_change_still_hold(self):
        self.song.is_playing = True
        self.assertEqual(self.h.error("cue_create", {"time": 8})["details"]["reason"], "transport_running")
        self.song.is_playing = False
        self.assertEqual(self.h.error("cue_create", {"time": 4.0})["details"]["reason"], "cue_exists")
        self.assertEqual(self.h.error("cue_create", {"time": 4.0005})["details"]["reason"], "cue_nearby")
        self.assertFalse([e for e in self.song.log if e.startswith("call:")])
        self.assertEqual(self.song.events, [])


class CueTickDeleteTests(CueTickCase):
    def test_delete_removes_the_requested_cue_and_restores_the_playhead(self):
        result = self.h.ok("cue_delete", {"index": 0, "expect_time": 4.0})
        self.assertEqual(result["deleted"], {"index": 0, "name": "A", "time": 4.0})
        self.assertEqual(self.times(), [16.0])
        self.assertEqual(self.song.current_song_time, 68.0)
        self.assertEqual(self.song.events, ["begin", "end"])

    def test_delete_succeeds_when_the_deleted_cue_equals_nothing(self):
        # Owner's Lite run (T9h re-check): Live hands out a new wrapper per access, and the wrapper
        # of a deleted cue equals nothing, not even another wrapper of the same cue.
        with live_cue_wrappers(self.song):
            result = self.h.ok("cue_delete", {"index": 0, "expect_time": 4.0})
        self.assertEqual(result["deleted"], {"index": 0, "name": "A", "time": 4.0})
        self.assertEqual(self.times(), [16.0])
        self.assertEqual(self.song.current_song_time, 68.0)

    def test_wrong_cue_removed_is_reported_with_live_wrappers(self):
        def wrong():
            cue = self.song._cues[0]
            self.song._cues.remove(cue)
            cue._dead = True
        self.song.set_or_delete_cue = wrong
        with live_cue_wrappers(self.song):
            error = self.h.error("cue_delete", {"index": 1})
        self.assertEqual(error["details"]["exception"], "WrongCueRemoved")
        self.assertEqual(error["details"]["deleted_cue"], {"name": "A", "time": 4.0})

    def test_playhead_that_does_not_move_fails_without_toggling(self):
        self.song.seek_blocked = True
        error = self.h.error("cue_delete", {"index": 1})
        self.assertEqual(error["details"]["exception"], "PlayheadNotReached")
        self.assertEqual(self.times(), [4.0, 16.0])
        self.assertNotIn("call:set_or_delete_cue", self.song.log)

    def test_wrong_cue_removed_is_reported_from_a_snapshot(self):
        def wrong():
            cue = self.song._cues[0]
            self.song._cues.remove(cue)
            cue._dead = True
        self.song.set_or_delete_cue = wrong
        error = self.h.error("cue_delete", {"index": 1})
        self.assertEqual((error["code"], error["details"]["exception"]), ("lom_error", "WrongCueRemoved"))
        self.assertEqual(error["details"]["deleted_cue"], {"name": "A", "time": 4.0})
        self.assertEqual(self.song.current_song_time, 68.0)

    def test_refused_inside_batch_because_it_needs_ticks(self):
        result = self.h.ok("batch", {"ops": [{"cmd": "cue_delete", "args": {"index": 0}}]})
        self.assertEqual(result["results"][0]["error"]["details"]["reason"], "needs_ticks")
        self.assertEqual(self.times(), [4.0, 16.0])


class CueDeleteSetJumpTests(CueCase):
    def test_delete_restores_playhead_and_reports(self):
        result = self.h.ok("cue_delete", {"index": 0, "expect_time": 4.0})
        self.assertEqual(result["deleted"], {"index": 0, "name": "A", "time": 4.0})
        self.assertEqual([c.name for c in self.song.cue_points], ["B"])
        self.assertEqual(self.song.current_song_time, 2.5)
        self.assertEqual(self.song.events, ["begin", "end"])

    def test_delete_guard_tolerance(self):
        self.h.ok("cue_delete", {"index": 1, "expect_time": 16.0 + 9e-7})
        self.h.reset_log()
        error = self.h.error("cue_delete", {"index": 0, "expect_time": 4.5})
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_found", "time_mismatch"))
        self.assertNoSideEffects()

    def test_delete_refused_while_playing_and_when_missing(self):
        self.song.is_playing = True
        self.h.reset_log()
        self.assertEqual(self.h.error("cue_delete", {"index": 0})["details"]["reason"], "transport_running")
        self.assertNoSideEffects()
        self.song.is_playing = False
        self.assertEqual(self.h.error("cue_delete", {"index": 4})["code"], "not_found")
        self.assertEqual(self.h.error("cue_delete", {"index": -1})["code"], "invalid_args")

    def test_delete_is_destructive_always(self):
        entry = {e["name"]: e for e in self.h.ok("catalog")["commands"]}["cue_delete"]
        self.assertEqual(entry["destructive"], "always")

    def test_set_renames(self):
        result = self.h.ok("cue_set", {"index": 1, "name": "Outro"})
        self.assertEqual(result["cue"], {"index": 1, "name": "Outro", "time": 16.0})
        self.assertEqual(self.song.events, ["begin", "end"])
        for args in ({"index": 1}, {"name": "x"}, {"index": 1, "name": "y" * 129}):
            self.assertEqual(self.h.error("cue_set", args)["code"], "invalid_args")
        self.assertEqual(self.h.error("cue_set", {"index": 9, "name": "x"})["code"], "not_found")

    def test_jump_by_index_and_direction(self):
        self.assertEqual(self.h.ok("cue_jump", {"index": 1}), {"current_song_time": 16.0})
        self.assertEqual(self.h.ok("cue_jump", {"direction": "prev"}), {"current_song_time": 4.0})
        self.assertEqual(self.h.ok("cue_jump", {"direction": "next"}), {"current_song_time": 16.0})
        self.assertEqual(self.h.undo_steps(), 3)

    def test_jump_needs_exactly_one_selector(self):
        for args in ({}, {"index": 0, "direction": "next"}, {"direction": "up"}, {"index": -1}):
            self.assertEqual(self.h.error("cue_jump", args)["code"], "invalid_args", args)
        self.assertEqual(self.h.error("cue_jump", {"index": 7})["code"], "not_found")
        self.assertNoSideEffects()


if __name__ == "__main__":
    unittest.main()
