"""T4a tests: notes through the Live 11+ extended API (spec 7.6 notes_*)."""

import contextlib
import sys
import types
import unittest

from . import fakes
from .clip_world import A, S, T0, T1, ClipCase, put_arrangement, put_clip

CLIP = S(T0, 0)


def note(**extra):
    return dict({"pitch": 72, "start_time": 0.5, "duration": 0.25}, **extra)


@contextlib.contextmanager
def live_clip_module(**attrs):
    """A fake `Live` module whose `Clip` namespace holds `attrs`; the previous module is restored."""
    previous = sys.modules.get("Live")
    module = fakes.install_fake_live()
    module.Clip = types.SimpleNamespace(**attrs)
    try:
        yield module
    finally:
        if previous is None:
            fakes.uninstall_fake_live()
        else:
            sys.modules["Live"] = previous


class NotesGetTests(ClipCase):
    def clip(self):
        return self.h.song.tracks[0].clip_slots[0].clip

    def test_returns_sorted_notes_with_all_fields(self):
        self.clip().seed_notes((50, 1.0, 0.5, 80.0))
        result = self.h.ok("notes_get", {"clip": CLIP})
        self.assertEqual([(n["start_time"], n["pitch"]) for n in result["items"]],
                         [(0.0, 60), (1.0, 50), (1.0, 64), (2.0, 67)])
        self.assertEqual(result["items"][0], {
            "note_id": 1, "pitch": 60, "start_time": 0.0, "duration": 1.0, "velocity": 100.0, "mute": False,
            "probability": 1.0, "velocity_deviation": 0.0, "release_velocity": 64.0})
        self.assertEqual((result["total"], result["next_offset"]), (4, None))
        self.assertNoSideEffects()

    def test_range_arguments(self):
        result = self.h.ok("notes_get", {"clip": CLIP, "from_pitch": 62, "pitch_span": 5})
        self.assertEqual([n["pitch"] for n in result["items"]], [64])
        result = self.h.ok("notes_get", {"clip": CLIP, "from_time": 1, "time_span": 1})
        self.assertEqual([n["pitch"] for n in result["items"]], [64])

    def test_explicit_time_span_narrows_the_default_range(self):
        self.clip().seed_notes((70, 5.0, 1.0))
        self.assertEqual(len(self.h.ok("notes_get", {"clip": CLIP, "from_time": 0, "time_span": 4})["items"]), 3)
        self.assertEqual(len(self.h.ok("notes_get", {"clip": CLIP})["items"]), 4)

    def test_paging_and_the_5000_cap(self):
        page = self.h.ok("notes_get", {"clip": CLIP, "limit": 2})
        self.assertEqual((len(page["items"]), page["next_offset"], page["total"]), (2, 2, 3))
        rest = self.h.ok("notes_get", {"clip": CLIP, "limit": 2, "offset": 2})
        self.assertEqual((len(rest["items"]), rest["next_offset"]), (1, None))
        self.h.ok("notes_get", {"clip": CLIP, "limit": 5000})
        for limit in (0, 5001):
            self.assertEqual(self.h.error("notes_get", {"clip": CLIP, "limit": limit})["code"], "invalid_args")

    def test_midi_clips_only_and_arrangement_clips_work(self):
        error = self.h.error("notes_get", {"clip": S(T1, 0)})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "not_midi_clip"))
        put_arrangement(self.h, 0, 8.0, 4.0).seed_notes((60, 0.0, 1.0))
        self.assertEqual(self.h.ok("notes_get", {"clip": A(T0, 0)})["total"], 1)
        self.assertEqual(self.h.error("notes_get", {"clip": S(T0, 1)})["code"], "not_found")

    def test_bad_arguments(self):
        for args in ({"pitch_span": 0}, {"pitch_span": 129}, {"from_pitch": 128}, {"from_time": -1.0e6 - 1},
                     {"time_span": 0}, {"extra": 1}):
            self.assertEqual(self.h.error("notes_get", dict({"clip": CLIP}, **args))["code"], "invalid_args", args)


