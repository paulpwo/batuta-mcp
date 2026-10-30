"""T9j: playhead writes land on Live's next tick (song_set_time, cue_jump, F-T9-9) and arrangement
copies put the playhead back where it was (F-T9-12). Fakes model the one-tick lag with `song.lag`."""

import unittest

from .clip_world import S, T0, ClipCase
from .fake_lom import LomHarness


class SongTimeTickTests(unittest.TestCase):
    def setUp(self):
        self.h = LomHarness()
        self.h.song.lag = True

    def test_song_set_time_replies_with_the_new_playhead(self):
        self.assertEqual(self.h.ok("song_set_time", {"time": 16.5}), {"current_song_time": 16.5})
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_inside_batch_it_runs_in_the_batch_undo_step(self):
        result = self.h.ok("batch", {"ops": [{"cmd": "song_set_time", "args": {"time": 8}}]})
        self.assertTrue(result["results"][0]["ok"])
        self.assertEqual(self.h.song.events, ["begin", "end"])
        self.assertEqual(self.h.song.current_song_time, 8)

    def test_cue_jump_replies_with_the_new_playhead(self):
        for time in (4.0, 16.0):
            self.h.ok("cue_create", {"time": time})
        self.h.song.tick()
        self.h.reset_log()
        self.assertEqual(self.h.ok("cue_jump", {"index": 1}), {"current_song_time": 16.0})
        self.assertEqual(self.h.ok("cue_jump", {"direction": "prev"}), {"current_song_time": 4.0})
        self.assertEqual(self.h.ok("cue_jump", {"direction": "next"}), {"current_song_time": 16.0})
        self.assertEqual(self.h.undo_steps(), 3)

    def test_cue_jump_refusals_open_no_undo_step(self):
        self.assertEqual(self.h.error("cue_jump", {"index": 7})["code"], "not_found")
        self.assertEqual(self.h.song.events, [])


class ArrangementPlayheadTests(ClipCase):
    def args(self, **extra):
        return dict({"source": S(T0, 0), "track": T0, "time": 16}, **extra)

    def test_duplicate_restores_the_playhead(self):
        for lag in (False, True):
            self.h.song.lag = lag
            self.h.song.current_song_time = 2.0
            self.h.song.tick()
            self.h.ok("arrangement_duplicate", self.args(allow_overwrite=True))
            self.assertEqual(self.h.song.current_song_time, 2.0, lag)

    def test_duplicate_keeps_one_undo_step(self):
        self.h.song.lag = True
        self.h.ok("arrangement_duplicate", self.args())
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_commit_scene_restores_the_playhead(self):
        self.h.song.lag = True
        self.h.song.current_song_time = 3.0
        self.h.song.tick()
        self.h.ok("arrangement_commit_scene", {"scene": 0, "time": 32})
        self.assertEqual(self.h.song.current_song_time, 3.0)

    def test_inside_batch_it_restores_without_waiting(self):
        self.h.song.current_song_time = 2.0
        result = self.h.ok("batch", {"ops": [{"cmd": "arrangement_duplicate", "args": self.args()}]})
        self.assertTrue(result["results"][0]["ok"])
        self.assertEqual(self.h.song.current_song_time, 2.0)
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_a_failed_copy_still_restores_the_playhead(self):
        self.h.song.current_song_time = 2.0
        self.h.song.tracks[0].duplicate_clip_to_arrangement = self._boom
        self.assertFalse(self.h.run("arrangement_duplicate", self.args())["ok"])
        self.assertEqual(self.h.song.current_song_time, 2.0)

    def _boom(self, clip, time):
        self.h.song.current_song_time = time
        raise RuntimeError("boom")

    def test_while_playing_the_playhead_is_left_alone(self):
        self.h.song.is_playing = True
        self.h.song.current_song_time = 2.0
        self.h.ok("arrangement_duplicate", self.args())
        self.assertEqual(self.h.song.current_song_time, 16.0)

    def test_refusals_touch_nothing(self):
        self.assertFalse(self.h.run("arrangement_duplicate", self.args(track={"kind": "track", "index": 1}))["ok"])
        self.assertEqual((self.h.song.events, self.h.song.log), ([], []))
