"""T4a review round 1: arrangement extent, group slots, quantize grid values, notes defaults and
paging, partial-failure reporting, shared-helper efficiency and fail-closed reads."""

import json
import unittest
from unittest import mock

from remote_script.BatutaMCP import clip_commands, clip_lom, lom

from .clip_world import (A, IMPORT, NOTES, S, T0, T1, T2, ClipCase, add_device, put_arrangement, put_clip,
                         world)
from .fake_lom import FakeChainStub, FakeClip, FakeDeviceStub, FakeDrumPadStub, FakeLomTrack, FakeRackStub, LomHarness
from .test_cmds_notes import live_clip_module

import types


def track_writes(h):
    return [entry for entry in h.song.log if entry.startswith("call:track.")]


# ----------------------------------------------------------------- blocker: arrangement extent

class StretchedClipTests(ClipCase):
    """A 4-beat loop stretched to 16 beats on the timeline occupies [0, 16), not [0, 4)."""

    flags = IMPORT

    def setUp(self):
        super().setUp()
        put_arrangement(self.h, 0, 0.0, 4.0, True, "Stretched", extent=16.0)
        put_arrangement(self.h, 1, 0.0, 4.0, False, "AudioStretched", extent=16.0)

    def test_the_fake_models_extent_apart_from_loop_length(self):
        clip = self.h.song.tracks[0].arrangement_clips[0]
        self.assertEqual((clip.length, clip.start_time, clip.end_time), (4.0, 0.0, 16.0))

    def test_listing_reports_the_timeline_extent(self):
        row = self.h.ok("arrangement_clips", {"track": T0})["items"][0]
        self.assertEqual((row["start_time"], row["end_time"], row["length"]), (0.0, 16.0, 16.0))
        self.assertEqual(len(self.h.ok("arrangement_clips", {"track": T0, "from": 10, "to": 12})["items"]), 1)

    def test_duplicate_next_to_a_stretched_loop_is_refused(self):
        error = self.h.error("arrangement_duplicate", {"source": S(T0, 0), "track": T0, "time": 8})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "overlap"))
        self.assertNoSideEffects()
        self.h.ok("arrangement_duplicate", {"source": S(T0, 0), "track": T0, "time": 16})

    def test_clip_create_audio_and_commit_see_the_extent_too(self):
        for name, args in (("arrangement_clip_create", {"track": T0, "start": 8, "length": 2}),
                           ("audio_clip_create", {"track": T1, "position": 8.0, "expected_length_beats": 2.0,
                                                  "file_path": "/Samples/a.wav"}),
                           ("arrangement_commit_scene", {"scene": 0, "time": 8})):
            error = self.h.error(name, args)
            self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "overlap"), name)
        self.assertNoSideEffects()

    def test_duplicating_a_stretched_arrangement_clip_keeps_its_extent(self):
        put_arrangement(self.h, 2, 30.0, 4.0, True, "Blocker")
        error = self.h.error("arrangement_duplicate", {"source": A(T0, 0), "track": T2, "time": 20})
        self.assertEqual(self.reason(error), "overlap")  # [20, 36) meets the clip at 30, a 4-beat guess would not
        info = self.h.ok("arrangement_duplicate", {"source": A(T0, 0), "track": T2, "time": 40})["clip"]
        self.assertEqual((info["start_time"], info["end_time"]), (40.0, 56.0))

    def test_same_refusal_inside_batch(self):
        error = self.batch_error("arrangement_duplicate", {"source": S(T0, 0), "track": T0, "time": 8})
        self.assertEqual(self.reason(error), "overlap")
        self.assertFalse(track_writes(self.h))


# ----------------------------------------------------------------- major 1: group slots

def group_world():
    """Tracks 0 MIDI, 1 audio, 2 MIDI (child), 3 group of 2, 4 group of 3 (nested)."""
    h = LomHarness(kinds=("midi", "audio", "midi", "midi", "midi"), scenes=3)
    h.song.make_group(3, [2])
    h.song.make_group(4, [3])
    h.reset_log()
    return h


T3 = {"kind": "track", "index": 3}
T4 = {"kind": "track", "index": 4}


