"""T4b review round 1, M-2 (A23): a load that has not landed yet is swept from update_display for up to
20 ticks, on the target track and on any track the load created; outcomes reach the server through
the next browser_load response (`previous_sweep`). Tracks created by a synchronous load are walked."""

import queue
import unittest

from remote_script.BatutaMCP.dispatcher import MainThreadPump

from .browser_world import BrowserCase
from .device_world import T1
from .fake_browser import CORE, FakeItem, devices_loader
from .fake_devices import FakeDevice, attach, external_device, max_device, plugin_device, rack_hiding


def new_track_hook(*makers):
    """A load that makes Live create a new MIDI track and put the devices there."""
    def hook(browser, track):
        song = browser._song
        index = song.tracks.index(track) + 1       # Live puts the new track next to the target
        song.create_midi_track(index)
        created = song.tracks[index]
        for make in makers:
            device = make()
            attach(song, device)
            created.devices.append(device)
    return hook


class SweepCase(BrowserCase):
    def put(self, name, **kwargs):
        self.browser.set_category("sounds", FakeItem(name, CORE + name, loadable=True, **kwargs))
        return self.listed_uri("sounds", name)

    def pump(self, live=True):
        return MainThreadPump(queue.Queue(), self.h.dispatcher, lambda cid, frame: None,
                              lambda cid: live, clock=self.h.clock)

    def land(self, pump, ticks=1):
        for _ in range(ticks):
            self.browser.advance()
            pump.drain()

    def names(self, index=1):
        return [d.name for d in self.h.song.tracks[index].devices]


class SyncResultTests(SweepCase):
    def test_result_reports_verification_state(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        result = self.load(uri, T1)["result"]
        self.assertEqual((result["verified"], result["sweep_pending"], result["previous_sweep"]),
                         (True, False, None))
        self.assertEqual(result["device_count"], 2)
        self.assertEqual(self.h.state.sweeps, [])


class NewTrackTests(SweepCase):
    def test_a_clean_new_track_is_fine(self):
        uri = self.put("Fresh.adg", on_load=new_track_hook(lambda: FakeDevice("Operator", "UltraAnalog", 1)))
        result = self.load(uri, T1)["result"]
        self.assertEqual((result["verified"], result["sweep_pending"]), (True, False))
        self.assertEqual(len(self.h.song.tracks), 4)
        self.assertEqual(self.names(2), ["Operator"])

    def test_blocked_devices_on_a_track_the_load_created_are_removed(self):
        for make in (max_device, external_device, lambda: plugin_device()):
            uri = self.put("Fresh.adg", on_load=new_track_hook(lambda: FakeDevice("Operator", "UltraAnalog", 1),
                                                                make))
            error = self.load(uri, T1)["error"]
            self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "blocked_content"))
            self.assertEqual(self.names(2), ["Operator"])
            self.h.song.tracks.pop(2)
            self.assertIs(self.selected(), self.h.song.tracks[0])

    def test_allowed_plugins_on_a_new_track_stay(self):
        self.h.flags = {"allow_plugins": True}
        uri = self.put("Fresh.adg", on_load=new_track_hook(plugin_device))
        self.assertTrue(self.load(uri, T1)["ok"])
        self.assertEqual(self.names(2), ["Serum"])


