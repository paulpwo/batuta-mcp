"""T4b review round 2: the sweep finishes only when something NEW appears, touches only what a load
would have added (insertion point, one adjacent new track), ignores what the user or the script itself
created in the window, keeps a bounded outcome history, and is capped (1 per track, 4 in all)."""

import queue
import unittest

from remote_script.BatutaMCP.dispatcher import Job, MainThreadPump
from remote_script.BatutaMCP.state import ScriptState

from .device_world import T0, T1, T2, C
from .fake_browser import devices_loader
from .fake_devices import FakeChain, FakeDevice, FakeRack, attach, max_device, plugin_device
from .test_t4b_review_sweep import SweepCase, new_track_hook


class NarrowCase(SweepCase):
    def setUp(self):
        super().setUp()
        self.posted = []

    def jobs_pump(self):
        self.inbound = queue.Queue(maxsize=64)
        return MainThreadPump(self.inbound, self.h.dispatcher, lambda cid, frame: self.posted.append(frame),
                              lambda cid: True, clock=self.h.clock)

    def submit(self, pump, name, args):
        command, normalized = self.h.registry.prepare_call(name, args)
        self.inbound.put(Job(1, len(self.posted) + 100, command, normalized, self.h.clock() + 5,
                             dict(self.h.flags)))
        pump.drain()
        return self.posted[-1]

    def late(self, make, name="Late.adg", ticks=1, **extra):
        return self.put(name, loader=devices_loader(make), deferred=ticks, **extra)

    def last(self):
        return self.h.state.recent_sweeps()[0]


class FinishRuleTests(NarrowCase):
    def test_a_device_removed_by_hand_does_not_end_the_sweep(self):
        self.load(self.late(max_device), T1)
        pump = self.pump()
        self.h.song.tracks[1].devices.pop(0)             # the user deletes the Compressor
        pump.drain()
        self.assertEqual(len(self.h.state.sweeps), 1)
        self.assertEqual(self.h.state.recent_sweeps(), [])
        self.land(pump)                                  # the late Max device lands afterwards
        self.assertEqual(self.names(), [])
        self.assertEqual((self.last()["state"], self.last()["removed"]), ("swept", ["max_for_live"]))

    def test_removal_followed_by_silence_times_out_unverified(self):
        self.load(self.late(max_device, ticks=999), T1)
        pump = self.pump()
        self.h.song.tracks[1].devices.pop(0)
        for _ in range(20):
            pump.drain()
        self.assertEqual(self.h.state.sweeps, [])
        self.assertEqual((self.last()["state"], self.last()["verified"]), ("timeout", False))

    def test_a_timeout_and_a_vanished_track_are_never_verified(self):
        self.load(self.late(max_device, ticks=999), T1)
        pump = self.pump()
        for _ in range(20):
            pump.drain()
        self.assertIs(self.last()["verified"], False)
        self.load(self.late(max_device, ticks=999, name="L2.adg"), T1)
        self.h.song.tracks.pop(1)
        pump.drain()
        self.assertEqual((self.last()["state"], self.last()["verified"]), ("track_gone", False))