class GroupSlotTests(unittest.TestCase):
    def setUp(self):
        self.h = group_world()

    def external_live(self):
        self.h.song.tracks[1]._arm = True
        self.h.reset_log()

    def fires(self):
        return [e for e in self.h.song.log if e.startswith("call:slot.fire")]

    def test_group_slot_with_an_armed_empty_child_is_a_recording(self):
        self.h.song.tracks[2]._arm = True
        self.external_live()
        for group in (T3, T4):  # direct and nested groups
            error = self.h.error("slot_fire", {"track": group, "slot": 1})
            self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "external_input_live"))
        self.assertEqual((self.h.song.events, self.fires()), ([], []))

    def test_same_refusal_inside_batch(self):
        self.h.song.tracks[2]._arm = True
        self.external_live()
        response = self.h.run("batch", {"ops": [{"cmd": "slot_fire", "args": {"track": T4, "slot": 1}}]})
        self.assertEqual(response["error"]["details"]["reason"], "external_input_live")  # refused up front
        self.assertEqual(self.fires(), [])

    def test_group_slot_is_fine_when_nothing_would_record(self):
        self.external_live()
        self.h.ok("slot_fire", {"track": T3, "slot": 1})  # child not armed
        self.h.song.tracks[2]._arm = True
        self.h.song.tracks[2].clip_slots[1].clip = FakeClip("filled")  # armed child but the slot has a clip
        self.h.ok("slot_fire", {"track": T3, "slot": 1})
        self.assertFalse(self.h.song.tracks[2].clip_slots[1].is_recording)

    def test_group_slot_without_external_input_is_allowed(self):
        self.h.song.tracks[2]._arm = True
        self.h.ok("slot_fire", {"track": T3, "slot": 1})
        self.assertTrue(self.h.song.tracks[2].clip_slots[1].is_recording)

    def test_unreadable_group_membership_fails_closed(self):
        class Opaque(FakeLomTrack):
            @property
            def group_track(self):
                raise RuntimeError("group unreadable")

            @group_track.setter
            def group_track(self, value):
                pass

        self.h.song._insert_track(Opaque(self.h.song, "odd", False, 1), -1)
        self.external_live()
        error = self.h.error("slot_fire", {"track": T3, "slot": 1})
        self.assertEqual(error["details"]["reason"], "external_input_live")
        self.assertEqual(self.fires(), [])

    def test_plain_tracks_are_not_treated_as_groups(self):
        self.external_live()
        self.h.ok("slot_fire", {"track": T0, "slot": 1})


# ----------------------------------------------------------------- major 2: quantize grid values

class QuantizeGridTests(ClipCase):
    def quantize_calls(self, grid):
        self.h.reset_log()
        self.h.ok("notes_quantize", {"clip": S(T0, 0), "grid": grid})
        return [e for e in self.h.song.log if "quantize" in e]

    def test_uses_recording_quantization_when_present(self):
        enum = types.SimpleNamespace(rec_q_quarter=101, rec_q_eight=102, rec_q_sixtenth=105, rec_q_thirtysecond=108)
        namespace = types.SimpleNamespace(RecordingQuantization=enum)
        with live_clip_module() as module:
            module.Song = namespace
            for grid, value in (("1/4", 101), ("1/8", 102), ("1/16", 105), ("1/32", 108)):
                self.assertEqual(self.quantize_calls(grid), ["call:clip.quantize:%d:1.0" % value], grid)

    def test_clip_grid_quantization_is_never_used(self):
        enum = types.SimpleNamespace(g_quarter=901, g_eighth=902, g_sixteenth=905, g_thirtysecond=908)
        with live_clip_module(GridQuantization=enum):
            for grid, value in (("1/4", 1), ("1/8", 2), ("1/16", 5), ("1/32", 8)):
                self.assertEqual(self.quantize_calls(grid), ["call:clip.quantize:%d:1.0" % value], grid)

    def test_fixed_integers_without_live_enums(self):
        for grid, value in (("1/4", 1), ("1/8", 2), ("1/16", 5), ("1/32", 8)):
            self.assertEqual(self.quantize_calls(grid), ["call:clip.quantize:%d:1.0" % value])


