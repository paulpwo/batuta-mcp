"""T4a tests: clips, slots and audio import (spec 7.6, except notes)."""

import unittest

from remote_script.BatutaMCP import clip_lom
from remote_script.BatutaMCP.errors import BatutaError

from .clip_world import (A, IMPORT, S, T0, T1, T2, R0, ClipCase, put_arrangement, put_clip, world)


class ReadTests(ClipCase):
    def test_clip_list_hides_empty_slots_by_default_and_keeps_slot_numbers(self):
        put_clip(self.h, 0, 2, True, "Third")
        result = self.h.ok("clip_list", {"track": T0})
        self.assertEqual([item["slot"] for item in result["items"]], [0, 2])
        self.assertEqual(result["total"], 2)
        item = result["items"][0]
        self.assertEqual(item["track"], T0)
        self.assertEqual(item["clip"]["name"], "Midi A")
        self.assertEqual((item["has_clip"], item["is_playing"], item["is_recording"], item["is_triggered"]),
                         (True, False, False, False))
        self.assertNoSideEffects()

    def test_clip_list_include_empty_and_paging(self):
        everything = self.h.ok("clip_list", {"track": T0, "include_empty": True})
        self.assertEqual([item["has_clip"] for item in everything["items"]], [True, False, False])
        page = self.h.ok("clip_list", {"track": T0, "include_empty": True, "limit": 2})
        self.assertEqual((len(page["items"]), page["next_offset"], page["total"]), (2, 2, 3))
        self.assertIsNone(page["items"][1]["clip"])
        self.assertNoSideEffects()

    def test_clip_list_rejects_return_and_master_tracks(self):
        for ref in (R0, {"kind": "master"}):
            self.assertEqual(self.h.error("clip_list", {"track": ref})["code"], "invalid_args")
        self.assertEqual(self.h.error("clip_list", {"track": {"kind": "track", "index": 9}})["code"], "not_found")

    def test_slot_status(self):
        result = self.h.ok("slot_status", {"track": T0, "slot": 0})
        self.assertEqual(result["slot"], 0)
        self.assertTrue(result["has_clip"])
        self.assertFalse(self.h.ok("slot_status", {"track": T0, "slot": 1})["has_clip"])
        error = self.h.error("slot_status", {"track": T0, "slot": 3})
        self.assertEqual((error["code"], error["details"]["what"]), ("not_found", "slot"))
        self.assertNoSideEffects()

    def test_clip_get_midi_session_clip(self):
        info = self.h.ok("clip_get", {"clip": S(T0, 0)})["clip"]
        self.assertEqual((info["kind"], info["track"], info["slot_or_index"]), ("session", T0, 0))
        self.assertEqual((info["name"], info["length"], info["is_midi"], info["is_audio"]),
                         ("Midi A", 4.0, True, False))
        self.assertEqual((info["loop_start"], info["loop_end"], info["start_marker"], info["end_marker"]),
                         (0.0, 4.0, 0.0, 4.0))
        self.assertEqual(info["signature"], [4, 4])
        for audio_only in ("file_path", "sample_rate", "gain", "pitch_coarse", "pitch_fine", "warping"):
            self.assertIsNone(info[audio_only], audio_only)
        self.assertNoSideEffects()

    def test_clip_get_audio_clip_reports_audio_fields(self):
        info = self.h.ok("clip_get", {"clip": S(T1, 0)})["clip"]
        self.assertEqual((info["file_path"], info["sample_rate"], info["gain"], info["warping"]),
                         ("/Samples/x.wav", 44100, 0.4, True))
        self.assertEqual((info["pitch_coarse"], info["pitch_fine"]), (0, 0.0))

    def test_clip_get_arrangement_clip_and_guards(self):
        put_arrangement(self.h, 0, 8.0, 4.0, True, "Arr1")
        info = self.h.ok("clip_get", {"clip": A(T0, 0, expect_start=8.0)})["clip"]
        self.assertEqual((info["kind"], info["slot_or_index"], info["start_time"], info["end_time"]),
                         ("arrangement", 0, 8.0, 12.0))
        error = self.h.error("clip_get", {"clip": A(T0, 0, expect_start=9.0)})
        self.assertEqual((error["code"], self.reason(error)), ("not_found", "start_mismatch"))
        self.assertEqual(self.h.error("clip_get", {"clip": A(T0, 1)})["code"], "not_found")
        self.assertEqual(self.reason(self.h.error("clip_get", {"clip": S(T0, 1)})), "empty_slot")
        self.assertEqual(self.h.error("clip_get", {"clip": S(T0, 7)})["code"], "not_found")

    def test_live_strings_are_cleaned_and_capped(self):
        clip = self.h.song.tracks[0].clip_slots[0].clip
        clip.name = "a\x07b" + "x" * 300
        name = self.h.ok("clip_get", {"clip": S(T0, 0)})["clip"]["name"]
        self.assertTrue(name.startswith("abx"))
        self.assertEqual(len(name), 128)
        clip = self.h.song.tracks[1].clip_slots[0].clip
        clip._file_path = "/Samples/" + "d" * 5000 + ".wav"
        self.assertEqual(len(self.h.ok("clip_get", {"clip": S(T1, 0)})["clip"]["file_path"]), 4096)

    def test_bad_clip_refs_are_invalid_args(self):
        for ref in ({"kind": "session", "track": T0}, {"kind": "arrangement", "track": T0, "slot": 0},
                    {"kind": "session", "track": T0, "slot": -1}, {"kind": "other"}, "x",
                    {"kind": "session", "track": T0, "slot": 0, "extra": 1}):
            self.assertEqual(self.h.error("clip_get", {"clip": ref})["code"], "invalid_args", ref)


