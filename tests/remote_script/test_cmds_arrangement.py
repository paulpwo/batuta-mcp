"""T4a tests: arrangement clips (spec 7.11)."""

import unittest

from .clip_world import A, S, T0, T1, T2, R0, ClipCase, put_arrangement


def writes(h):
    return [entry for entry in h.song.log if entry.startswith("call:track.")]


class ArrangementListTests(ClipCase):
    def setUp(self):
        super().setUp()
        put_arrangement(self.h, 0, 0.0, 4.0, True, "a")
        put_arrangement(self.h, 0, 8.0, 4.0, True, "b")
        put_arrangement(self.h, 0, 16.0, 2.0, True, "c\x07")

    def test_lists_clips_in_live_order_with_stable_indexes(self):
        result = self.h.ok("arrangement_clips", {"track": T0})
        self.assertEqual([(i["index"], i["name"], i["start_time"], i["end_time"], i["length"]) for i in result["items"]],
                         [(0, "a", 0.0, 4.0, 4.0), (1, "b", 8.0, 12.0, 4.0), (2, "c", 16.0, 18.0, 2.0)])
        self.assertEqual((result["items"][0]["is_midi"], result["items"][0]["is_audio"]), (True, False))
        self.assertNoSideEffects()

    def test_range_filter_keeps_original_indexes(self):
        names = lambda args: [(i["index"], i["name"]) for i in self.h.ok("arrangement_clips", args)["items"]]
        self.assertEqual(names({"track": T0, "from": 6, "to": 14}), [(1, "b")])
        self.assertEqual(names({"track": T0, "from": 4}), [(1, "b"), (2, "c")])  # a ends exactly at 4
        self.assertEqual(names({"track": T0, "to": 8}), [(0, "a")])  # b starts exactly at 8
        self.assertEqual(names({"track": T0, "from": 3.5, "to": 8.5}), [(0, "a"), (1, "b")])

    def test_paging(self):
        page = self.h.ok("arrangement_clips", {"track": T0, "limit": 1, "offset": 1})
        self.assertEqual(([i["index"] for i in page["items"]], page["next_offset"], page["total"]), ([1], 2, 3))

    def test_audio_track_and_bad_arguments(self):
        put_arrangement(self.h, 1, 0.0, 4.0, False, "audio")
        self.assertTrue(self.h.ok("arrangement_clips", {"track": T1})["items"][0]["is_audio"])
        for args in ({"track": R0}, {"track": T0, "from": 5, "to": 5}, {"track": T0, "from": 9, "to": 2},
                     {"track": T0, "from": -1}, {"track": T0, "unknown": 1}):
            self.assertEqual(self.h.error("arrangement_clips", args)["code"], "invalid_args", args)
        self.assertEqual(self.h.error("arrangement_clips", {"track": {"kind": "track", "index": 9}})["code"], "not_found")