# ----------------------------------------------------------------- minor: clip_duplicate result

class DuplicateResultTests(ClipCase):
    def test_new_scene_is_reported_at_the_next_index(self):
        put_clip(self.h, 0, 1, True, "B")
        put_clip(self.h, 0, 2, True, "C")
        info = self.h.ok("clip_duplicate", {"from": {"track": T0, "slot": 0}})["clip"]
        self.assertEqual((info["slot_or_index"], info["name"]), (1, "Midi A"))
        self.assertEqual(len(self.h.song.scenes), 4)
        self.assertEqual(self.h.song.tracks[0].clip_slots[2].clip.name, "B")  # shifted down, not overwritten

    def test_free_slot_below_is_reported(self):
        put_clip(self.h, 0, 1, True, "B")
        info = self.h.ok("clip_duplicate", {"from": {"track": T0, "slot": 0}})["clip"]
        self.assertEqual(info["slot_or_index"], 2)


# ----------------------------------------------------------------- minor: notes defaults and paging

class NotesRangeTests(ClipCase):
    def clip(self):
        return self.h.song.tracks[0].clip_slots[0].clip

    def test_defaults_cover_every_note(self):
        self.clip().seed_notes((70, -5.0, 1.0), (71, 50.0, 1.0), (72, 5.0e5, 1.0))
        found = self.h.ok("notes_get", {"clip": S(T0, 0)})
        self.assertEqual(found["total"], 6)
        self.assertEqual(found["items"][0]["start_time"], -5.0)

    def test_from_time_minimum_is_minus_one_million(self):
        self.clip().seed_notes((70, -5.0, 1.0))
        self.assertEqual(self.h.ok("notes_get", {"clip": S(T0, 0), "from_time": -1.0e6})["total"], 4)
        self.assertEqual(self.h.ok("notes_get", {"clip": S(T0, 0), "from_time": -4})["total"], 3)
        self.assertEqual(self.h.error("notes_get", {"clip": S(T0, 0), "from_time": -1.0e6 - 1})["code"],
                         "invalid_args")

    def test_remove_without_range_clears_notes_before_the_start_too(self):
        self.clip().seed_notes((70, -5.0, 1.0), (71, 50.0, 1.0))
        self.assertEqual(self.h.ok("notes_remove", {"clip": S(T0, 0)})["removed"], 5)
        self.assertEqual(self.clip().get_all_notes_extended(), [])

    def test_remove_from_time_accepts_negative_values(self):
        self.clip().seed_notes((70, -5.0, 1.0))
        self.assertEqual(self.h.ok("notes_remove", {"clip": S(T0, 0), "from_time": -6, "time_span": 2})["removed"], 1)

    def test_pages_stop_before_the_byte_budget(self):
        for _ in range(3):
            self.h.ok("notes_add", {"clip": S(T0, 0), "notes": [
                {"pitch": i % 128, "start_time": i / 7.0, "duration": 0.123456789, "velocity": 100.123456789,
                 "probability": 0.123456789} for i in range(2000)]})
        page = self.h.ok("notes_get", {"clip": S(T0, 0), "limit": 5000})
        self.assertLess(len(json.dumps(page["items"])), 920_000)
        self.assertLess(len(page["items"]), 5000)
        self.assertEqual(page["next_offset"], len(page["items"]))
        self.assertEqual(page["total"], 6003)
        rest = self.h.ok("notes_get", {"clip": S(T0, 0), "limit": 5000, "offset": page["next_offset"]})
        seen = {n["note_id"] for n in page["items"]} | {n["note_id"] for n in rest["items"]}
        self.assertEqual(len(seen), len(page["items"]) + len(rest["items"]))  # no overlap between pages

    def test_a_page_always_returns_at_least_one_note(self):
        with mock.patch.object(clip_commands, "NOTES_PAGE_BYTES", 10):
            page = self.h.ok("notes_get", {"clip": S(T0, 0)})
        self.assertEqual((len(page["items"]), page["next_offset"]), (1, 1))

    def test_small_results_have_no_next_offset(self):
        self.assertIsNone(self.h.ok("notes_get", {"clip": S(T0, 0)})["next_offset"])


