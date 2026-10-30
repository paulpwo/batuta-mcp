"""T3 tests: session, transport and meta commands (spec 7.1) incl. recording safety."""

import unittest

from . import fakes
from .fake_lom import LomHarness

T0 = {"kind": "track", "index": 0}
T1 = {"kind": "track", "index": 1}


def make_external_live(h):
    """The owner armed an audio track with a microphone input by hand (the script never would)."""
    audio = h.song.tracks[1]
    audio._arm = True
    h.reset_log()
    return audio


class SessionCase(unittest.TestCase):
    def setUp(self):
        fakes.install_fake_live("12.4.7")
        self.addCleanup(fakes.uninstall_fake_live)
        self.h = LomHarness()

    def assertRefusedExternal(self, error):
        self.assertEqual(error["code"], "not_supported")
        self.assertEqual(error["details"]["reason"], "external_input_live")

    def assertNoSideEffects(self):
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.h.song.log, [])


class SongInfoTests(SessionCase):
    def test_shape_and_values(self):
        self.h.song.add_cue(8.0, "A")
        self.h.reset_log()
        result = self.h.ok("song_info")
        self.assertEqual(result["tempo"], 120.0)
        self.assertEqual(result["signature"], [4, 4])
        self.assertEqual(result["loop"], {"on": False, "start": 0.0, "length": 4.0})
        self.assertEqual(result["track_count"], 2)
        self.assertEqual(result["return_count"], 1)
        self.assertEqual(result["scene_count"], 2)
        self.assertEqual(result["cue_count"], 1)
        self.assertEqual(result["selected_track"], {"kind": "track", "index": 0})
        self.assertEqual(result["live_version"], "12.4.7")
        for key in ("is_playing", "current_song_time", "metronome", "record_mode",
                    "arrangement_overdub", "session_record", "root_note", "scale_name",
                    "can_undo", "can_redo"):
            self.assertIn(key, result)

    def test_selected_return_master_and_none(self):
        self.h.song.view.selected_track = self.h.song.return_tracks[0]
        self.assertEqual(self.h.ok("song_info")["selected_track"], {"kind": "return", "index": 0})
        self.h.song.view.selected_track = self.h.song.master_track
        self.assertEqual(self.h.ok("song_info")["selected_track"], {"kind": "master"})
        self.h.song.view.selected_track = None
        self.assertIsNone(self.h.ok("song_info")["selected_track"])

    def test_read_never_mutates(self):
        self.h.reset_log()
        self.h.ok("song_info")
        self.assertNoSideEffects()

    def test_rejects_unknown_args(self):
        self.assertEqual(self.h.error("song_info", {"x": 1})["code"], "invalid_args")