class NotesAddTests(ClipCase):
    def clip(self):
        return self.h.song.tracks[0].clip_slots[0].clip

    def test_adds_notes_with_defaults(self):
        result = self.h.ok("notes_add", {"clip": CLIP, "notes": [note(), note(pitch=73, velocity=64.5)]})
        self.assertEqual(result, {"added": 2})
        added = self.h.ok("notes_get", {"clip": CLIP, "from_pitch": 72, "pitch_span": 2})["items"]
        self.assertEqual({(n["pitch"], n["velocity"]) for n in added}, {(72, 100.0), (73, 64.5)})
        self.assertEqual((added[0]["mute"], added[0]["probability"], added[0]["velocity_deviation"],
                          added[0]["release_velocity"]), (False, 1.0, 0.0, 64.0))
        self.assertEqual(self.clip()._add_form, "dict")

    def test_one_undo_step_and_one_live_call(self):
        self.h.ok("notes_add", {"clip": CLIP, "notes": [note(), note(pitch=73)]})
        self.assertOneUndoStep()
        self.assertEqual([e for e in self.h.song.log if "add_new_notes" in e], ["call:clip.add_new_notes:2"])

    def test_explicit_values_reach_the_note(self):
        self.h.ok("notes_add", {"clip": CLIP, "notes": [note(mute=True, probability=0.5, velocity_deviation=-12,
                                                             release_velocity=10)]})
        added = self.h.ok("notes_get", {"clip": CLIP, "from_pitch": 72, "pitch_span": 1})["items"][0]
        self.assertEqual((added["mute"], added["probability"], added["velocity_deviation"],
                          added["release_velocity"]), (True, 0.5, -12.0, 10.0))

    def test_uses_live_note_specification_objects_when_available(self):
        made = []

        def spec(**values):
            made.append(values)
            return types.SimpleNamespace(**values)

        with live_clip_module(MidiNoteSpecification=spec):
            self.h.ok("notes_add", {"clip": CLIP, "notes": [note()]})
        self.assertEqual(self.clip()._add_form, "object")
        self.assertEqual(made, [{"pitch": 72, "start_time": 0.5, "duration": 0.25, "velocity": 100.0,
                                 "mute": False, "probability": 1.0, "velocity_deviation": 0.0,
                                 "release_velocity": 64.0}])

    def test_schema_rejections_leave_no_trace(self):
        bad = [note(pitch=128), note(pitch=-1), note(pitch=True), note(pitch=60.5), note(start_time=-1),
               note(duration=0), note(duration=-1), note(velocity=0), note(velocity=128),
               note(probability=1.1), note(probability=-0.1), note(velocity_deviation=128),
               note(release_velocity=-1), note(release_velocity=128), note(mute=1), note(surprise=1),
               {"pitch": 60, "start_time": 0}, {"pitch": 60, "duration": 1}, {"start_time": 0, "duration": 1}]
        for item in bad:
            self.assertEqual(self.h.error("notes_add", {"clip": CLIP, "notes": [item]})["code"],
                             "invalid_args", item)
        for notes in ([], [note()] * 2001, "x"):
            self.assertEqual(self.h.error("notes_add", {"clip": CLIP, "notes": notes})["code"], "invalid_args")
        self.assertNoSideEffects()

    def test_2000_notes_are_accepted(self):
        self.assertEqual(self.h.ok("notes_add", {"clip": CLIP, "notes": [note()] * 2000}), {"added": 2000})

    def test_midi_clips_only(self):
        error = self.h.error("notes_add", {"clip": S(T1, 0), "notes": [note()]})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "not_midi_clip"))
        self.assertEqual(self.h.error("notes_add", {"clip": S(T0, 1), "notes": [note()]})["code"], "not_found")
        self.assertNoSideEffects()

    def test_batch_path_refuses_per_op(self):
        error = self.batch_error("notes_add", {"clip": S(T1, 0), "notes": [note()]})
        self.assertEqual(self.reason(error), "not_midi_clip")
        self.assertFalse([e for e in self.h.song.log if "add_new_notes" in e])

    def test_arrangement_clip_notes(self):
        put_arrangement(self.h, 0, 8.0, 4.0)
        self.h.ok("notes_add", {"clip": A(T0, 0), "notes": [note()]})
        self.assertEqual(self.h.ok("notes_get", {"clip": A(T0, 0)})["total"], 1)