class ArrangementClipCreateTests(ClipCase):
    def test_creates_a_midi_clip(self):
        info = self.h.ok("arrangement_clip_create", {"track": T0, "start": 8, "length": 4, "name": "Verse"})["clip"]
        self.assertEqual((info["kind"], info["slot_or_index"], info["name"], info["start_time"], info["length"]),
                         ("arrangement", 0, "Verse", 8.0, 4.0))
        self.assertIn("call:track.create_midi_clip:8:4", self.h.song.log)
        self.assertOneUndoStep()

    def test_index_follows_live_order(self):
        put_arrangement(self.h, 0, 20.0, 4.0)
        info = self.h.ok("arrangement_clip_create", {"track": T0, "start": 0, "length": 4})["clip"]
        self.assertEqual(info["slot_or_index"], 0)

    def test_overlap_is_refused_but_touching_is_fine(self):
        put_arrangement(self.h, 0, 8.0, 4.0, True, "Existing")
        for start in (6.0, 8.0, 11.0):
            error = self.h.error("arrangement_clip_create", {"track": T0, "start": start, "length": 4})
            self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "overlap"), start)
            self.assertEqual(error["details"]["clips"][0]["name"], "Existing")
        self.assertNoSideEffects()
        self.h.ok("arrangement_clip_create", {"track": T0, "start": 4, "length": 4})
        self.h.ok("arrangement_clip_create", {"track": T0, "start": 12, "length": 4})

    def test_other_refusals(self):
        error = self.h.error("arrangement_clip_create", {"track": T1, "start": 0, "length": 4})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "not_midi_track"))
        for args in ({"track": T0, "start": 0, "length": 0.2}, {"track": T0, "start": 0, "length": 4097},
                     {"track": T0, "start": -1, "length": 4}, {"track": T0, "start": 0},
                     {"track": T0, "start": 0, "length": 4, "allow_overwrite": True}):
            self.assertEqual(self.h.error("arrangement_clip_create", args)["code"], "invalid_args", args)
        self.assertNoSideEffects()

    def test_same_refusal_inside_batch(self):
        put_arrangement(self.h, 0, 8.0, 4.0)
        error = self.batch_error("arrangement_clip_create", {"track": T0, "start": 8, "length": 4})
        self.assertEqual(self.reason(error), "overlap")
        self.assertFalse(writes(self.h))


class ArrangementDuplicateTests(ClipCase):
    def args(self, **extra):
        return dict({"source": S(T0, 0), "track": T0, "time": 16}, **extra)

    def test_duplicates_a_session_clip(self):
        info = self.h.ok("arrangement_duplicate", self.args())["clip"]
        self.assertEqual((info["kind"], info["track"], info["start_time"], info["end_time"], info["name"]),
                         ("arrangement", T0, 16.0, 20.0, "Midi A"))
        self.assertEqual(len(self.h.song.tracks[0].arrangement_clips[0].get_all_notes_extended()), 3)
        self.assertIn("call:track.duplicate_clip_to_arrangement:16", self.h.song.log)
        self.assertOneUndoStep()

    def test_duplicates_an_arrangement_clip_to_another_midi_track(self):
        put_arrangement(self.h, 0, 0.0, 4.0, True, "Src")
        info = self.h.ok("arrangement_duplicate", {"source": A(T0, 0, expect_start=0.0), "track": T2, "time": 4})["clip"]
        self.assertEqual((info["track"], info["start_time"], info["name"]), (T2, 4.0, "Src"))

    def test_audio_clip_to_audio_track(self):
        info = self.h.ok("arrangement_duplicate", {"source": S(T1, 0), "track": T1, "time": 0})["clip"]
        self.assertTrue(info["is_audio"])

    def test_overlap_needs_allow_overwrite(self):
        put_arrangement(self.h, 0, 18.0, 4.0, True, "Existing")
        error = self.h.error("arrangement_duplicate", self.args())
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "overlap"))
        self.assertNoSideEffects()
        info = self.h.ok("arrangement_duplicate", self.args(allow_overwrite=True))["clip"]
        self.assertEqual(info["start_time"], 16.0)
        self.assertEqual([c.name for c in self.h.song.tracks[0].arrangement_clips], ["Midi A"])

    def test_touching_clips_do_not_overlap(self):
        put_arrangement(self.h, 0, 20.0, 4.0)
        put_arrangement(self.h, 0, 12.0, 4.0)
        self.h.ok("arrangement_duplicate", self.args())

    def test_refusals(self):
        cases = [(self.args(track=T1), "invalid_args", "incompatible_track"),
                 ({"source": S(T1, 0), "track": T0, "time": 0}, "invalid_args", "incompatible_track"),
                 (self.args(source=S(T0, 1)), "not_found", "empty_slot"),
                 (self.args(source=A(T0, 0)), "not_found", None)]
        for args, code, reason in cases:
            error = self.h.error("arrangement_duplicate", args)
            self.assertEqual(error["code"], code, args)
            if reason:
                self.assertEqual(self.reason(error), reason)
        for args in (self.args(time=-1), self.args(track=R0), {"track": T0, "time": 0}):
            self.assertEqual(self.h.error("arrangement_duplicate", args)["code"], "invalid_args", args)
        self.assertNoSideEffects()

    def test_same_refusals_inside_batch(self):
        put_arrangement(self.h, 0, 16.0, 4.0)
        self.assertEqual(self.reason(self.batch_error("arrangement_duplicate", self.args())), "overlap")
        self.assertEqual(self.reason(self.batch_error("arrangement_duplicate", self.args(track=T1))), "incompatible_track")
        self.assertFalse(writes(self.h))