class NotesRemoveIdsTests(ClipCase):
    def test_only_unknown_ids_is_refused_without_an_undo_step(self):
        error = self.h.error("notes_remove", {"clip": S(T0, 0), "note_ids": [98, 99]})
        self.assertEqual((error["code"], error["details"]["what"], error["details"]["missing"]), ("not_found", "note", 2))
        self.assertNoSideEffects()

    def test_mixed_ids_report_the_missing_count(self):
        result = self.h.ok("notes_remove", {"clip": S(T0, 0), "note_ids": [1, 99]})
        self.assertEqual(result, {"removed": 1, "missing": 1})
        self.assertOneUndoStep()

    def test_same_refusal_inside_batch(self):
        error = self.batch_error("notes_remove", {"clip": S(T0, 0), "note_ids": [99]})
        self.assertEqual(error["code"], "not_found")
        self.assertFalse([e for e in self.h.song.log if e.startswith("call:clip.remove")])


# ----------------------------------------------------------------- minor: commit partial failure

class CommitPartialTests(ClipCase):
    def test_failure_names_the_tracks_already_written(self):
        original = type(self.h.song.tracks[1]).duplicate_clip_to_arrangement

        def boom(track, clip, time):
            if track is self.h.song.tracks[1]:
                raise RuntimeError("Live refused")
            return original(track, clip, time)

        with mock.patch.object(type(self.h.song.tracks[1]), "duplicate_clip_to_arrangement", boom):
            error = self.h.error("arrangement_commit_scene", {"scene": 0, "time": 32})
        self.assertEqual(error["code"], "lom_error")
        self.assertEqual(error["details"]["done"], [T0])
        self.assertTrue(error["details"]["partial"])
        self.assertEqual(len(self.h.song.tracks[0].arrangement_clips), 1)

    def test_failure_on_the_first_track_has_an_empty_done_list(self):
        def boom(track, clip, time):
            raise RuntimeError("Live refused")

        with mock.patch.object(type(self.h.song.tracks[0]), "duplicate_clip_to_arrangement", boom):
            error = self.h.error("arrangement_commit_scene", {"scene": 0, "time": 32})
        self.assertEqual(error["details"]["done"], [])


# ----------------------------------------------------------------- minor: shared helper cost

class Counted:
    compares = 0

    def __init__(self, value):
        self.value = value

    def __eq__(self, other):
        Counted.compares += 1
        return isinstance(other, Counted) and self.value == other.value

    __hash__ = None


class NewItemsTests(unittest.TestCase):
    def test_results_for_insert_delete_and_mixed_changes(self):
        a, b, c, d = (Counted(x) for x in "abcd")
        self.assertEqual(lom.new_items([a, b, c], [a, b, c, d]), [d])
        self.assertEqual(lom.new_items([a, b, c], [d, a, b, c]), [d])
        self.assertEqual(lom.new_items([a, b, c], [a, c, d]), [d])  # b was removed meanwhile
        self.assertEqual(lom.new_items([a, b], [a, b]), [])
        self.assertEqual(lom.new_items([], [a]), [a])
        self.assertEqual(lom.new_items([a, b], []), [])

    def test_cost_is_linear_for_an_appended_item(self):
        before = [Counted(i) for i in range(2000)]
        after = before + [Counted(-1)]
        Counted.compares = 0
        self.assertEqual(len(lom.new_items(before, after)), 1)
        self.assertLess(Counted.compares, 10_000)


# ----------------------------------------------------------------- minor: drum racks walked once

class DrumRackWalkTests(ClipCase):
    def test_drum_rack_parameters_are_listed_once(self):
        kick = FakeDeviceStub("Kick", "Eq", 2, 2)
        rack = FakeRackStub("Drums", chains=[FakeChainStub("k", [kick])],
                            drum_pads=[FakeDrumPadStub(36, [FakeChainStub("k", [kick])])])
        self.h.song.tracks[0].devices.append(rack)
        clip = self.h.song.tracks[0].clip_slots[0].clip
        clip.create_automation_envelope(kick.parameters[0])
        self.h.reset_log()
        result = self.h.ok("envelope_list", {"clip": S(T0, 0)})
        self.assertEqual(result["scanned"], 2 + 2)  # the rack's own two parameters and the kick's two, once
        self.assertEqual(len(result["envelopes"]), 1)
        self.assertEqual(result["envelopes"][0]["device"]["path"][1], {"drum_pad": 36, "chain": 0, "device": 0})


