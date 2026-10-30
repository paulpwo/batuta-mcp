"""T5c-4: browser_load onto return tracks and the master (docs/01-protocol.md section 7.10).

Live's load_item targets the selected track, so the script selects the target for the call and puts
the previous selection back on every path. Every 7.10 rule (allowlist, flags, pre-load filtering,
post-load recursive cleanup, deferred sweep) holds for these targets exactly as for regular tracks."""

import unittest

from .device_world import FLAGS_ALL, M, R0, T1, C
from .fake_browser import CORE, FakeItem, devices_loader
from .fake_devices import FakeDevice, FakeChain, FakeRack, attach, external_device, max_device, plugin_device, rack_hiding
from .test_cmds_browser_load import BrowserCase
from .test_t4b_review_sweep2 import NarrowCase

TARGETS = (("return", R0, lambda song: song.return_tracks[0], ["Reverb"]),
           ("master", M, lambda song: song.master_track, ["Master Utility"]))


def names_of(track):
    return [device.name for device in track.devices]


class LoadOntoReturnAndMasterTests(BrowserCase):
    def test_native_device_loads_onto_the_target_and_the_selection_is_restored(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        for label, ref, pick, before in TARGETS:
            self.h.reset_log()
            self.browser.loaded.clear()
            response = self.load(uri, ref)
            self.assertTrue(response["ok"], (label, response))
            self.assertEqual(response["result"], {"loaded": {"name": "Compressor", "uri": uri},
                                                  "device_count": 2, "verified": True,
                                                  "sweep_pending": False, "previous_sweep": None}, label)
            self.assertEqual(names_of(pick(self.h.song)), before + ["Compressor"], label)
            self.assertIs(self.selected(), self.h.song.tracks[0], label)
            self.assertEqual(self.browser.loaded, [uri], label)
            self.assertEqual(self.h.song.events, ["begin", "end"], label)

    def test_the_load_really_happens_on_the_selected_target(self):
        seen = []
        original = self.browser.load_item

        def spy(item):
            seen.append(self.selected())
            return original(item)
        self.browser.load_item = spy
        uri = self.listed_uri("audio_effects", "Compressor")
        self.load(uri, R0)
        self.load(uri, M)
        self.assertIs(seen[0], self.h.song.return_tracks[0])
        self.assertIs(seen[1], self.h.song.master_track)

    def test_a_previous_selection_on_a_return_or_master_comes_back(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        for previous in (self.h.song.return_tracks[0], self.h.song.master_track, self.h.song.tracks[2]):
            self.h.song.view.selected_track = previous
            self.assertTrue(self.load(uri, M if previous is not self.h.song.master_track else R0)["ok"])
            self.assertIs(self.selected(), previous)
            self.assertTrue(self.load(uri, T1)["ok"])
            self.assertIs(self.selected(), previous)

    def test_instruments_and_factory_presets_load_onto_a_return(self):
        self.assertTrue(self.load(self.listed_uri("sounds", "Warm Bass.adg", ["Bass"]), R0)["ok"])
        self.assertEqual(names_of(self.h.song.return_tracks[0]), ["Reverb", "Warm Bass"])

    def test_user_presets_and_plugins_still_need_their_flags_on_these_targets(self):
        preset = self.listed_uri("user_library", "Mine.adg", flags={"allow_user_presets": True})
        plugin = self.listed_uri("plugins", "Serum", flags={"allow_plugins": True})
        for label, ref, pick, before in TARGETS:
            self.h.flags = {"allow_user_presets": True, "allow_plugins": True}
            self.assertTrue(self.load(preset, ref)["ok"], label)
            self.assertTrue(self.load(plugin, ref)["ok"], label)
            self.h.flags = {}
            self.h.reset_log()
            for uri in (preset, plugin):
                response = self.load(uri, ref)
                self.assertEqual((response["error"]["code"], response["error"]["details"]["reason"]),
                                 ("not_supported", "blocked_content"), label)
            self.assertEqual(self.h.song.log, [], label)

    def test_the_load_does_not_touch_another_track(self):
        self.load(self.listed_uri("audio_effects", "Compressor"), M)
        self.assertEqual(names_of(self.h.song.tracks[1]), ["Compressor"])
        self.assertEqual(names_of(self.h.song.return_tracks[0]), ["Reverb"])


class RefusalTests(BrowserCase):
    def assertUntouched(self):
        self.assertEqual(self.h.song.log, [])
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.browser.loaded, [])

    def test_blocked_items_are_refused_before_anything_changes(self):
        for name, why in (("Evil.amxd", "max_for_live"), ("Song.als", "live_set")):
            uri = self.listed_uri("user_library", name, flags=FLAGS_ALL)
            for label, ref, pick, before in TARGETS:
                self.h.reset_log()
                error = self.load(uri, ref)["error"]
                self.assertEqual((error["code"], error["details"]["reason"], error["details"]["blocked"]),
                                 ("not_supported", "blocked_content", why), label)
                self.assertUntouched()
                self.assertEqual(names_of(pick(self.h.song)), before)

    def test_external_instruments_and_unlisted_uris_are_refused(self):
        uri = self.listed_uri("instruments", "External Instrument")
        for label, ref, pick, before in TARGETS:
            self.assertEqual(self.load(uri, ref)["error"]["details"]["blocked"], "external_device", label)
            self.assertEqual(self.load("query:Nothing#Listed", ref)["error"]["details"]["blocked"],
                             "unlisted_uri", label)
        self.assertUntouched()

    def test_guards_on_the_target_reference(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        error = self.load(uri, {"kind": "return", "index": 5})["error"]
        self.assertEqual(error["code"], "not_found")
        error = self.load(uri, {"kind": "return", "index": 0, "expect_name": "wrong"})["error"]
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_found", "name_mismatch"))
        error = self.load(uri, {"kind": "master", "expect_name": "wrong"})["error"]
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_found", "name_mismatch"))
        for bad in ({"kind": "master", "index": 0}, {"kind": "group", "index": 0}, {"kind": "return"}, {"name": "Reverb"}):
            self.assertEqual(self.load(uri, bad)["error"]["code"], "invalid_args", bad)
        self.assertUntouched()
        ok = self.load(uri, {"kind": "return", "index": 0, "expect_name": self.h.song.return_tracks[0].name})
        self.assertTrue(ok["ok"], ok)

    def test_batch_path_repeats_every_check_for_these_targets(self):
        evil = self.listed_uri("user_library", "Evil.amxd", flags=FLAGS_ALL)
        for label, ref, pick, before in TARGETS:
            self.h.reset_log()
            error = self.batch_error("browser_load", {"track": ref, "uri": evil})
            self.assertEqual(error["details"]["reason"], "blocked_content", label)
            self.assertEqual(self.h.song.log, [], label)
        uri = self.listed_uri("audio_effects", "Compressor")
        self.h.reset_log()
        result = self.h.ok("batch", {"ops": [{"cmd": "browser_load", "args": {"track": R0, "uri": uri}},
                                              {"cmd": "browser_load", "args": {"track": M, "uri": uri}}]})
        self.assertEqual([r["ok"] for r in result["results"]], [True, True])
        self.assertEqual(self.h.song.events, ["begin", "end"])
        self.assertIs(self.selected(), self.h.song.tracks[0])

    def test_a_tree_too_large_to_see_is_refused_before_loading(self):
        crowd = [FakeDevice("d%d" % i, "Generic") for i in range(500)]
        for device in crowd:
            attach(self.h.song, device)
        self.h.song.return_tracks[0].devices += [FakeRack("Big", [FakeChain("c%d" % i, [
            FakeDevice("x%d_%d" % (i, j), "Generic") for j in range(60)]) for i in range(9)])]
        for device in self.h.song.return_tracks[0].devices:
            attach(self.h.song, device)
        error = self.load(self.listed_uri("audio_effects", "Compressor"), R0)["error"]
        self.assertEqual(error["details"]["reason"], "tree_too_large")
        self.assertEqual(self.browser.loaded, [])


class CleanupTests(BrowserCase):
    def assertCleaned(self, response, label, pick, expect):
        self.assertFalse(response["ok"], (label, response))
        error = response["error"]
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "blocked_content"), label)
        self.assertIs(error["details"]["partial"], True)
        self.assertEqual(names_of(pick(self.h.song)), expect, label)
        self.assertIs(self.selected(), self.h.song.tracks[0], label)

    def test_new_max_plugin_and_external_devices_are_removed_again(self):
        for make, why in ((max_device, "max_for_live"), (external_device, "external_device"),
                          (plugin_device, "plugin")):
            self.browser.set_category("user_library", FakeItem("Odd.adv", "query:UserLibrary#Presets:Odd.adv",
                                                                loadable=True, loader=devices_loader(make)))
            uri = self.listed_uri("user_library", "Odd.adv", flags={"allow_user_presets": True})
            for label, ref, pick, before in TARGETS:
                response = self.load(uri, ref)
                self.assertCleaned(response, label, pick, before)
                self.assertEqual(response["error"]["details"]["removed"], [why], label)

    def test_nested_offenders_in_chains_return_chains_and_pads_are_removed(self):
        for where in ("chain", "return_chain", "drum_pad"):
            self.browser.set_category("sounds", FakeItem("Hide.adg", CORE + "Hide.adg", loadable=True,
                                                          loader=devices_loader(lambda: rack_hiding(max_device(), where))))
            uri = self.listed_uri("sounds", "Hide.adg")
            for label, ref, pick, before in TARGETS:
                self.assertCleaned(self.load(uri, ref), label, pick, before + ["Hiding " + {
                    "chain": "Rack", "return_chain": "Rack", "drum_pad": "Kit"}[where]])
                pick(self.h.song).devices.pop()

    def test_an_unverifiable_tree_is_removed_as_a_whole(self):
        def make():
            return FakeRack("Huge", [FakeChain("c%d" % i, [FakeDevice("d%d_%d" % (i, j), "Generic")
                                                           for j in range(60)]) for i in range(9)])
        self.browser.set_category("sounds", FakeItem("Huge.adg", CORE + "Huge.adg", loadable=True,
                                                      loader=devices_loader(make)))
        uri = self.listed_uri("sounds", "Huge.adg")
        for label, ref, pick, before in TARGETS:
            response = self.load(uri, ref)
            self.assertCleaned(response, label, pick, before)
            self.assertIs(response["error"]["details"]["verified"], False)

    def test_existing_offenders_on_the_target_are_left_alone(self):
        old = max_device("Old Max")
        attach(self.h.song, old)
        self.h.song.master_track.devices.append(old)
        self.assertTrue(self.load(self.listed_uri("audio_effects", "Compressor"), M)["ok"])
        self.assertEqual(names_of(self.h.song.master_track), ["Master Utility", "Old Max", "Compressor"])

    def test_a_track_created_by_the_load_is_cleaned_too(self):
        def hook(browser, track):
            song = browser._song
            song.create_midi_track(len(song.tracks))
            device = max_device()
            attach(song, device)
            song.tracks[-1].devices.append(device)
        self.browser.set_category("sounds", FakeItem("Spawn.adg", CORE + "Spawn.adg", loadable=True, on_load=hook))
        for label, ref, pick, before in TARGETS:
            response = self.load(self.listed_uri("sounds", "Spawn.adg"), ref)
            self.assertCleaned(response, label, pick, before)
            self.assertEqual(names_of(self.h.song.tracks[-1]), [], label)

    def test_the_selection_is_restored_when_the_load_itself_fails(self):
        def boom(track):
            raise RuntimeError("cannot load")
        self.browser.set_category("audio_effects", FakeItem("Broken", "query:AudioFx#Broken", loadable=True,
                                                             device=True, loader=boom))
        uri = self.listed_uri("audio_effects", "Broken")
        for label, ref, pick, before in TARGETS:
            response = self.load(uri, ref)
            self.assertEqual(response["error"]["code"], "lom_error", label)
            self.assertIs(response["error"]["details"]["partial"], True)
            self.assertIs(self.selected(), self.h.song.tracks[0], label)
            self.assertEqual(self.h.song.events[-2:], ["begin", "end"], label)