class ClipCreateTests(ClipCase):
    def test_creates_a_midi_clip(self):
        result = self.h.ok("clip_create", {"track": T0, "slot": 1, "length": 2.5, "name": "New", "color": 7})
        info = result["clip"]
        self.assertEqual((info["kind"], info["slot_or_index"], info["name"], info["color"], info["length"]),
                         ("session", 1, "New", 7, 2.5))
        self.assertTrue(self.h.song.tracks[0].clip_slots[1].has_clip)
        self.assertIn("call:slot.create_clip:2.5", self.h.song.log)
        self.assertOneUndoStep()

    def test_refusals_leave_no_trace(self):
        cases = [({"track": T1, "slot": 1, "length": 4}, "not_midi_track"),
                 ({"track": T0, "slot": 0, "length": 4}, "slot_occupied")]
        for args, reason in cases:
            error = self.h.error("clip_create", args)
            self.assertEqual((error["code"], self.reason(error)), ("invalid_args", reason))
        self.assertEqual(self.h.error("clip_create", {"track": T0, "slot": 9, "length": 4})["code"], "not_found")
        self.assertNoSideEffects()

    def test_schema_ranges(self):
        for args in ({"track": T0, "slot": 1, "length": 0.2}, {"track": T0, "slot": 1, "length": 1025},
                     {"track": T0, "slot": 1}, {"track": R0, "slot": 1, "length": 4},
                     {"track": T0, "slot": 1, "length": 4, "name": "x" * 129},
                     {"track": T0, "slot": 1, "length": 4, "color": 0x1000000},
                     {"track": T0, "slot": 1, "length": True}):
            self.assertEqual(self.h.error("clip_create", args)["code"], "invalid_args", args)
        self.assertNoSideEffects()

    def test_refused_inside_batch_before_any_write(self):
        error = self.batch_error("clip_create", {"track": T0, "slot": 0, "length": 4})
        self.assertEqual(self.reason(error), "slot_occupied")
        self.assertFalse([entry for entry in self.h.song.log if entry.startswith("call:slot.")])


