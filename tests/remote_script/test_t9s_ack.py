"""T9s: the external-input acknowledgement is bound to the exact tracks the owner was shown.

The refusal names the external-live tracks (`tracks`) and their stable ids (`track_ids`: "t<i>" tracks,
"r<i>" returns, "m" master). The server sends the same ids back as `external_input_ack: {tracks: [...]}`; the
script accepts the ack only while every external-live track is in that set. Inserting or loading an External
device while a recording is possible goes through the same ask."""

import unittest

from .browser_world import BrowserCase
from .clip_world import ClipCase
from .device_world import C, DeviceCase, RACK, T0, T1, world
from .fake_devices import external_device

EXT = {"allow_external_devices": True}


def ack(*ids):
    return {"external_input_ack": list(ids)}


class BoundAckTests(ClipCase):
    """Track 1 is audio on Ext. In, armed by hand: it is the one external-live track ("t1")."""

    def refusal(self, name, args):
        error = self.h.error(name, args)
        self.assertEqual(error["code"], "not_supported", error)
        return error["details"]

    def test_the_refusal_carries_the_stable_ids(self):
        self.external_live()
        details = self.refusal("song_set", {"record_mode": True})
        self.assertEqual(details["track_ids"], ["t1"])
        self.assertEqual(details["tracks"], [self.h.song.tracks[1].name])

    def test_only_the_acknowledged_set_passes(self):
        self.external_live()
        for flags in (ack(), ack("t0"), {"external_input_ack": True}, {"external_input_ack": "t1"}):
            self.h.flags = flags
            details = self.refusal("song_set", {"record_mode": True})
            self.assertIs(details["acknowledgeable"], True, flags)
        self.assertFalse(self.h.song.record_mode)
        self.h.flags = ack("t1")
        self.h.ok("song_set", {"record_mode": True})
        self.assertTrue(self.h.song.record_mode)

    def test_a_superset_of_the_current_tracks_passes(self):
        self.external_live()
        self.h.flags = ack("t0", "t1", "r0")
        self.h.ok("song_set", {"record_mode": True})

    def test_a_new_external_live_track_after_the_ack_asks_again_with_the_new_list(self):
        self.external_live()
        self.h.song.tracks[2].devices.append(external_device())
        self.h.flags = ack("t1")
        details = self.refusal("song_set", {"record_mode": True})
        self.assertIs(details["acknowledgeable"], True)
        self.assertEqual(details["track_ids"], ["t1", "t2"])
        self.assertEqual(len(details["tracks"]), 2)
        self.assertFalse(self.h.song.record_mode)
        self.h.flags = ack("t1", "t2")
        self.h.ok("song_set", {"record_mode": True})

    def test_the_track_being_armed_is_part_of_the_acknowledged_set(self):
        track = self.h.song.tracks[1]
        self.h.flags = ack("t0")
        details = self.refusal("track_set", {"track": T1, "arm": True})
        self.assertEqual(details["track_ids"], ["t1"])
        self.assertFalse(track._arm)
        self.h.flags = ack("t1")
        self.h.ok("track_set", {"track": T1, "arm": True})

    def test_duplicate_names_cannot_confuse_the_binding(self):
        self.external_live()
        self.h.song.tracks[2].name = self.h.song.tracks[1].name
        self.h.song.tracks[2].devices.append(external_device())
        self.h.flags = ack("t1")
        details = self.refusal("song_set", {"record_mode": True})
        self.assertEqual(details["track_ids"], ["t1", "t2"])

    def test_a_batch_with_an_ack_is_refused_up_front_when_the_set_changed(self):
        self.external_live()
        self.h.song.tracks[2].devices.append(external_device())
        self.h.flags = ack("t1")
        ops = [{"cmd": "song_set", "args": {"tempo": 100}}, {"cmd": "song_set", "args": {"record_mode": True}}]
        response = self.h.run("batch", {"ops": ops})
        self.assertFalse(response["ok"])
        self.assertIs(response["error"]["details"]["acknowledgeable"], True)
        self.assertEqual(self.h.song.log, [])


class SongInfoListsExternalTracksTests(ClipCase):
    """The ears flow names the tracks from the script's own rule, read through song_info."""

    def test_empty_when_nothing_is_external(self):
        self.assertEqual(self.h.ok("song_info")["external_live_tracks"], [])

    def test_lists_input_and_device_cases_with_ids(self):
        self.external_live()
        self.h.song.return_tracks[0].devices.append(external_device())
        listed = self.h.ok("song_info")["external_live_tracks"]
        self.assertEqual([item["id"] for item in listed], ["t1", "r0"])
        self.assertEqual(listed[0]["name"], self.h.song.tracks[1].name)