class AsyncSweepTests(SweepCase):
    def late(self, make, name="Late.adg", ticks=1, **extra):
        return self.put(name, loader=devices_loader(make), deferred=ticks, **extra)

    def test_an_unlanded_load_answers_ok_unverified_and_registers_a_sweep(self):
        uri = self.late(max_device)
        result = self.load(uri, T1)["result"]
        self.assertEqual((result["verified"], result["sweep_pending"]), (False, True))
        self.assertEqual(self.names(), ["Compressor"])
        self.assertEqual(len(self.h.state.sweeps), 1)
        self.assertIs(self.selected(), self.h.song.tracks[0])

    def test_the_sweep_removes_a_late_max_device_in_its_own_undo_step(self):
        uri = self.late(lambda: rack_hiding(max_device(), "chain"))
        self.load(uri, T1)
        pump = self.pump()
        self.h.reset_log()
        self.land(pump)
        self.assertEqual(self.names(), ["Compressor", "Hiding Rack"])
        self.assertEqual(self.h.song.tracks[1].devices[1].chains[0].devices, [])
        self.assertEqual(self.h.song.events, ["begin", "end"])
        self.assertEqual(self.h.state.sweeps, [])
        lines = [line for line in self.h.cinstance.logs if "sweep" in line]
        self.assertEqual(len(lines), 1)

    def test_the_outcome_arrives_with_the_next_browser_load_once(self):
        self.load(self.late(max_device), T1)
        self.land(self.pump())
        uri = self.listed_uri("audio_effects", "Compressor")
        first = self.load(uri, T1)["result"]
        self.assertEqual(first["previous_sweep"]["state"], "swept")
        self.assertEqual(first["previous_sweep"]["removed"], ["max_for_live"])
        self.assertIs(first["previous_sweep"]["verified"], True)
        self.assertIsNone(self.load(uri, T1)["result"]["previous_sweep"])

    def test_a_clean_late_load_is_left_alone(self):
        self.load(self.late(lambda: FakeDevice("Operator", "UltraAnalog", 1)), T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor", "Operator"])
        self.assertEqual(self.h.state.sweeps, [])
        uri = self.listed_uri("audio_effects", "Compressor")
        self.assertEqual(self.load(uri, T1)["result"]["previous_sweep"]["state"], "clean")

    def test_a_late_load_that_creates_a_track_is_walked(self):
        uri = self.put("Late.adg", on_load=new_track_hook(max_device, external_device), deferred=2)
        self.assertTrue(self.load(uri, T1)["result"]["sweep_pending"])
        pump = self.pump()
        self.land(pump)
        self.assertEqual(len(self.h.song.tracks), 3)
        self.land(pump)
        self.assertEqual(len(self.h.song.tracks), 4)
        self.assertEqual(self.names(2), [])
        self.assertEqual(self.h.state.sweeps, [])

    def test_the_sweep_times_out_cleanly_after_20_ticks(self):
        self.load(self.late(max_device, ticks=999), T1)
        pump = self.pump()
        self.h.reset_log()
        for _ in range(19):
            pump.drain()
        self.assertEqual(len(self.h.state.sweeps), 1)
        pump.drain()
        self.assertEqual(self.h.state.sweeps, [])
        self.assertEqual(self.h.song.events, [])
        lines = [line for line in self.h.cinstance.logs if "sweep" in line]
        self.assertEqual(len(lines), 1)
        self.assertIn("timeout", lines[0])
        for _ in range(5):
            pump.drain()
        self.assertEqual(len([line for line in self.h.cinstance.logs if "sweep" in line]), 1)
        uri = self.listed_uri("audio_effects", "Compressor")
        previous = self.load(uri, T1)["result"]["previous_sweep"]
        self.assertEqual((previous["state"], previous["verified"]), ("timeout", False))

    def test_pre_existing_devices_are_never_deleted_by_a_sweep(self):
        old = max_device("Old Max")
        self.h.song.tracks[1].devices.append(old)
        attach(self.h.song, old)
        self.load(self.late(lambda: FakeDevice("Operator", "UltraAnalog", 1)), T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor", "Old Max", "Operator"])

    def test_allow_plugins_is_the_value_of_the_load_that_started_the_sweep(self):
        self.h.flags = {"allow_plugins": True}
        self.load(self.late(plugin_device), T1)
        self.h.flags = {}
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor", "Serum"])
        self.h.flags = {}
        self.load(self.late(plugin_device, name="Late2.adg"), T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor", "Serum"])

    def test_a_client_that_disconnected_does_not_stop_the_sweep(self):
        self.load(self.late(max_device), T1)
        pump = self.pump(live=False)
        self.land(pump)
        self.assertEqual(self.names(), ["Compressor"])

    def test_script_disconnect_cancels_sweeps_without_error(self):
        self.load(self.late(max_device), T1)
        pump = self.pump()
        pump.discard_pending()
        self.assertEqual(self.h.state.sweeps, [])
        self.land(pump, 3)
        self.assertEqual(self.names(), ["Compressor", "Loop Tool"])    # nothing sweeps any more

    def test_a_deleted_target_track_ends_the_sweep(self):
        self.load(self.late(max_device), T1)
        self.h.song.tracks.pop(1)
        self.pump().drain()
        self.assertEqual(self.h.state.sweeps, [])
        self.assertEqual(self.h.state.recent_sweeps()[0]["state"], "track_gone")

    def test_a_failing_sweep_is_contained_and_reported(self):
        self.load(self.late(max_device), T1)
        self.browser.advance()

        def broken(index):
            raise RuntimeError("cannot delete")
        self.h.song.tracks[1].delete_device = broken
        self.pump().drain()
        self.assertEqual(self.h.state.recent_sweeps()[0]["state"], "error")
        self.assertEqual(self.h.song.events[-2:], ["begin", "end"])

    def test_the_outcome_survives_a_reconnect(self):
        self.load(self.late(max_device), T1)
        self.land(self.pump())
        self.h.state.bind_connection(2)
        uri = self.listed_uri("audio_effects", "Compressor")   # the next job re-binds connection 1
        self.assertEqual(self.load(uri, T1)["result"]["previous_sweep"]["state"], "swept")
        self.assertEqual(self.h.state.recent_sweeps()[0]["state"], "swept")


if __name__ == "__main__":
    unittest.main()
