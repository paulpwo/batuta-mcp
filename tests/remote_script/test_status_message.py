"""Status bar feedback (docs/01-protocol.md, "Status bar feedback"): one short ASCII line per
mutating command, built only from the command name, numbers and schema enums."""

import unittest

from remote_script.BatutaMCP import clip_lom
from remote_script.BatutaMCP import validator as v
from remote_script.BatutaMCP.errors import BatutaError
from remote_script.BatutaMCP.registry import Command
from remote_script.BatutaMCP.session_commands import SONG_SET_SCHEMA

from .test_dispatch import Harness


class StatusHarness(Harness):
    def _install_test_commands(self):
        super()._install_test_commands()
        song, reg = self.song, self.registry.register

        def mutate(ctx, args):
            song.events.append("handler")
            return {}

        def refuse(ctx, args):
            raise BatutaError("not_found", "no such track", {"what": "track", "index": 9})

        reg(Command("song_set", SONG_SET_SCHEMA, mutate, mutating=True))
        reg(Command("mixer_set", v.obj({"track": v.TRACK_REF, "volume_db": v.number(),
                                        "name": v.string(max_chars=64)}, required=["track"]),
                    mutate, mutating=True))
        reg(Command("clip_create", v.obj({"clip": clip_lom.CLIP_REF, "length": v.number(),
                                          "path": v.string(max_chars=200)}, required=["clip"]),
                    mutate, mutating=True))
        reg(Command("scene_fire", v.obj({"scene": v.integer(min=0)}, required=["scene"]),
                    mutate, mutating=True))
        reg(Command("device_set", v.obj({"track_index": v.integer(min=0),
                                         "device_index": v.integer(min=0),
                                         "value": v.number()}, required=["track_index"]),
                    mutate, mutating=True))
        reg(Command("view_show", v.obj({"view": v.enum("session", "arrangement"),
                                        "note": v.string(max_chars=80)}, required=["view"]),
                    mutate, mutating=True))
        reg(Command("track_get_t", v.obj({"track": v.TRACK_REF}, required=["track"]), mutate))
        reg(Command("refuse_mut", v.obj({}), refuse, mutating=True))
        reg(Command("refuse_read", v.obj({}), refuse))
        reg(Command("many", v.obj({"a": v.integer(), "b": v.integer(), "c": v.integer(),
                                   "d": v.integer(), "e": v.integer()}), mutate, mutating=True))
        reg(Command("longname_" + "x" * 50, v.obj({"a": v.integer()}), mutate, mutating=True))