# ----------------------------------------------------------------- minor: arrangement clips growing into neighbours

class TimelineGrowthTests(ClipCase):
    def setUp(self):
        super().setUp()
        self.clip = put_arrangement(self.h, 0, 0.0, 4.0, True, "A")
        put_arrangement(self.h, 0, 4.0, 4.0, True, "B")

    def refused(self, args):
        error = self.h.error("clip_set", dict({"clip": A(T0, 0)}, **args))
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "overlap"), args)
        self.assertNoSideEffects()

    def test_growing_the_loop_into_the_next_clip_is_refused(self):
        self.refused({"loop_end": 8.0})
        self.refused({"loop_end": 5.0})

    def test_growing_the_end_marker_with_the_loop_off_is_refused(self):
        self.refused({"looping": False, "end_marker": 8.0})

    def test_shrinking_and_unrelated_edits_are_fine(self):
        self.h.ok("clip_set", {"clip": A(T0, 0), "loop_end": 2.0})
        self.h.ok("clip_set", {"clip": A(T0, 0), "name": "Renamed", "color": 3, "muted": True})
        self.assertEqual(self.clip.loop_end, 2.0)

    def test_growth_that_stays_clear_of_the_neighbour_is_fine(self):
        put_arrangement(self.h, 1, 0.0, 4.0, False, "Alone")
        self.h.ok("clip_set", {"clip": A(T1, 0), "loop_end": 10.0})

    def test_stretched_clips_grow_from_their_timeline_end(self):
        stretched = put_arrangement(self.h, 2, 0.0, 4.0, True, "S", extent=16.0)
        put_arrangement(self.h, 2, 18.0, 4.0, True, "Next")
        error = self.h.error("clip_set", {"clip": A(T2, 0), "loop_end": 8.0})  # +4 beats: [16, 20) meets Next
        self.assertEqual(self.reason(error), "overlap")
        self.h.ok("clip_set", {"clip": A(T2, 0), "loop_end": 6.0})  # +2 beats: [16, 18) just fits
        self.assertEqual(stretched.loop_end, 6.0)

    def test_session_clips_are_not_restricted(self):
        self.h.ok("clip_set", {"clip": S(T0, 0), "loop_end": 8.0})

    def test_crop_that_could_extend_the_clip_is_refused(self):
        self.clip.looping = False
        self.clip._loop_end = 8.0  # the loop region is wider than the played region
        self.h.reset_log()
        error = self.h.error("clip_crop", {"clip": A(T0, 0)})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "overlap"))
        self.assertNoSideEffects()

    def test_crop_of_a_fitting_arrangement_clip_works(self):
        self.h.ok("clip_crop", {"clip": A(T0, 0)})

    def test_refused_inside_batch(self):
        error = self.batch_error("clip_set", {"clip": A(T0, 0), "loop_end": 8.0})
        self.assertEqual(self.reason(error), "overlap")
        self.assertFalse([e for e in self.h.song.log if "loop_end" in e])


class ExtentFailsTowardStrictTests(unittest.TestCase):
    def clip(self, flag, end=16.0):
        class Stub:
            length = 4.0
            start_time = 0.0
            end_time = end

            @property
            def is_arrangement_clip(self):
                if flag == "raises":
                    raise RuntimeError("unreadable")
                return flag

        return Stub()

    def test_unreadable_flag_is_treated_as_an_arrangement_clip(self):
        self.assertEqual(clip_lom.new_clip_extent(self.clip("raises")), 16.0)

    def test_arrangement_clip_uses_the_larger_of_length_and_extent(self):
        self.assertEqual(clip_lom.new_clip_extent(self.clip(True)), 16.0)
        self.assertEqual(clip_lom.new_clip_extent(self.clip(True, end=2.0)), 4.0)

    def test_session_clip_takes_its_length(self):
        self.assertEqual(clip_lom.new_clip_extent(self.clip(False)), 4.0)

    def test_unreadable_times_fall_back_to_the_length(self):
        stub = self.clip("raises")
        stub.end_time = None
        self.assertEqual(clip_lom.new_clip_extent(stub), 4.0)