class SongSetTests(SessionCase):
    def test_applies_fields_in_one_undo_step(self):
        result = self.h.ok("song_set", {"tempo": 98.5, "signature_numerator": 6,
                                        "signature_denominator": 8, "metronome": True,
                                        "loop": True, "loop_start": 4, "loop_length": 8,
                                        "root_note": 2, "scale_name": "Minor"})
        song = self.h.song
        self.assertEqual((song.tempo, song.signature_numerator, song.signature_denominator),
                         (98.5, 6, 8))
        self.assertEqual((song.metronome, song.loop, song.loop_start, song.loop_length),
                         (True, True, 4, 8))
        self.assertEqual((song.root_note, song.scale_name), (2, "Minor"))
        self.assertEqual(sorted(result["applied"]),
                         sorted(["tempo", "signature_numerator", "signature_denominator",
                                 "metronome", "loop", "loop_start", "loop_length",
                                 "root_note", "scale_name"]))
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_invalid_args_leave_no_trace(self):
        bad = [{}, {"tempo": 19.9}, {"tempo": 1000}, {"tempo": True}, {"tempo": "120"},
               {"signature_numerator": 0}, {"signature_numerator": 100},
               {"signature_denominator": 3}, {"loop_start": -1}, {"loop_length": 0},
               {"root_note": 12}, {"root_note": -1}, {"scale_name": "x" * 65},
               {"scale_name": "a\x00b"}, {"nope": 1}, {"loop": 1}]
        for args in bad:
            self.h.reset_log()
            self.assertEqual(self.h.error("song_set", args)["code"], "invalid_args", args)
            self.assertNoSideEffects()

    def test_unknown_scale_maps_to_invalid_args(self):
        error = self.h.error("song_set", {"scale_name": "Nonsense"})
        self.assertEqual(error["code"], "invalid_args")
        self.assertEqual(self.h.song.events, ["begin", "end"])  # nothing was written before it

    def test_partial_failure_is_flagged(self):
        error = self.h.error("song_set", {"tempo": 90, "scale_name": "Nonsense"})
        self.assertEqual(error["code"], "invalid_args")
        self.assertTrue(error["details"]["partial"])

    def test_record_flags_refused_with_external_live_track(self):
        make_external_live(self.h)
        for field in ("record_mode", "session_record", "arrangement_overdub"):
            error = self.h.error("song_set", {field: True})
            self.assertRefusedExternal(error)
            self.assertEqual(error["details"]["tracks"], ["2-AUDIO"])
            self.assertNoSideEffects()

    def test_record_flag_refusal_is_per_field_even_with_other_fields(self):
        make_external_live(self.h)
        self.assertRefusedExternal(self.h.error("song_set", {"tempo": 100, "record_mode": True}))
        self.assertEqual(self.h.song.tempo, 120.0)
        self.assertNoSideEffects()

    def test_record_flags_allowed_without_external_input_and_when_disabling(self):
        self.h.ok("song_set", {"record_mode": True, "session_record": True,
                               "arrangement_overdub": True})
        self.assertTrue(self.h.song.record_mode)
        make_external_live(self.h)
        self.h.ok("song_set", {"record_mode": False, "session_record": False,
                               "arrangement_overdub": False, "tempo": 110})
        self.assertFalse(self.h.song.record_mode)

    def test_other_fields_allowed_with_external_live_track(self):
        make_external_live(self.h)
        self.h.ok("song_set", {"tempo": 101, "metronome": True})
        self.assertEqual(self.h.song.tempo, 101)


class TransportTests(SessionCase):
    def test_start_continue_stop(self):
        result = self.h.ok("transport", {"action": "start"})
        self.assertEqual(result, {"is_playing": True, "current_song_time": 0.0})
        self.h.ok("transport", {"action": "continue"})
        result = self.h.ok("transport", {"action": "stop"})
        self.assertFalse(result["is_playing"])
        self.assertIn("call:start_playing", self.h.song.log)
        self.assertIn("call:continue_playing", self.h.song.log)
        self.assertIn("call:stop_playing", self.h.song.log)
        self.assertEqual(self.h.undo_steps(), 3)

    def test_invalid_actions(self):
        for args in ({}, {"action": "pause"}, {"action": 1}, {"action": "start", "x": 1}):
            self.assertEqual(self.h.error("transport", args)["code"], "invalid_args")
        self.assertEqual(self.h.song.events, [])

    def test_start_refused_while_record_flags_on_with_external_live(self):
        make_external_live(self.h)
        for flag in ("record_mode", "session_record"):
            setattr(self.h.song, flag, True)  # the owner switched it on by hand
            self.h.reset_log()
            for action in ("start", "continue"):
                self.assertRefusedExternal(self.h.error("transport", {"action": action}))
                self.assertNoSideEffects()
            self.h.ok("transport", {"action": "stop"})  # stopping is always allowed
            setattr(self.h.song, flag, False)

    def test_plain_playback_allowed_with_external_live_and_flags_off(self):
        make_external_live(self.h)
        self.assertTrue(self.h.ok("transport", {"action": "start"})["is_playing"])

    def test_start_allowed_with_record_flags_on_without_external_live(self):
        self.h.song.session_record = True
        self.assertTrue(self.h.ok("transport", {"action": "start"})["is_playing"])