class AudioClipCreateTests(ClipCase):
    flags = IMPORT
    PATH = "/Samples/loop.wav"

    def session(self, **extra):
        return dict({"track": T1, "slot": 1, "file_path": self.PATH}, **extra)

    def arrangement(self, **extra):
        return dict({"track": T1, "position": 0.0, "expected_length_beats": 4.0, "file_path": self.PATH}, **extra)

    def test_disabled_unless_the_connection_enables_it(self):
        for flags in ({}, {"allow_audio_import": False}):
            self.h.flags = flags
            error = self.h.error("audio_clip_create", self.session())
            self.assertEqual((error["code"], self.reason(error)), ("not_supported", "disabled_by_config"))
            self.assertNotIn("sample_roots", error["message"])
            batch = self.batch_error("audio_clip_create", self.session())
            self.assertEqual(self.reason(batch), "disabled_by_config")
        self.assertFalse([entry for entry in self.h.song.log if entry.startswith("call:")])

    def test_session_form(self):
        self.h.song.sample_beats[self.PATH] = 8.0
        info = self.h.ok("audio_clip_create", self.session())["clip"]
        self.assertEqual((info["kind"], info["slot_or_index"], info["file_path"], info["length"]),
                         ("session", 1, self.PATH, 8.0))
        self.assertIn("call:slot.create_audio_clip:" + self.PATH, self.h.song.log)
        self.assertOneUndoStep()

    def test_session_form_refusals(self):
        for args, reason in ((dict(self.session(), track=T0), "not_audio_track"),
                             (self.session(slot=0), "slot_occupied")):
            error = self.h.error("audio_clip_create", args)
            self.assertEqual((error["code"], self.reason(error)), ("invalid_args", reason))
        self.assertEqual(self.h.error("audio_clip_create", self.session(slot=9))["code"], "not_found")
        self.assertNoSideEffects()

    def test_path_rules_are_lexical_and_strict(self):
        bad = {"relative": "Samples/a.wav", "traversal": "/Samples/../etc/a.wav", "nul": "/Samples/a\x00.wav",
               "extension": "/Samples/a.txt", "als": "/Samples/set.als", "amxd": "/Samples/x.amxd",
               "noext": "/Samples/wav", "long": "/" + "d" * 1030 + "/a.wav", "trailing": "/Samples/"}
        for label, path in bad.items():
            error = self.h.error("audio_clip_create", self.session(file_path=path))
            self.assertEqual(error["code"], "invalid_args", label)
        self.assertNoSideEffects()

    def test_path_edge_cases_that_are_allowed(self):
        for path in ("/a/b.WAV", "/a/b.Aiff", "/a/b..wav", "/a/..b/c.flac", "/a/.hidden/c.mp3"):
            self.h.reset_log()
            self.h.song.tracks[1].clip_slots[1]._clip = None
            self.h.ok("audio_clip_create", self.session(file_path=path))

    def test_arrangement_form(self):
        self.h.song.sample_beats[self.PATH] = 4.0
        info = self.h.ok("audio_clip_create", self.arrangement(position=16.0))["clip"]
        self.assertEqual((info["kind"], info["start_time"], info["end_time"], info["file_path"]),
                         ("arrangement", 16.0, 20.0, self.PATH))
        self.assertIn("call:track.create_audio_clip:%s:16.0" % self.PATH, self.h.song.log)
        self.assertOneUndoStep()

    def test_arrangement_overlap_needs_allow_overwrite(self):
        put_arrangement(self.h, 1, 8.0, 4.0, False, "Existing")
        for position in (6.0, 8.0, 10.0, 11.5):
            error = self.h.error("audio_clip_create", self.arrangement(position=position))
            self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "overlap"), position)
            self.assertEqual(error["details"]["clips"][0]["name"], "Existing")
        self.assertNoSideEffects()
        for position in (4.0, 12.0):  # touching only
            self.h.ok("audio_clip_create", self.arrangement(position=position))

    def test_arrangement_overwrite_replaces_when_allowed(self):
        put_arrangement(self.h, 1, 8.0, 4.0, False, "Existing")
        info = self.h.ok("audio_clip_create", self.arrangement(position=9.0, allow_overwrite=True))["clip"]
        self.assertEqual(info["start_time"], 9.0)
        self.assertEqual([c.name for c in self.h.song.tracks[1].arrangement_clips], [""])

    def test_arrangement_form_rules(self):
        cases = [(self.arrangement(file_path="/Samples/a.flac"), "length_unknown"),
                 (self.arrangement(file_path="/Samples/a.mp3", allow_overwrite=False), "length_unknown"),
                 (dict(self.session(), position=1.0), "form"),
                 ({"track": T1, "file_path": self.PATH}, "form"),
                 (self.session(expected_length_beats=4.0), "form"),
                 (self.session(allow_overwrite=True), "form"),
                 ({"track": T1, "position": 0.0, "file_path": self.PATH}, "form"),
                 (dict(self.arrangement(), track=T0), "not_audio_track")]
        for args, reason in cases:
            error = self.h.error("audio_clip_create", args)
            self.assertEqual((error["code"], self.reason(error)), ("invalid_args", reason), args)
        self.assertNoSideEffects()

    def test_unknown_length_formats_work_with_allow_overwrite(self):
        info = self.h.ok("audio_clip_create", {"track": T1, "position": 2.0, "file_path": "/Samples/a.flac",
                                               "allow_overwrite": True})["clip"]
        self.assertEqual(info["start_time"], 2.0)

    def test_same_rules_inside_batch(self):
        put_arrangement(self.h, 1, 8.0, 4.0, False)
        error = self.batch_error("audio_clip_create", self.arrangement(position=8.0), flags=IMPORT)
        self.assertEqual(self.reason(error), "overlap")
        self.assertEqual(self.h.error("batch", {"ops": [{"cmd": "audio_clip_create", "args":
                                                         self.session(file_path="relative.wav")}]})["code"],
                         "invalid_args")  # static rules fail the whole batch before it starts
        self.assertFalse([entry for entry in self.h.song.log if "create_audio_clip" in entry])

    def test_the_script_never_checks_that_the_file_exists(self):
        self.h.ok("audio_clip_create", self.session(file_path="/does/not/exist.wav"))