class DeferredSweepTests(NarrowCase):
    def test_an_unlanded_load_on_a_return_or_master_registers_a_sweep_that_cleans_it_later(self):
        for label, ref, pick, before in TARGETS:
            self.h.state.sweeps[:] = []
            result = self.load(self.late(max_device, name="Late%s.adg" % label), ref)["result"]
            self.assertEqual((result["verified"], result["sweep_pending"]), (False, True), label)
            self.assertEqual(len(self.h.state.sweeps), 1, label)
            pump = self.pump()
            self.land(pump)
            self.assertEqual(names_of(pick(self.h.song)), before, label)
            self.assertEqual(self.h.state.sweeps, [], label)
            outcome = self.last()
            self.assertEqual((outcome["state"], outcome["removed"], outcome["verified"]),
                             ("swept", ["max_for_live"], True), label)
            self.assertIs(self.selected(), self.h.song.tracks[0])

    def test_a_clean_late_load_is_left_alone_and_reported_clean(self):
        for label, ref, pick, before in TARGETS:
            self.load(self.late(lambda: FakeDevice("Operator", "UltraAnalog", 1), name="C%s.adg" % label), ref)
            self.land(self.pump())
            self.assertEqual(names_of(pick(self.h.song)), before + ["Operator"], label)
            self.assertEqual(self.last()["state"], "clean", label)

    def test_a_second_load_on_a_target_with_a_pending_sweep_is_busy_but_other_targets_are_not(self):
        self.load(self.late(max_device, ticks=999), R0)
        uri = self.listed_uri("audio_effects", "Compressor")
        error = self.load(uri, R0)["error"]
        self.assertEqual((error["code"], error["details"]["reason"]), ("busy", "sweep_pending"))
        self.assertTrue(self.load(uri, M)["ok"])

    def test_the_script_s_own_changes_do_not_end_a_sweep_on_a_return_or_master(self):
        for label, ref, pick, before in TARGETS:
            self.load(self.late(max_device, name="S%s.adg" % label, ticks=2), ref)
            pump = self.jobs_pump()
            self.assertTrue(self.submit(pump, "device_insert", {"container": C(ref), "name": "Utility"})["ok"])
            self.assertEqual(len(self.h.state.sweeps), 1, label)         # the insert is not the load's
            self.browser.advance()
            pump.drain()
            self.assertEqual(len(self.h.state.sweeps), 1, label)         # nothing landed yet
            self.browser.advance()
            pump.drain()
            self.assertEqual(names_of(pick(self.h.song)), before + ["Utility"], label)
            self.assertEqual((self.last()["state"], self.last()["removed"]), ("swept", ["max_for_live"]), label)

    def test_a_pending_sweep_on_a_live_return_or_master_is_not_reported_as_track_gone(self):
        for label, ref, pick, before in TARGETS:
            self.h.state.sweeps[:] = []
            self.load(self.late(max_device, name="G%s.adg" % label, ticks=999), ref)
            pump = self.pump()
            pump.drain()
            self.assertEqual(len(self.h.state.sweeps), 1, label)
            self.assertEqual([o for o in self.h.state.recent_sweeps() if o["state"] == "track_gone"], [], label)