class DuplicateWithoutReturnValueTests(ClipCase):
    def setUp(self):
        super().setUp()
        self.h.song.tracks[0].__dict__["_dup_returns_none"] = True

    def test_new_scene_branch_without_a_return_value(self):
        put_clip(self.h, 0, 1, True, "B")
        put_clip(self.h, 0, 2, True, "C")
        info = self.h.ok("clip_duplicate", {"from": {"track": T0, "slot": 0}})["clip"]
        self.assertEqual((info["slot_or_index"], len(self.h.song.scenes)), (1, 4))

    def test_scan_fallback_finds_the_free_slot_without_a_return_value(self):
        put_clip(self.h, 0, 1, True, "B")
        info = self.h.ok("clip_duplicate", {"from": {"track": T0, "slot": 0}})["clip"]
        self.assertEqual((info["slot_or_index"], len(self.h.song.scenes)), (2, 3))


class ArrangementListExtentTests(ClipCase):
    def test_length_is_the_timeline_extent_and_loop_length_is_live_length(self):
        put_arrangement(self.h, 0, 0.0, 4.0, True, "Stretched", extent=16.0)
        put_arrangement(self.h, 0, 20.0, 2.0, True, "Plain")
        rows = self.h.ok("arrangement_clips", {"track": T0})["items"]
        self.assertEqual([(r["length"], r["loop_length"], r["end_time"]) for r in rows],
                         [(16.0, 4.0, 16.0), (2.0, 2.0, 22.0)])


class CreatedClipIdentityTests(ClipCase):
    def test_the_reported_clip_is_the_one_at_the_requested_position(self):
        """Live may leave trimmed remainders of overwritten clips behind; they are new objects too."""
        track = self.h.song.tracks[0]
        original = type(track).duplicate_clip_to_arrangement

        def with_remainder(this, clip, time):
            made = original(this, clip, time)
            this._place(FakeClip("remainder", True, 1.0), 1.0)
            return made

        with mock.patch.object(type(track), "duplicate_clip_to_arrangement", with_remainder):
            info = self.h.ok("arrangement_duplicate", {"source": S(T0, 0), "track": T0, "time": 20})["clip"]
        self.assertEqual((info["start_time"], info["name"]), (20.0, "Midi A"))


# ----------------------------------------------------------------- minor: fail-closed reads and boundaries

class FailClosedTests(ClipCase):
    def test_slot_fire_with_an_unreadable_arm_state_counts_as_armed(self):
        self.external_live()
        self.h.song.tracks[0]._arm_raises = True
        error = self.h.error("slot_fire", {"track": T0, "slot": 1})
        self.assertEqual(self.reason(error), "external_input_live")
        self.assertEqual(self.reason(self.batch_error("slot_fire", {"track": T0, "slot": 1})), "external_input_live")
        self.assertFalse([e for e in self.h.song.log if e.startswith("call:slot.fire")])

    def test_unreadable_arm_without_external_input_is_allowed(self):
        self.h.song.tracks[0]._arm_raises = True
        self.h.ok("slot_fire", {"track": T0, "slot": 1})

    def test_expect_start_tolerance_is_one_micro_beat(self):
        put_arrangement(self.h, 0, 8.0, 4.0)
        self.h.ok("clip_get", {"clip": A(T0, 0, expect_start=8.0 + 5e-7)})
        self.h.ok("clip_get", {"clip": A(T0, 0, expect_start=8.0 - 5e-7)})
        for off in (3e-6, -3e-6):
            error = self.h.error("clip_get", {"clip": A(T0, 0, expect_start=8.0 + off)})
            self.assertEqual(self.reason(error), "start_mismatch")


if __name__ == "__main__":
    unittest.main()