class PathRuleUnitTests(unittest.TestCase):
    """check_audio_path is the second line of defence behind the schema caps; test it directly."""

    def reason(self, path):
        with self.assertRaises(BatutaError) as caught:
            clip_lom.check_audio_path(path)
        return caught.exception.details["reason"]

    def test_each_rule_has_its_own_reason(self):
        self.assertEqual(self.reason("/a\x00.wav"), "path_nul")
        self.assertEqual(self.reason("/" + "d" * 1030 + "/a.wav"), "path_too_long")
        self.assertEqual(self.reason("/" + "\u00e9" * 600 + ".wav"), "path_too_long")  # bytes, not characters
        self.assertEqual(self.reason("rel/a.wav"), "path_not_absolute")
        self.assertEqual(self.reason("/a/../b.wav"), "path_traversal")
        self.assertEqual(self.reason("/a/b.txt"), "extension")

    def test_boundary_length_is_accepted(self):
        path = "/" + "d" * (1024 - len("/.wav")) + ".wav"
        self.assertEqual(len(path.encode("utf-8")), 1024)
        self.assertEqual(clip_lom.check_audio_path(path), path.rsplit("/", 1)[-1])
        self.assertEqual(self.reason(path + "x.wav"), "path_too_long")


class DeleteTests(ClipCase):
    def test_delete_session_clip(self):
        result = self.h.ok("clip_delete", {"clip": S(T0, 0), "expect_name": "Midi A"})
        self.assertEqual(result, {"deleted": {"name": "Midi A"}})
        self.assertFalse(self.h.song.tracks[0].clip_slots[0].has_clip)
        self.assertOneUndoStep()

    def test_delete_arrangement_clip(self):
        put_arrangement(self.h, 0, 8.0, 4.0, True, "Arr1")
        self.h.ok("clip_delete", {"clip": A(T0, 0, expect_start=8.0)})
        self.assertEqual(self.h.song.tracks[0].arrangement_clips, [])
        self.assertIn("call:track.delete_clip", self.h.song.log)

    def test_guards_and_missing_clips(self):
        put_arrangement(self.h, 0, 8.0, 4.0, True, "Arr1")
        cases = [({"clip": S(T0, 0), "expect_name": "Other"}, "name_mismatch"),
                 ({"clip": A(T0, 0, expect_start=1.0)}, "start_mismatch"),
                 ({"clip": A(T0, 0), "expect_name": "x"}, "name_mismatch"),
                 ({"clip": S(T0, 1)}, "empty_slot")]
        for args, reason in cases:
            error = self.h.error("clip_delete", args)
            self.assertEqual((error["code"], self.reason(error)), ("not_found", reason), args)
        self.assertEqual(self.h.error("clip_delete", {"clip": A(T0, 5)})["code"], "not_found")
        self.assertNoSideEffects()
        self.assertTrue(self.h.song.tracks[0].clip_slots[0].has_clip)