class NotesRemoveTests(ClipCase):
    def clip(self):
        return self.h.song.tracks[0].clip_slots[0].clip

    def test_remove_by_pitch_range(self):
        result = self.h.ok("notes_remove", {"clip": CLIP, "from_pitch": 60, "pitch_span": 5})
        self.assertEqual(result, {"removed": 2})
        self.assertEqual([n.pitch for n in self.clip().get_all_notes_extended()], [67])
        self.assertOneUndoStep()

    def test_remove_by_time_range(self):
        self.assertEqual(self.h.ok("notes_remove", {"clip": CLIP, "from_time": 1, "time_span": 1}), {"removed": 1})

    def test_omitted_range_clears_everything_even_past_the_clip_end(self):
        self.clip().seed_notes((70, 50.0, 1.0))
        self.assertEqual(self.h.ok("notes_remove", {"clip": CLIP}), {"removed": 4})
        self.assertEqual(self.clip().get_all_notes_extended(), [])

    def test_remove_by_ids_counts_only_existing_notes(self):
        result = self.h.ok("notes_remove", {"clip": CLIP, "note_ids": [1, 3, 99]})
        self.assertEqual(result, {"removed": 2, "missing": 1})
        self.assertEqual([n.note_id for n in self.clip().get_all_notes_extended()], [2])
        self.assertIn("call:clip.remove_notes_by_id:2", self.h.song.log)

    def test_ids_that_match_nothing_write_nothing(self):
        self.assertEqual(self.h.error("notes_remove", {"clip": CLIP, "note_ids": [98, 99]})["code"], "not_found")
        self.assertFalse([e for e in self.h.song.log if e.startswith("call:clip.remove")])

    def test_ids_and_ranges_are_exclusive_and_ids_are_bounded(self):
        for extra in ({"from_pitch": 1}, {"pitch_span": 1}, {"from_time": 0}, {"time_span": 1}):
            self.assertEqual(self.h.error("notes_remove", dict({"clip": CLIP, "note_ids": [1]}, **extra))["code"],
                             "invalid_args", extra)
        for ids in ([], [1, 1], list(range(2001)), [-1], [True]):
            self.assertEqual(self.h.error("notes_remove", {"clip": CLIP, "note_ids": ids})["code"],
                             "invalid_args", ids)
        self.assertNoSideEffects()

    def test_remove_by_id_needs_the_live_method(self):
        self.clip().hide("remove_notes_by_id")
        error = self.h.error("notes_remove", {"clip": CLIP, "note_ids": [1]})
        self.assertEqual((error["code"], self.reason(error)), ("not_supported", "live_version"))
        self.assertNoSideEffects()
        self.assertEqual(self.h.ok("notes_remove", {"clip": CLIP, "from_pitch": 60, "pitch_span": 1}), {"removed": 1})

    def test_midi_only_and_batch_parity(self):
        self.assertEqual(self.reason(self.h.error("notes_remove", {"clip": S(T1, 0)})), "not_midi_clip")
        self.assertEqual(self.reason(self.batch_error("notes_remove", {"clip": S(T1, 0)})), "not_midi_clip")
        self.assertFalse([e for e in self.h.song.log if e.startswith("call:clip.remove")])


class NotesModifyTests(ClipCase):
    def clip(self):
        return self.h.song.tracks[0].clip_slots[0].clip

    def test_modifies_only_the_named_fields_of_the_named_notes(self):
        result = self.h.ok("notes_modify", {"clip": CLIP, "notes": [
            {"note_id": 2, "velocity": 90, "pitch": 65}, {"note_id": 3, "mute": True}]})
        self.assertEqual(result, {"modified": 2})
        notes = {n.note_id: n for n in self.clip().get_all_notes_extended()}
        self.assertEqual((notes[2].pitch, notes[2].velocity, notes[2].start_time), (65, 90.0, 1.0))
        self.assertEqual((notes[3].mute, notes[3].pitch), (True, 67))
        self.assertEqual((notes[1].pitch, notes[1].velocity, notes[1].mute), (60, 100.0, False))
        self.assertEqual([e for e in self.h.song.log if "apply_note" in e], ["call:clip.apply_note_modifications:2"])
        self.assertOneUndoStep()

    def test_hands_live_the_vector_it_returned_not_a_python_list(self):
        self.h.ok("notes_modify", {"clip": CLIP, "notes": [{"note_id": 2, "velocity": 90}]})
        self.assertIn("call:clip.get_notes_by_id:1", self.h.song.log)
        self.assertEqual(self.clip().get_all_notes_extended()[1].velocity, 90.0)

    def test_falls_back_to_the_extended_read_without_get_notes_by_id(self):
        self.clip().hide("get_notes_by_id")
        result = self.h.ok("notes_modify", {"clip": CLIP, "notes": [{"note_id": 3, "mute": True}]})
        self.assertEqual(result, {"modified": 1})
        notes = {n.note_id: n for n in self.clip().get_all_notes_extended()}
        self.assertEqual((notes[3].mute, notes[1].mute, notes[2].mute), (True, False, False))

    def test_every_field_is_settable(self):
        self.h.ok("notes_modify", {"clip": CLIP, "notes": [{
            "note_id": 1, "pitch": 61, "start_time": 0.5, "duration": 0.75, "velocity": 70.5, "mute": True,
            "probability": 0.25, "velocity_deviation": 5, "release_velocity": 33}]})
        changed = self.clip().get_all_notes_extended()[0]
        self.assertEqual((changed.pitch, changed.start_time, changed.duration, changed.velocity, changed.mute,
                          changed.probability, changed.velocity_deviation, changed.release_velocity),
                         (61, 0.5, 0.75, 70.5, True, 0.25, 5.0, 33.0))

    def test_unknown_note_id_is_not_found_and_nothing_is_written(self):
        error = self.h.error("notes_modify", {"clip": CLIP, "notes": [{"note_id": 1, "velocity": 50},
                                                                       {"note_id": 99, "velocity": 50}]})
        self.assertEqual((error["code"], error["details"]["what"], error["details"]["index"]),
                         ("not_found", "note", 99))
        self.assertNoSideEffects()
        self.assertEqual(self.clip().get_all_notes_extended()[0].velocity, 100.0)

    def test_malformed_requests(self):
        cases = [[{"note_id": 1}], [{"note_id": 1, "velocity": 5}, {"note_id": 1, "velocity": 6}],
                 [{"velocity": 5}], [{"note_id": 1, "pitch": 200}], [{"note_id": 1, "duration": 0}],
                 [{"note_id": -1, "velocity": 5}], [{"note_id": 1, "velocity": 5, "extra": 1}], []]
        for notes in cases:
            self.assertEqual(self.h.error("notes_modify", {"clip": CLIP, "notes": notes})["code"],
                             "invalid_args", notes)
        self.assertNoSideEffects()

    def test_midi_only_and_batch_parity(self):
        self.assertEqual(self.reason(self.h.error("notes_modify", {"clip": S(T1, 0), "notes": [
            {"note_id": 1, "velocity": 5}]})), "not_midi_clip")
        error = self.batch_error("notes_modify", {"clip": CLIP, "notes": [{"note_id": 50, "velocity": 5}]})
        self.assertEqual(error["code"], "not_found")
        self.assertFalse([e for e in self.h.song.log if "apply_note" in e])