class StatusMessageTests(unittest.TestCase):
    def setUp(self):
        self.h = StatusHarness(tracks=3)
        self.messages = self.h.cinstance.messages

    def test_success_line_for_mutating_command(self):
        response = self.h.run("song_set", {"tempo": 101.0})
        self.assertTrue(response["ok"])
        self.assertEqual(self.messages, ["BatutaMCP: song_set tempo=101"])

    def test_floats_are_rounded(self):
        self.h.run("song_set", {"tempo": 120.456789})
        self.assertEqual(self.messages, ["BatutaMCP: song_set tempo=120.46"])

    def test_track_slot_scene_device_refs(self):
        self.h.run("mixer_set", {"track": {"kind": "return", "index": 1}, "volume_db": -6})
        self.h.run("mixer_set", {"track": {"kind": "master"}, "volume_db": -3.5})
        self.h.run("mixer_set", {"track": {"kind": "track", "index": 2}})
        self.h.run("clip_create", {"clip": {"kind": "session", "track": {"kind": "track", "index": 0},
                                            "slot": 4}, "length": 4})
        self.h.run("scene_fire", {"scene": 3})
        self.h.run("device_set", {"track_index": 1, "device_index": 2, "value": 0.5})
        self.assertEqual(self.messages, [
            "BatutaMCP: mixer_set return B volume_db=-6",
            "BatutaMCP: mixer_set master volume_db=-3.5",
            "BatutaMCP: mixer_set track 3",
            "BatutaMCP: clip_create track 1 slot 5 length=4",
            "BatutaMCP: scene_fire scene 4",
            "BatutaMCP: device_set track 2 device 3 value=0.5",
        ])

    def test_booleans_and_enum_keywords(self):
        self.h.run("song_set", {"metronome": True})
        self.h.run("view_show", {"view": "arrangement"})
        self.assertEqual(self.messages, ["BatutaMCP: song_set metronome=true",
                                         "BatutaMCP: view_show view=arrangement"])

    def test_at_most_three_pairs(self):
        self.h.run("many", {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5})
        self.assertEqual(self.messages, ["BatutaMCP: many a=1 b=2 c=3"])

    def test_free_text_never_appears(self):
        secret = "Secret Vocal /Users/me/take.wav file:///x ableton:query"
        self.h.run("mixer_set", {"track": {"kind": "track", "index": 0, "expect_name": secret},
                                 "name": secret, "volume_db": -1})
        self.h.run("clip_create", {"clip": {"kind": "session", "track": {"kind": "track", "index": 1,
                                            "expect_name": secret}, "slot": 0}, "path": secret})
        self.h.run("view_show", {"view": "session", "note": secret})
        for line in self.messages:
            for word in ("Secret", "Vocal", "Users", "take", "wav", "file:", "ableton", "/"):
                self.assertNotIn(word, line)
        self.assertEqual(len(self.messages), 3)

    def test_read_only_commands_are_silent(self):
        self.h.run("count")
        self.h.run("echo", {"v": 1})
        self.h.run("track_get_t", {"track": {"kind": "track", "index": 0}})
        self.h.run("catalog")
        self.h.run("refuse_read")
        self.assertEqual(self.messages, [])

    def test_refused_mutating_command_shows_error_code(self):
        response = self.h.run("refuse_mut")
        self.assertFalse(response["ok"])
        self.assertEqual(self.messages, ["BatutaMCP: refuse_mut refused (not_found)"])

    def test_partial_failure_of_mutating_command_shows_code(self):
        self.h.run("boom")
        self.assertEqual(len(self.messages), 1)
        self.assertTrue(self.messages[0].startswith("BatutaMCP: boom refused ("))

    def test_expired_mutating_job_shows_refusal_not_success(self):
        self.h.run("mutate", deadline=self.h.clock() - 1)
        self.assertEqual(self.messages, ["BatutaMCP: mutate refused (timeout)"])

    def test_batch_shows_one_line(self):
        ops = [{"cmd": "song_set", "args": {"tempo": 90}}, {"cmd": "scene_fire", "args": {"scene": 1}}]
        response = self.h.run("batch", {"ops": ops})
        self.assertTrue(response["ok"], response)
        self.assertEqual(self.messages, ["BatutaMCP: batch (2 ops)"])

    def test_read_only_batch_is_silent(self):
        self.h.run("batch", {"ops": [{"cmd": "count", "args": {}}]})
        self.assertEqual(self.messages, [])

    def test_batch_refused_shows_code(self):
        ops = [{"cmd": "song_set", "args": {"tempo": 90}}]
        response = self.h.run("batch", {"ops": ops}, deadline=self.h.clock() - 1)
        self.assertFalse(response["ok"])
        self.assertEqual(self.messages, ["BatutaMCP: batch refused (timeout)"])

    def test_ascii_and_length_cap(self):
        self.h.run("longname_" + "x" * 50, {"a": 1})
        line = self.messages[0]
        self.assertLessEqual(len(line), 120)
        line.encode("ascii")
        self.assertNotIn("  ", line)

    def test_show_message_failure_is_isolated(self):
        self.h.cinstance.message_error = RuntimeError("status bar gone")
        ok = self.h.run("song_set", {"tempo": 100})
        self.assertTrue(ok["ok"])
        bad = self.h.run("refuse_mut")
        self.assertEqual(bad["error"]["code"], "not_found")
        self.h.run("song_set", {"tempo": 101})
        failures = [m for m in self.h.cinstance.logs if "status message" in m]
        self.assertEqual(len(failures), 1)  # logged once, no traceback
        self.assertNotIn("Traceback", failures[0])
        self.assertEqual(self.h.song.events.count("begin"), self.h.song.events.count("end"))

    def test_shown_after_end_undo_step(self):
        self.h.cinstance.message_hook = lambda text: self.h.song.events.append("message")
        self.h.run("mutate")
        self.assertEqual(self.h.song.events, ["begin", "handler", "end", "message"])

    def test_message_is_not_a_mutation(self):
        response = self.h.run("mutate")
        self.assertEqual(response, {"id": 1, "ok": True, "result": {}})
        self.assertEqual(self.h.song.events.count("begin"), 1)


if __name__ == "__main__":
    unittest.main()