class DuplicateTests(ClipCase):
    def refs(self, **extra):
        return dict({"from": {"track": T0, "slot": 0}, "to": {"track": T0, "slot": 1}}, **extra)

    def test_duplicate_to_a_target_slot(self):
        info = self.h.ok("clip_duplicate", self.refs())["clip"]
        self.assertEqual((info["kind"], info["track"], info["slot_or_index"], info["name"]),
                         ("session", T0, 1, "Midi A"))
        copy = self.h.song.tracks[0].clip_slots[1].clip
        self.assertIsNot(copy, self.h.song.tracks[0].clip_slots[0].clip)
        self.assertEqual(len(copy.get_all_notes_extended()), 3)
        self.assertOneUndoStep()

    def test_occupied_target_needs_allow_overwrite(self):
        put_clip(self.h, 0, 1, True, "Keep")
        error = self.h.error("clip_duplicate", self.refs())
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "slot_occupied"))
        self.assertNoSideEffects()
        self.assertEqual(self.h.song.tracks[0].clip_slots[1].clip.name, "Keep")
        info = self.h.ok("clip_duplicate", self.refs(allow_overwrite=True))["clip"]
        self.assertEqual(info["name"], "Midi A")

    def test_other_refusals(self):
        cases = [({"from": {"track": T0, "slot": 0}, "to": {"track": T0, "slot": 0}}, "invalid_args", "same_slot"),
                 ({"from": {"track": T0, "slot": 0}, "to": {"track": T1, "slot": 1}}, "invalid_args",
                  "incompatible_track"),
                 ({"from": {"track": T1, "slot": 0}, "to": {"track": T0, "slot": 1}}, "invalid_args",
                  "incompatible_track"),
                 ({"from": {"track": T0, "slot": 0}, "allow_overwrite": True}, "invalid_args",
                  "overwrite_needs_target"),
                 ({"from": {"track": T0, "slot": 1}, "to": {"track": T0, "slot": 2}}, "not_found", "empty_slot")]
        for args, code, reason in cases:
            error = self.h.error("clip_duplicate", args)
            self.assertEqual((error["code"], self.reason(error)), (code, reason), args)
        self.assertEqual(self.h.error("clip_duplicate", self.refs(to={"track": T0, "slot": 9}))["code"], "not_found")
        self.assertNoSideEffects()

    def test_duplicate_into_the_next_free_slot(self):
        info = self.h.ok("clip_duplicate", {"from": {"track": T0, "slot": 0}})["clip"]
        self.assertEqual(info["slot_or_index"], 1)
        self.assertEqual(len(self.h.song.scenes), 3)

    def test_duplicate_without_target_can_append_a_scene(self):
        put_clip(self.h, 0, 1, True, "B")
        put_clip(self.h, 0, 2, True, "C")
        info = self.h.ok("clip_duplicate", {"from": {"track": T0, "slot": 0}})["clip"]
        self.assertEqual((info["slot_or_index"], len(self.h.song.scenes)), (1, 4))

    def test_edition_precheck_without_target_only(self):
        h = world(edition="lite", scenes=16)
        error = h.error("clip_duplicate", {"from": {"track": T0, "slot": 0}})
        self.assertEqual(error["code"], "edition_limit")
        self.assertEqual(error["details"], {"resource": "scenes", "limit": 16, "current": 16, "edition": "lite"})
        self.assertEqual((h.song.events, h.song.log), ([], []))
        h.ok("clip_duplicate", {"from": {"track": T0, "slot": 0}, "to": {"track": T0, "slot": 1}})
        h = world(edition="lite", scenes=15)
        h.ok("clip_duplicate", {"from": {"track": T0, "slot": 0}})

    def test_edition_limit_inside_batch(self):
        h = world(edition="lite", scenes=16)
        result = h.run("batch", {"ops": [{"cmd": "clip_duplicate", "args": {"from": {"track": T0, "slot": 0}}}]})
        self.assertEqual(result["error"]["code"], "edition_limit")
        self.assertEqual((h.song.events, h.song.log), ([], []))


