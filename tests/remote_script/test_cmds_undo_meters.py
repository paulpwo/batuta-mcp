"""T3 tests: undo/redo (spec 7.13) and meters (spec 7.14)."""

import unittest

from .fake_lom import LomHarness

T0 = {"kind": "track", "index": 0}
R0 = {"kind": "return", "index": 0}
M = {"kind": "master"}


class UndoRedoTests(unittest.TestCase):
    def setUp(self):
        self.h = LomHarness()
        self.song = self.h.song
        self.song.undo_stack = ["a", "b", "c"]
        self.song.redo_stack = ["x"]
        self.h.reset_log()

    def test_undo_state_is_a_pure_read(self):
        self.h.reset_log()
        self.assertEqual(self.h.ok("undo_state"), {"can_undo": True, "can_redo": True})
        self.assertEqual((self.song.log, self.song.events), ([], []))

    def test_undo_default_one_step_and_not_wrapped(self):
        self.h.reset_log()
        result = self.h.ok("undo")
        self.assertEqual(result, {"undone": 1, "can_undo": True, "can_redo": True})
        self.assertEqual(self.song.events, [])  # undo is never inside an undo step (5.3)
        self.assertEqual(self.song.log, ["call:undo"])

    def test_undo_many_stops_early(self):
        result = self.h.ok("undo", {"steps": 10})
        self.assertEqual(result["undone"], 3)
        self.assertFalse(result["can_undo"])
        self.assertEqual(self.h.ok("undo")["undone"], 0)

    def test_redo(self):
        self.song.redo_stack = ["x", "y"]
        result = self.h.ok("redo", {"steps": 5})
        self.assertEqual((result["redone"], result["can_redo"], result["can_undo"]), (2, False, True))
        self.assertEqual(self.song.events, [])
        self.assertEqual(self.h.ok("redo")["redone"], 0)

    def test_steps_range(self):
        for name in ("undo", "redo"):
            for value in (0, 11, -1, 1.5, "2", True):
                self.assertEqual(self.h.error(name, {"steps": value})["code"], "invalid_args", value)
        self.assertEqual(self.song.log, [])

    def test_classification(self):
        entries = {e["name"]: e for e in self.h.ok("catalog")["commands"]}
        self.assertEqual((entries["undo"]["mutating"], entries["undo"]["destructive"],
                          entries["undo"]["conditions"]), (True, "conditional", ["steps"]))
        self.assertEqual((entries["redo"]["mutating"], entries["redo"]["destructive"]), (True, "never"))
        self.assertFalse(entries["undo_state"]["mutating"])

    def test_not_allowed_inside_batch(self):
        for name in ("undo", "redo"):
            error = self.h.error("batch", {"ops": [{"cmd": name, "args": {}}]})
            self.assertEqual(error["details"]["reason"], "forbidden_in_batch")


class MetersTests(unittest.TestCase):
    def setUp(self):
        self.h = LomHarness()

    def test_selected_tracks(self):
        self.h.reset_log()
        result = self.h.ok("meters_get", {"tracks": [T0, R0, M]})
        self.assertEqual(result["meters"][0], {"track": T0, "left": 0.25, "right": 0.5, "level": 0.75})
        self.assertEqual([m["track"] for m in result["meters"]], [T0, R0, M])
        self.assertEqual((self.h.song.log, self.h.song.events), ([], []))

    def test_all_in_listing_order(self):
        result = self.h.ok("meters_get", {"all": True})
        self.assertEqual([m["track"] for m in result["meters"]],
                         [T0, {"kind": "track", "index": 1}, R0, M])

    def test_missing_meter_is_null(self):
        track = self.h.song.tracks[0]
        del track.output_meter_level
        self.assertIsNone(self.h.ok("meters_get", {"tracks": [T0]})["meters"][0]["level"])

    def test_invalid(self):
        bad = [{}, {"tracks": []}, {"tracks": [T0] * 33}, {"all": False}, {"tracks": [T0], "all": True},
               {"all": 1}, {"tracks": [{"kind": "x"}]}]
        for args in bad:
            self.assertEqual(self.h.error("meters_get", args)["code"], "invalid_args", args)
        self.assertEqual(self.h.error("meters_get", {"tracks": [{"kind": "track", "index": 9}]})["code"],
                         "not_found")
        self.assertEqual(self.h.error("meters_get", {"tracks": [{"kind": "track", "index": 0,
                                                                  "expect_name": "z"}]})
                         ["details"]["reason"], "name_mismatch")

    def test_thirty_two_tracks_allowed(self):
        self.h.ok("meters_get", {"tracks": [T0] * 32})


if __name__ == "__main__":
    unittest.main()