class CommitSceneTests(ClipCase):
    def args(self, **extra):
        return dict({"scene": 0, "time": 32}, **extra)

    def test_commits_every_clip_of_the_scene(self):
        result = self.h.ok("arrangement_commit_scene", self.args())
        self.assertEqual([(c["track"], c["start_time"], c["is_midi"]) for c in result["clips"]],
                         [(T0, 32.0, True), (T1, 32.0, False)])
        self.assertEqual(result["skipped"], [T2])
        self.assertEqual(self.h.song.log.count("call:track.duplicate_clip_to_arrangement:32"), 2)
        self.assertOneUndoStep()

    def test_explicit_track_list(self):
        result = self.h.ok("arrangement_commit_scene", self.args(tracks=[T0, T2]))
        self.assertEqual(([c["track"] for c in result["clips"]], result["skipped"]), ([T0], [T2]))
        self.assertEqual(self.h.song.tracks[1].arrangement_clips, [])

    def test_all_targets_are_validated_before_the_first_write(self):
        put_arrangement(self.h, 1, 33.0, 4.0, False, "Blocker")
        error = self.h.error("arrangement_commit_scene", self.args())
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "overlap"))
        self.assertEqual(error["details"]["conflicts"][0]["track"], T1)
        self.assertEqual(error["details"]["conflicts"][0]["clips"][0]["name"], "Blocker")
        self.assertNoSideEffects()
        self.assertEqual(self.h.song.tracks[0].arrangement_clips, [])

    def test_allow_overwrite_replaces(self):
        put_arrangement(self.h, 1, 33.0, 4.0, False, "Blocker")
        result = self.h.ok("arrangement_commit_scene", self.args(allow_overwrite=True))
        self.assertEqual(len(result["clips"]), 2)
        self.assertNotIn("Blocker", [c.name for c in self.h.song.tracks[1].arrangement_clips])

    def test_batch_path_validates_before_writing(self):
        put_arrangement(self.h, 1, 33.0, 4.0, False)
        error = self.batch_error("arrangement_commit_scene", self.args())
        self.assertEqual(self.reason(error), "overlap")
        self.assertFalse(writes(self.h))

    def test_refusals(self):
        self.assertEqual(self.reason(self.h.error("arrangement_commit_scene", self.args(scene=1))), "no_clips")
        self.assertEqual(self.reason(self.h.error("arrangement_commit_scene", self.args(tracks=[T2]))), "no_clips")
        self.assertEqual(self.h.error("arrangement_commit_scene", self.args(scene=9))["code"], "not_found")
        self.assertEqual(self.reason(self.h.error("arrangement_commit_scene", self.args(tracks=[T0, T0]))),
                         "duplicate_track")
        stale = dict(T0, expect_name="Other")
        error = self.h.error("arrangement_commit_scene", self.args(tracks=[stale]))
        self.assertEqual((error["code"], self.reason(error)), ("not_found", "name_mismatch"))
        for bad in (self.args(time=-1), self.args(tracks=[]), self.args(tracks=[R0]), {"time": 1}, {"scene": 0}):
            self.assertEqual(self.h.error("arrangement_commit_scene", bad)["code"], "invalid_args", bad)
        self.assertNoSideEffects()


if __name__ == "__main__":
    unittest.main()