class ClipSetTests(ClipCase):
    def clip(self):
        return self.h.song.tracks[0].clip_slots[0].clip

    def test_simple_fields(self):
        info = self.h.ok("clip_set", {"clip": S(T0, 0), "name": "Renamed", "color": 99, "muted": True,
                                      "looping": False})["clip"]
        self.assertEqual((info["name"], info["color"], info["muted"], info["looping"]),
                         ("Renamed", 99, True, False))
        self.assertOneUndoStep()

    def test_loop_writes_are_ordered_in_both_directions(self):
        self.h.ok("clip_set", {"clip": S(T0, 0), "loop_start": 10.0, "loop_end": 12.0})
        clip = self.clip()
        self.assertEqual((clip.loop_start, clip.loop_end), (10.0, 12.0))
        self.h.ok("clip_set", {"clip": S(T0, 0), "loop_start": 0.0, "loop_end": 4.0})
        self.assertEqual((clip.loop_start, clip.loop_end), (0.0, 4.0))

    def test_marker_writes_are_ordered_in_both_directions(self):
        self.h.ok("clip_set", {"clip": S(T0, 0), "start_marker": 10.0, "end_marker": 12.0})
        clip = self.clip()
        self.assertEqual((clip.start_marker, clip.end_marker), (10.0, 12.0))
        self.h.ok("clip_set", {"clip": S(T0, 0), "start_marker": 0.0, "end_marker": 4.0})
        self.assertEqual((clip.start_marker, clip.end_marker), (0.0, 4.0))

    def test_single_end_of_a_pair_is_checked_against_the_current_other_end(self):
        self.h.ok("clip_set", {"clip": S(T0, 0), "loop_end": 8.0})
        self.assertEqual(self.clip().loop_end, 8.0)
        for field in ("loop_start", "loop_end", "start_marker", "end_marker"):
            value = 9.0 if field.endswith("start") or field == "start_marker" else 0.0
            error = self.h.error("clip_set", {"clip": S(T0, 0), field: value})
            self.assertEqual(error["code"], "invalid_args", field)
        self.assertEqual(self.reason(self.h.error("clip_set", {"clip": S(T0, 0), "loop_start": 4.0, "loop_end": 4.0})),
                         "loop_range")
        self.assertEqual(self.reason(self.h.error("clip_set", {"clip": S(T0, 0), "start_marker": 5.0, "end_marker": 5.0})),
                         "marker_range")
        self.assertOneUndoStep()  # only the successful call above opened a step

    def test_invalid_range_writes_nothing(self):
        self.h.reset_log()
        self.h.error("clip_set", {"clip": S(T0, 0), "name": "Changed", "loop_start": 9.0})
        self.assertNoSideEffects()
        self.assertEqual(self.clip().name, "Midi A")

    def test_audio_only_fields(self):
        error = self.h.error("clip_set", {"clip": S(T0, 0), "gain": 0.5, "warping": False})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "audio_only"))
        self.assertEqual(error["details"]["fields"], ["gain", "warping"])
        self.assertNoSideEffects()
        info = self.h.ok("clip_set", {"clip": S(T1, 0), "gain": 0.5, "pitch_coarse": 2, "pitch_fine": -10.5,
                                      "warping": False})["clip"]
        self.assertEqual((info["gain"], info["pitch_coarse"], info["pitch_fine"], info["warping"]),
                         (0.5, 2, -10.5, False))

    def test_schema_ranges_and_empty_requests(self):
        for args in ({"pitch_coarse": 49}, {"pitch_coarse": -49}, {"pitch_fine": 50.5}, {"gain": 1.5},
                     {"gain": -0.1}, {"name": "x" * 129}, {"name": "a\x00b"}, {"muted": 1}, {"loop_start": -1},
                     {"unknown": 1}):
            self.assertEqual(self.h.error("clip_set", dict({"clip": S(T1, 0)}, **args))["code"],
                             "invalid_args", args)
        error = self.h.error("clip_set", {"clip": S(T0, 0)})
        self.assertEqual(self.reason(error), "at_least_one")
        self.assertNoSideEffects()

    def test_arrangement_clip_can_be_edited(self):
        put_arrangement(self.h, 0, 8.0, 4.0, True, "Arr1")
        info = self.h.ok("clip_set", {"clip": A(T0, 0), "name": "Verse", "color": 5})["clip"]
        self.assertEqual((info["kind"], info["name"], info["color"]), ("arrangement", "Verse", 5))

    def test_missing_clip_and_guard(self):
        self.assertEqual(self.h.error("clip_set", {"clip": S(T0, 1), "name": "x"})["code"], "not_found")
        self.assertNoSideEffects()