class TransportTickTests(SessionCase):
    """Live updates `is_playing` on its next tick (F-T9-9): the reply must show the state after it."""

    def setUp(self):
        super().setUp()
        self.h.song.lag = True

    def test_start_replies_with_the_new_state(self):
        self.assertTrue(self.h.ok("transport", {"action": "start"})["is_playing"])

    def test_stop_replies_with_the_new_state(self):
        self.h.ok("transport", {"action": "start"})
        self.assertFalse(self.h.ok("transport", {"action": "stop"})["is_playing"])

    def test_continue_replies_with_the_new_state(self):
        self.assertTrue(self.h.ok("transport", {"action": "continue"})["is_playing"])

    def test_one_undo_step_per_command_and_the_reply_shape_is_unchanged(self):
        result = self.h.ok("transport", {"action": "start"})
        self.assertEqual(sorted(result), ["current_song_time", "is_playing"])
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_refusals_open_no_undo_step(self):
        make_external_live(self.h)
        self.h.song.session_record = True
        self.assertRefusedExternal(self.h.error("transport", {"action": "start"}))
        self.assertEqual(self.h.song.events, [])

    def test_inside_batch_it_still_runs_in_the_batch_undo_step(self):
        self.h.ok("batch", {"ops": [{"cmd": "transport", "args": {"action": "start"}}]})
        self.assertEqual(self.h.song.events, ["begin", "end"])
        self.assertTrue(self.h.song.is_playing)


class SimpleSongCommandTests(SessionCase):
    def test_song_set_time(self):
        self.assertEqual(self.h.ok("song_set_time", {"time": 16.5}), {"current_song_time": 16.5})
        self.assertEqual(self.h.song.current_song_time, 16.5)
        self.assertEqual(self.h.undo_steps(), 1)
        for args in ({}, {"time": -0.1}, {"time": "1"}, {"time": True}):
            self.assertEqual(self.h.error("song_set_time", args)["code"], "invalid_args")
        self.assertEqual(self.h.undo_steps(), 1)

    def test_stop_all_clips_quantized_default_and_explicit(self):
        self.assertEqual(self.h.ok("stop_all_clips"), {})
        self.h.ok("stop_all_clips", {"quantized": False})
        self.assertEqual([e for e in self.h.song.log if e.startswith("call:stop_all")],
                         ["call:stop_all_clips:True", "call:stop_all_clips:False"])
        self.assertEqual(self.h.undo_steps(), 2)
        self.assertEqual(self.h.error("stop_all_clips", {"quantized": 1})["code"], "invalid_args")

    def test_back_to_arranger_capture_midi_re_enable_automation(self):
        self.h.song.back_to_arranger = 1
        self.assertEqual(self.h.ok("back_to_arranger"), {})
        self.assertFalse(self.h.song.back_to_arranger)
        self.assertEqual(self.h.ok("capture_midi"), {})
        self.assertEqual(self.h.ok("re_enable_automation"), {})
        self.assertIn("call:capture_midi", self.h.song.log)
        self.assertIn("call:re_enable_automation", self.h.song.log)
        self.assertEqual(self.h.undo_steps(), 3)
        for name in ("back_to_arranger", "capture_midi", "re_enable_automation"):
            self.assertEqual(self.h.error(name, {"x": 1})["code"], "invalid_args")


class TriggerSessionRecordTests(SessionCase):
    def test_without_and_with_length(self):
        self.assertEqual(self.h.ok("trigger_session_record"), {})
        self.h.ok("trigger_session_record", {"record_length": 8})
        calls = [e for e in self.h.song.log if e.startswith("call:trigger")]
        self.assertEqual(calls, ["call:trigger_session_record:None", "call:trigger_session_record:8"])
        self.assertEqual(self.h.undo_steps(), 2)

    def test_length_bounds(self):
        for value in (0.99, 256.1, -1, "4", True):
            self.assertEqual(self.h.error("trigger_session_record",
                                          {"record_length": value})["code"], "invalid_args", value)
        self.h.ok("trigger_session_record", {"record_length": 1})
        self.h.ok("trigger_session_record", {"record_length": 256})

    def test_refused_with_external_live_track(self):
        make_external_live(self.h)
        self.assertRefusedExternal(self.h.error("trigger_session_record"))
        self.assertNoSideEffects()


if __name__ == "__main__":
    unittest.main()