class NotesQuantizeTests(ClipCase):
    def clip(self):
        return self.h.song.tracks[0].clip_slots[0].clip

    def test_grids_map_to_live_values(self):
        for grid, value in (("1/4", 1), ("1/8", 2), ("1/16", 5), ("1/32", 8)):
            self.h.reset_log()
            self.h.ok("notes_quantize", {"clip": CLIP, "grid": grid})
            self.assertEqual([e for e in self.h.song.log if "quantize" in e], ["call:clip.quantize:%d:1.0" % value])
        self.assertOneUndoStep()

    def test_amount_and_effect(self):
        self.clip().seed_notes((72, 0.3, 0.5))
        self.h.ok("notes_quantize", {"clip": CLIP, "grid": "1/4", "amount": 0.5})
        moved = [n for n in self.clip().get_all_notes_extended() if n.pitch == 72][0]
        self.assertAlmostEqual(moved.start_time, 0.15)
        self.h.ok("notes_quantize", {"clip": CLIP, "grid": "1/4"})
        moved = [n for n in self.clip().get_all_notes_extended() if n.pitch == 72][0]
        self.assertAlmostEqual(moved.start_time, 0.0)

    def test_single_pitch_uses_quantize_pitch(self):
        self.clip().seed_notes((72, 0.3, 0.5))
        self.h.ok("notes_quantize", {"clip": CLIP, "grid": "1/16", "amount": 0.5, "pitch": 72})
        self.assertEqual([e for e in self.h.song.log if "quantize" in e], ["call:clip.quantize_pitch:72:5:0.5"])

    def test_pitch_quantize_needs_the_live_method(self):
        self.clip().hide("quantize_pitch")
        error = self.h.error("notes_quantize", {"clip": CLIP, "grid": "1/8", "pitch": 60})
        self.assertEqual((error["code"], self.reason(error)), ("not_supported", "live_version"))
        self.assertNoSideEffects()
        self.h.ok("notes_quantize", {"clip": CLIP, "grid": "1/8"})

    def test_bad_arguments(self):
        for args in ({"grid": "1/3"}, {"grid": "1/8", "amount": 1.1}, {"grid": "1/8", "amount": -0.1},
                     {"grid": "1/8", "pitch": 128}, {}, {"grid": 8}):
            self.assertEqual(self.h.error("notes_quantize", dict({"clip": CLIP}, **args))["code"], "invalid_args", args)
        self.assertEqual(self.reason(self.h.error("notes_quantize", {"clip": S(T1, 0), "grid": "1/8"})),
                         "not_midi_clip")
        self.assertNoSideEffects()
        self.assertEqual(self.reason(self.batch_error("notes_quantize", {"clip": S(T1, 0), "grid": "1/8"})),
                         "not_midi_clip")
        self.assertFalse([e for e in self.h.song.log if "quantize" in e])


if __name__ == "__main__":
    unittest.main()