class CropAndDuplicateLoopTests(ClipCase):
    def test_crop(self):
        clip = self.h.song.tracks[0].clip_slots[0].clip
        clip.seed_notes((70, 9.0, 1.0))
        info = self.h.ok("clip_crop", {"clip": S(T0, 0)})["clip"]
        self.assertEqual(info["name"], "Midi A")
        self.assertEqual(len(clip.get_all_notes_extended()), 3)
        self.assertIn("call:clip.crop", self.h.song.log)
        self.assertOneUndoStep()

    def test_crop_arrangement_clip_and_missing(self):
        put_arrangement(self.h, 0, 8.0, 4.0)
        self.h.ok("clip_crop", {"clip": A(T0, 0)})
        self.assertEqual(self.h.error("clip_crop", {"clip": S(T0, 2)})["code"], "not_found")

    def test_duplicate_loop_doubles_the_loop(self):
        info = self.h.ok("clip_duplicate_loop", {"clip": S(T0, 0)})["clip"]
        self.assertEqual(info["length"], 8.0)
        self.assertEqual(len(self.h.song.tracks[0].clip_slots[0].clip.get_all_notes_extended()), 6)
        self.assertOneUndoStep()

    def test_duplicate_loop_is_not_offered_for_arrangement_clips(self):
        put_arrangement(self.h, 0, 8.0, 4.0)
        error = self.h.error("clip_duplicate_loop", {"clip": A(T0, 0)})
        self.assertEqual((error["code"], self.reason(error)), ("not_supported", "arrangement"))
        self.assertNoSideEffects()

    def test_live_error_is_mapped_with_partial_flag(self):
        error = self.h.error("clip_duplicate_loop", {"clip": S(T1, 0)})
        self.assertEqual(error["code"], "lom_error")
        self.assertTrue(error["details"]["partial"])