class InsertionPointTests(NarrowCase):
    def test_a_device_the_user_adds_mid_chain_is_left_alone(self):
        self.load(self.late(max_device, ticks=2), T1)
        pump = self.pump()
        hand = max_device("Hand Max")
        attach(self.h.song, hand)
        self.h.song.tracks[1].devices.insert(0, hand)    # before the Compressor: not the insertion point
        self.land(pump)
        self.assertEqual(self.names(), ["Hand Max", "Compressor"])
        self.assertEqual(len(self.h.state.sweeps), 1)
        self.land(pump)                                  # now the late load appends at the end
        self.assertEqual(self.names(), ["Hand Max", "Compressor"])
        self.assertEqual(self.last()["state"], "swept")

    def test_a_device_the_user_adds_inside_an_existing_rack_is_left_alone(self):
        self.load(self.late(max_device, ticks=2), T0)
        pump = self.pump()
        hand = max_device("Hand Max")
        attach(self.h.song, hand)
        self.h.song.tracks[0].devices[1].chains[1].devices.append(hand)
        self.land(pump)
        self.assertEqual([d.name for d in self.h.song.tracks[0].devices[1].chains[1].devices], ["Hand Max"])
        self.assertEqual(len(self.h.state.sweeps), 1)

    def test_an_instrument_replacing_the_instrument_slot_is_eligible(self):
        def swap(browser, track):
            new = FakeDevice("New Inst", "MxDeviceInstrument", 1)
            attach(browser._song, new)
            track.devices[0] = new
        uri = self.put("Inst.adg", on_load=swap, deferred=1)
        self.load(uri, T0)
        self.land(self.pump())
        self.assertEqual(self.names(0), ["FX Rack", "Utility"])
        self.assertEqual(self.last()["removed"], ["max_for_live"])

    def test_an_instrument_class_device_in_the_middle_is_not_the_loads(self):
        self.load(self.late(max_device, ticks=3), T0)
        pump = self.pump()
        hand = FakeDevice("Hand Inst", "MxDeviceInstrument", 1)
        attach(self.h.song, hand)
        self.h.song.tracks[0].devices.insert(2, hand)    # between the rack and the Utility
        self.land(pump)
        self.assertEqual(self.names(0), ["Operator", "FX Rack", "Hand Inst", "Utility"])

    def test_a_hand_added_device_and_the_late_load_in_the_same_tick(self):
        self.load(self.late(max_device), T1)
        hand = max_device("Hand Max")
        attach(self.h.song, hand)
        self.h.song.tracks[1].devices.insert(0, hand)
        self.land(self.pump())                           # the load lands now, both are new
        self.assertEqual(self.names(), ["Hand Max", "Compressor"])
        self.assertEqual(self.last()["state"], "swept")

    def test_the_same_tick_case_with_an_unverifiable_late_device(self):
        def huge():
            return FakeRack("Huge", [FakeChain("c%d" % i, [FakeDevice("d%d_%d" % (i, j), "Generic")
                                                           for j in range(60)]) for i in range(9)])
        self.load(self.late(huge), T1)
        hand = FakeDevice("Hand Device", "Generic")
        attach(self.h.song, hand)
        self.h.song.tracks[1].devices.insert(0, hand)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Hand Device", "Compressor"])
        self.assertIs(self.last()["verified"], False)

    def test_a_tree_that_outgrows_the_walk_without_a_new_device_ends_the_sweep_unverified(self):
        self.load(self.late(max_device, ticks=999), T0)
        chain = self.h.song.tracks[0].devices[1].chains[1]
        for i in range(600):
            device = FakeDevice("bulk%d" % i, "Generic")
            attach(self.h.song, device)
            chain.devices.append(device)
        self.pump().drain()
        self.assertEqual(self.h.state.sweeps, [])
        self.assertEqual((self.last()["state"], self.last()["verified"]), ("error", False))

    def test_an_instrument_loaded_first_on_a_track_without_one_is_eligible(self):
        def first(browser, track):
            new = FakeDevice("New Inst", "MxDeviceInstrument", 1)
            attach(browser._song, new)
            track.devices.insert(0, new)
        self.load(self.put("Inst.adg", on_load=first, deferred=1), T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor"])

    def test_a_huge_late_device_is_deleted_unverified(self):
        def huge():
            return FakeRack("Huge", [FakeChain("c%d" % i, [FakeDevice("d%d_%d" % (i, j), "Generic")
                                                           for j in range(60)]) for i in range(9)])
        self.load(self.late(huge), T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor"])
        self.assertEqual((self.last()["state"], self.last()["verified"]), ("swept", False))


class NewTrackRuleTests(NarrowCase):
    def hand_track(self, index, *devices):
        song = self.h.song
        song.create_midi_track(index)
        track = song.tracks[index]
        for device in devices:
            attach(song, device)
            track.devices.append(device)
        return track

    def test_a_track_the_user_creates_elsewhere_keeps_its_plugin(self):
        self.load(self.late(max_device, ticks=3), T1)
        pump = self.pump()
        mine = self.hand_track(len(self.h.song.tracks), plugin_device("Hand Plugin"))   # at the end
        self.land(pump)
        self.assertEqual([d.name for d in mine.devices], ["Hand Plugin"])
        self.assertEqual(len(self.h.state.sweeps), 1)
        self.land(pump, 2)
        self.assertEqual(self.names(), ["Compressor"])
        self.assertEqual([d.name for d in mine.devices], ["Hand Plugin"])

    def test_two_new_tracks_are_never_counted_as_live_created(self):
        self.load(self.late(max_device, ticks=2), T1)
        pump = self.pump()
        a = self.hand_track(2, plugin_device("A"))
        b = self.hand_track(2, plugin_device("B"))
        self.land(pump)
        self.assertEqual([[d.name for d in t.devices] for t in (a, b)], [["A"], ["B"]])

    def test_exactly_one_adjacent_new_track_is_the_loads(self):
        uri = self.put("Late.adg", on_load=new_track_hook(max_device), deferred=1)
        self.load(uri, T1)
        self.land(self.pump())
        self.assertEqual(self.names(2), [])
        self.assertEqual(self.last()["state"], "swept")


class OwnMutationTests(NarrowCase):
    def test_script_mutations_in_the_window_are_not_the_loads(self):
        plugin = plugin_device("Old Plugin")
        attach(self.h.song, plugin)
        self.h.song.tracks[1].devices.append(plugin)            # pre-existing on the target
        self.load(self.late(max_device, ticks=1), T1)
        pump = self.jobs_pump()
        self.assertTrue(self.submit(pump, "device_insert", {"container": C(T1), "name": "Reverb"})["ok"])
        self.assertTrue(self.submit(pump, "track_create", {"type": "midi", "index": 2})["ok"])
        mine = self.h.song.tracks[2]
        extra = plugin_device("Script Plugin")
        attach(self.h.song, extra)
        mine.devices.append(extra)
        self.assertTrue(self.submit(pump, "track_duplicate", {"track": T1})["ok"])
        copy = self.h.song.tracks[2]
        self.assertTrue(self.submit(pump, "batch", {"ops": [
            {"cmd": "device_insert", "args": {"container": C(T1), "name": "Utility"}}]})["ok"])
        pump.drain()                                     # a tick right after the batch must not end it
        self.assertEqual(len(self.h.state.sweeps), 1)
        self.browser.advance()
        pump.drain()
        self.assertEqual(self.names(), ["Compressor", "Old Plugin", "Reverb", "Utility"])
        self.assertIn("Old Plugin", [d.name for d in copy.devices])
        self.assertIn("Script Plugin", [d.name for d in mine.devices])
        self.assertEqual((self.last()["state"], self.last()["removed"]), ("swept", ["max_for_live"]))

    def test_a_later_browser_load_by_the_script_leaves_the_first_sweep_in_place(self):
        self.load(self.late(max_device, ticks=2), T1)
        uri = self.listed_uri("audio_effects", "Compressor")
        self.assertTrue(self.load(uri, T2)["ok"])
        pump = self.pump()
        self.land(pump, 2)
        self.assertEqual(self.names(), ["Compressor"])
        self.assertEqual(self.names(2), ["Kit", "Compressor"])


class HistoryTests(NarrowCase):
    def outcome(self, state, verified=True):
        return {"state": state, "removed": [], "verified": verified}

    def test_history_is_bounded_and_worst_first(self):
        state = ScriptState()
        for name in ("clean", "swept", "clean", "timeout", "clean", "error", "clean", "clean", "clean", "clean"):
            state.record_sweep(self.outcome(name))
        recent = state.recent_sweeps()
        self.assertEqual(len(recent), 8)
        self.assertEqual([r["state"] for r in recent[:3]], ["error", "timeout", "swept"])  # worst kept, newest first
        self.assertTrue(all(r["state"] == "clean" for r in recent[3:]))

    def test_history_survives_a_reconnect_and_is_delivered_once_worst_first(self):
        state = ScriptState()
        state.record_sweep(self.outcome("clean"))
        state.record_sweep(self.outcome("swept"))
        state.bind_connection(1)
        state.bind_connection(2)
        self.assertEqual(len(state.recent_sweeps()), 2)
        self.assertEqual(state.take_sweep()["state"], "swept")
        self.assertEqual(state.take_sweep()["state"], "clean")
        self.assertIsNone(state.take_sweep())
        self.assertEqual(len(state.recent_sweeps()), 2)          # delivery does not erase history

    def test_song_info_reports_pending_and_recent_sweeps(self):
        self.assertEqual(self.h.ok("song_info")["pending_sweeps"], 0)
        self.assertEqual(self.h.ok("song_info")["recent_sweeps"], [])
        self.load(self.late(max_device), T1)
        info = self.h.ok("song_info")
        self.assertEqual((info["pending_sweeps"], info["recent_sweeps"]), (1, []))
        self.land(self.pump())
        self.h.reset_log()
        info = self.h.ok("song_info")
        self.assertEqual((info["pending_sweeps"], [r["state"] for r in info["recent_sweeps"]]), (0, ["swept"]))
        self.assertEqual((self.h.song.events, self.h.song.log), ([], []))


class CapTests(NarrowCase):
    def setUp(self):
        super().setUp()
        for _ in range(2):
            self.h.ok("track_create", {"type": "midi"})
        self.n = 0

    def pending_load(self, track):
        self.n += 1
        uri = self.late(max_device, name="L%d.adg" % self.n, ticks=999)
        return self.load(uri, track)

    def tracks(self):
        return [{"kind": "track", "index": i} for i in range(5)]

    def test_one_sweep_per_track_and_four_in_all(self):
        tracks = self.tracks()
        for track in tracks[:4]:
            self.assertTrue(self.pending_load(track)["ok"])
        self.h.reset_log()
        loaded = len(self.browser.loaded)
        for track in (tracks[4], tracks[0]):
            error = self.pending_load(track)["error"]
            self.assertEqual((error["code"], error["details"]["reason"]), ("busy", "sweep_pending"))
        self.assertEqual((self.h.song.log, self.h.song.events), ([], []))
        self.assertEqual(len(self.browser.loaded), loaded)

    def test_the_same_track_is_refused_even_below_four(self):
        self.assertTrue(self.pending_load(T1)["ok"])
        self.assertEqual(self.pending_load(T1)["error"]["details"]["reason"], "sweep_pending")
        self.assertTrue(self.pending_load(T2)["ok"])

    def test_a_finished_sweep_frees_its_slot(self):
        self.assertTrue(self.pending_load(T1)["ok"])
        pump = self.pump()
        for _ in range(20):
            pump.drain()
        uri = self.listed_uri("audio_effects", "Compressor")
        self.assertTrue(self.load(uri, T1)["ok"])

    def test_the_batch_path_repeats_the_refusal(self):
        self.assertTrue(self.pending_load(T1)["ok"])
        uri = self.listed_uri("audio_effects", "Compressor")
        error = self.batch_error("browser_load", {"track": T1, "uri": uri})
        self.assertEqual((error["code"], error["details"]["reason"]), ("busy", "sweep_pending"))

    def test_sweep_ticks_count_against_the_drain_budget(self):
        clock = self.h.clock

        class Slow:
            track = None

            def step(self, song, log):
                clock.advance(0.025)
                return None
        self.h.state.sweeps.append(Slow())
        pump = self.jobs_pump()
        for number in range(3):
            command, normalized = self.h.registry.prepare_call("catalog", {})
            self.inbound.put(Job(1, number, command, normalized, clock() + 5, {}))
        self.assertEqual(pump.drain(), 1)
        self.assertEqual(self.inbound.qsize(), 2)


if __name__ == "__main__":
    unittest.main()