class BatchMidRunTests(DeviceCase):
    flags = EXT

    def setUp(self):
        super().setUp()
        self.h.song.tracks[1]._arm = True   # audio track 1 on Ext. In: "t1"
        self.h.reset_log()

    def insert(self, track, name="External Audio Effect"):
        return {"cmd": "device_insert", "args": {"container": C(track), "name": name}}

    def test_an_op_that_makes_a_new_track_external_is_caught_by_the_next_record_op(self):
        self.h.flags = dict(EXT, **ack("t1"))
        ops = [self.insert(T0), {"cmd": "song_set", "args": {"record_mode": True}}]
        response = self.h.run("batch", {"ops": ops})
        self.assertTrue(response["ok"], response)
        first, second = response["result"]["results"]
        self.assertTrue(first["ok"])
        self.assertFalse(second["ok"])
        details = second["error"]["details"]
        self.assertNotIn("acknowledgeable", details, "a half-run batch is never re-sent as a whole")
        self.assertEqual(details["ops_run"], 1)
        self.assertEqual(details["track_ids"], ["t0", "t1"])
        self.assertTrue(response["result"]["partial"])
        self.assertFalse(self.h.song.record_mode)

    def test_a_batch_that_turns_recording_on_then_inserts_an_external_device_stops_at_the_insert(self):
        self.h.flags = dict(EXT, **ack("t1"))
        ops = [{"cmd": "song_set", "args": {"record_mode": True}}, self.insert(T0)]
        response = self.h.run("batch", {"ops": ops})
        results = response["result"]["results"]
        self.assertTrue(results[0]["ok"])
        self.assertFalse(results[1]["ok"])
        self.assertEqual(results[1]["error"]["details"]["ops_run"], 1)
        self.assertEqual([d.name for d in self.h.song.tracks[0].devices].count("External Audio Effect"), 0)


class InsertWhileRecordingTests(DeviceCase):
    flags = EXT

    def refusal(self, args):
        error = self.h.error("device_insert", args)
        self.assertEqual(error["code"], "not_supported", error)
        return error["details"]

    def count(self, track=0):
        return len(self.h.song.tracks[track].devices)

    def test_without_a_recording_the_insert_needs_no_ask(self):
        self.h.ok("device_insert", {"container": C(T0), "name": "External Audio Effect"})

    def test_record_mode_session_record_or_a_recording_slot_ask_first(self):
        for setup in (lambda s: setattr(s, "record_mode", True), lambda s: setattr(s, "session_record", True),
                      lambda s: setattr(s.tracks[0].clip_slots[0], "is_recording", True)):
            self.h = world(EXT)
            setup(self.h.song)
            before = self.count()
            details = self.refusal({"container": C(T0), "name": "External Instrument"})
            self.assertIs(details["acknowledgeable"], True)
            self.assertEqual(details["reason"], "external_input_live")
            self.assertEqual(details["track_ids"], ["t0"])
            self.assertEqual(details["tracks"], [self.h.song.tracks[0].name])
            self.assertEqual(self.count(), before)

    def test_the_ack_for_that_track_lets_it_in_and_another_ack_does_not(self):
        self.h.song.record_mode = True
        self.h.flags = dict(EXT, **ack("t1"))
        self.assertIs(self.refusal({"container": C(T0), "name": "External Audio Effect"})["acknowledgeable"], True)
        self.h.flags = dict(EXT, **ack("t0"))
        self.h.ok("device_insert", {"container": C(T0), "name": "External Audio Effect"})
        self.assertIn("External Audio Effect", [d.name for d in self.h.song.tracks[0].devices])

    def test_inside_a_rack_chain_it_asks_too(self):
        self.h.song.record_mode = True
        details = self.refusal({"container": C(T0, RACK, {"chain": 1}), "name": "External Audio Effect"})
        self.assertEqual(details["track_ids"], ["t0"])

    def test_an_ordinary_device_never_asks(self):
        self.h.song.record_mode = True
        self.h.ok("device_insert", {"container": C(T0), "name": "Reverb"})

    def test_a_batch_asks_up_front(self):
        self.h.song.record_mode = True
        self.h.reset_log()
        ops = [{"cmd": "song_set", "args": {"tempo": 100}},
               {"cmd": "device_insert", "args": {"container": C(T0), "name": "External Audio Effect"}}]
        response = self.h.run("batch", {"ops": ops})
        self.assertFalse(response["ok"])
        self.assertIs(response["error"]["details"]["acknowledgeable"], True)
        self.assertEqual(self.h.song.log, [])

    def test_an_ears_track_in_the_set_counts_as_a_recording(self):
        self.h.arm_ears()
        self.h.reset_log()
        details = self.refusal({"container": C(T0), "name": "External Audio Effect"})
        self.assertIs(details["acknowledgeable"], True)


class LoadWhileRecordingTests(BrowserCase):
    flags = EXT

    def setUp(self):
        super().setUp()
        self.h.flags = dict(EXT)

    def test_loading_an_external_device_while_recording_asks_first(self):
        uri = self.listed_uri("instruments", "External Instrument", flags=EXT)
        self.h.song.record_mode = True
        response = self.load(uri, T1)
        self.assertFalse(response["ok"])
        details = response["error"]["details"]
        self.assertIs(details["acknowledgeable"], True)
        self.assertEqual(details["track_ids"], ["t1"])
        self.assertEqual([d.name for d in self.h.song.tracks[1].devices], ["Compressor"])
        self.h.flags = dict(EXT, **ack("t1"))
        self.assertTrue(self.load(uri, T1)["ok"])

    def test_without_a_recording_it_loads_as_before(self):
        uri = self.listed_uri("instruments", "External Instrument", flags=EXT)
        self.assertTrue(self.load(uri, T1)["ok"])

    def test_an_unannounced_external_class_is_removed_while_recording(self):
        uri = self.listed_uri("instruments", "Mystery Synth", flags=EXT)
        self.h.song.record_mode = True
        response = self.load(uri, T1)
        self.assertEqual(response["error"]["details"]["removed"], ["external_device"])


if __name__ == "__main__":
    unittest.main()