class SlotFireTests(ClipCase):
    def test_fire_a_clip(self):
        self.h.ok("slot_fire", {"track": T0, "slot": 0})
        self.assertIn("call:slot.fire:None:None", self.h.song.log)
        self.assertTrue(self.h.song.tracks[0].clip_slots[0].is_playing)
        self.assertOneUndoStep()

    def test_record_length_and_quantization_reach_live(self):
        self.h.ok("slot_fire", {"track": T0, "slot": 1, "record_length": 8, "launch_quantization": 0})
        self.h.ok("slot_fire", {"track": T0, "slot": 1, "record_length": 4})
        self.h.ok("slot_fire", {"track": T0, "slot": 0, "launch_quantization": 3})
        fires = [entry for entry in self.h.song.log if entry.startswith("call:slot.fire")]
        self.assertEqual(fires, ["call:slot.fire:8:0", "call:slot.fire:4:None", "call:slot.fire:None:3"])

    def test_schema(self):
        for args in ({"record_length": 0.2}, {"record_length": 257}, {"launch_quantization": 14},
                     {"launch_quantization": -1}, {"launch_quantization": 1.5}):
            self.assertEqual(self.h.error("slot_fire", dict({"track": T0, "slot": 0}, **args))["code"],
                             "invalid_args", args)
        self.assertEqual(self.h.error("slot_fire", {"track": T0, "slot": 9})["code"], "not_found")
        self.assertEqual(self.h.error("slot_fire", {"track": R0, "slot": 0})["code"], "invalid_args")
        self.assertNoSideEffects()

    def test_slot_stop(self):
        self.h.ok("slot_fire", {"track": T0, "slot": 0})
        self.h.reset_log()
        self.h.ok("slot_stop", {"track": T0, "slot": 0})
        self.assertFalse(self.h.song.tracks[0].clip_slots[0].is_playing)
        self.assertOneUndoStep()
        self.assertEqual(self.h.error("slot_stop", {"track": T0, "slot": 9})["code"], "not_found")

    def test_recording_refused_while_an_external_input_is_live(self):
        self.external_live()
        for args in ({"track": T0, "slot": 1, "record_length": 4},
                     {"track": T0, "slot": 0, "record_length": 4}):
            error = self.h.error("slot_fire", args)
            self.assertEqual((error["code"], self.reason(error)), ("not_supported", "external_input_live"))
            self.assertEqual(error["details"]["command"], "slot_fire")
        self.assertNoSideEffects()

    def test_firing_an_empty_slot_of_an_armed_track_is_a_recording(self):
        self.h.song.tracks[0]._arm = True
        self.h.reset_log()
        self.h.ok("slot_fire", {"track": T0, "slot": 1})  # nothing external is live: allowed
        self.h.reset_log()
        self.external_live()
        error = self.h.error("slot_fire", {"track": T0, "slot": 1})
        self.assertEqual(self.reason(error), "external_input_live")
        self.assertNoSideEffects()
        self.h.ok("slot_fire", {"track": T0, "slot": 0})  # a filled slot only plays

    def test_record_flags_already_on_block_every_fire_while_external_is_live(self):
        self.external_live()
        for flag in ("record_mode", "session_record"):
            setattr(self.h.song, flag, True)
            error = self.h.error("slot_fire", {"track": T0, "slot": 0})
            self.assertEqual((self.reason(error), error["details"]["command"]), ("external_input_live", "playback"))
            setattr(self.h.song, flag, False)
        self.assertEqual(self.h.song.events, [])
        self.assertFalse([entry for entry in self.h.song.log if entry.startswith("call:")])
        self.h.ok("slot_fire", {"track": T0, "slot": 0})  # flags off: plain playback stays allowed

    def test_same_guards_inside_batch(self):
        self.external_live()
        for args in ({"track": T0, "slot": 0, "record_length": 4}, {"track": T0, "slot": 1, "record_length": 4}):
            error = self.batch_error("slot_fire", args)
            self.assertEqual(self.reason(error), "external_input_live")
        self.h.song.tracks[0]._arm = True
        self.assertEqual(self.reason(self.batch_error("slot_fire", {"track": T0, "slot": 1})), "external_input_live")
        self.assertFalse([entry for entry in self.h.song.log if entry.startswith("call:slot.fire")])

    def test_stopping_is_always_allowed(self):
        self.external_live()
        self.h.song.record_mode = True
        self.h.ok("slot_stop", {"track": T0, "slot": 0})


if __name__ == "__main__":
    unittest.main()