class StuckView:
    """A view that ignores every attempt to select another track (Live refusing the selection)."""

    def __init__(self, track):
        self._track = track

    @property
    def selected_track(self):
        return self._track

    @selected_track.setter
    def selected_track(self, value):
        pass


class SelectionCheckTests(BrowserCase):
    def test_a_selection_that_did_not_take_refuses_the_load_before_load_item(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        for label, ref, pick, before in TARGETS + (("track", T1, lambda song: song.tracks[1], ["Compressor"]),):
            self.h.song.view = StuckView(self.h.song.tracks[0])
            self.h.reset_log()
            self.browser.loaded.clear()
            error = self.load(uri, ref)["error"]
            self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "selection_failed"), label)
            self.assertNotIn("call:Browser.load_item", self.h.song.log, label)
            self.assertEqual(self.browser.loaded, [], label)
            self.assertEqual(names_of(pick(self.h.song)), before, label)
            self.assertEqual(names_of(self.h.song.tracks[0]), ["Operator", "FX Rack", "Utility"], label)
            self.assertIs(self.selected(), self.h.song.tracks[0], label)

    def test_the_check_also_holds_inside_a_batch(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        self.h.song.view = StuckView(self.h.song.tracks[0])
        error = self.batch_error("browser_load", {"track": R0, "uri": uri})
        self.assertEqual(error["details"]["reason"], "selection_failed")
        self.assertEqual(self.browser.loaded, [])

    def test_loading_onto_the_already_selected_track_still_works(self):
        self.h.song.view = StuckView(self.h.song.tracks[0])
        uri = self.listed_uri("audio_effects", "Compressor")
        self.assertTrue(self.load(uri, {"kind": "track", "index": 0})["ok"])


class PreviousTrackSweepTests(NarrowCase):
    def lands_on_previous(self, make, name="Elsewhere.adg"):
        """A deferred load that, when it finally lands, sits on track 0 (the restored selection)."""
        def hook(browser, track):
            device = make()
            attach(browser._song, device)
            browser._song.tracks[0].devices.append(device)
        return self.put(name, on_load=hook, deferred=1)

    def test_an_offender_landing_on_the_restored_selection_is_swept(self):
        for target in (T1, R0, M):
            self.h.state.sweeps[:] = []
            before = names_of(self.h.song.tracks[0])
            result = self.load(self.lands_on_previous(max_device), target)["result"]
            self.assertTrue(result["sweep_pending"])
            self.land(self.pump())
            self.assertEqual(names_of(self.h.song.tracks[0]), before, target)
            self.assertEqual((self.last()["state"], self.last()["removed"]), ("swept", ["max_for_live"]), target)
            self.assertEqual(self.h.state.sweeps, [])

    def test_a_clean_device_landing_there_stays_and_ends_the_sweep(self):
        self.load(self.lands_on_previous(lambda: FakeDevice("Operator", "UltraAnalog", 1)), T1)
        self.land(self.pump())
        self.assertEqual(names_of(self.h.song.tracks[0])[-1], "Operator")
        self.assertEqual(self.last()["state"], "clean")

    def test_the_script_s_own_changes_on_the_previous_track_do_not_end_the_sweep(self):
        def hook(browser, track):
            device = max_device()
            attach(browser._song, device)
            browser._song.tracks[0].devices.append(device)
        self.load(self.put("Elsewhere.adg", on_load=hook, deferred=2), T1)
        pump = self.jobs_pump()
        self.assertTrue(self.submit(pump, "device_insert", {"container": C({"kind": "track", "index": 0}), "name": "Utility"})["ok"])
        self.browser.advance()
        pump.drain()
        self.assertEqual(len(self.h.state.sweeps), 1)                    # nothing landed yet
        self.browser.advance()
        pump.drain()
        self.assertEqual(names_of(self.h.song.tracks[0]), ["Operator", "FX Rack", "Utility", "Utility"])
        self.assertEqual((self.last()["state"], self.last()["removed"]), ("swept", ["max_for_live"]))

    def test_nothing_is_watched_when_the_target_was_the_selection(self):
        self.load(self.late(max_device, ticks=999), {"kind": "track", "index": 0})
        sweep = self.h.state.sweeps[0]
        self.assertIsNone(sweep.also_track)

    def test_the_second_watch_does_not_touch_what_was_already_there(self):
        old = max_device("Old Max")
        attach(self.h.song, old)
        self.h.song.tracks[0].devices.append(old)
        self.load(self.late(lambda: FakeDevice("Operator", "UltraAnalog", 1), ticks=1), T1)
        self.land(self.pump())
        self.assertIn("Old Max", names_of(self.h.song.tracks[0]))

    def test_a_previous_track_that_goes_away_does_not_end_the_sweep_as_gone(self):
        self.load(self.late(max_device, ticks=2), T1)
        self.h.song.tracks.pop(0)
        pump = self.pump()
        pump.drain()
        self.assertEqual(len(self.h.state.sweeps), 1)
        self.assertIsNone(self.h.state.sweeps[0].also_track)


if __name__ == "__main__":
    unittest.main()
