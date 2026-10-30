"""T4b browser_load (docs/01-protocol.md section 7.10): the allowlist, the load target and the
post-load cleanup of Max for Live, plugin and External devices (cleanup only, never a guarantee)."""

import unittest

from .browser_world import PLUGINS, USER_PRESETS, BrowserCase, sample_item
from .device_world import FLAGS_ALL, T0, T1
from .fake_browser import CORE, FakeItem, devices_loader
from .fake_devices import FakeChain, FakeDevice, FakeRack, attach, external_device, max_device, plugin_device


def loaded_names(case, track=1):
    return [device.name for device in case.h.song.tracks[track].devices]


class LoadAllowedTests(BrowserCase):
    def test_native_device_loads_onto_the_explicit_track_and_selection_is_restored(self):
        self.assertIs(self.selected(), self.h.song.tracks[0])
        uri = self.listed_uri("audio_effects", "Compressor")
        response = self.load(uri, T1)
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"], {"loaded": {"name": "Compressor", "uri": uri}, "device_count": 2,
                                              "verified": True, "sweep_pending": False, "previous_sweep": None})
        self.assertEqual(loaded_names(self), ["Compressor", "Compressor"])
        self.assertIs(self.selected(), self.h.song.tracks[0])
        self.assertEqual(self.browser.loaded, [uri])

    def test_one_undo_step_and_the_selection_changes_only_inside_the_handler(self):
        self.load(self.listed_uri("audio_effects", "Compressor"), T1)
        self.assertEqual(self.h.song.events, ["begin", "end"])
        self.assertEqual(self.h.song.log.count("call:Browser.load_item"), 1)

    def test_loading_onto_the_selected_track_works_too(self):
        response = self.load(self.listed_uri("instruments", "Operator"), T0)
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["device_count"], 4)
        self.assertIs(self.selected(), self.h.song.tracks[0])

    def test_factory_preset_loads_without_any_opt_in(self):
        uri = self.listed_uri("sounds", "Warm Bass.adg", ["Bass"])
        self.assertTrue(self.load(uri, T1)["ok"])
        self.assertEqual(loaded_names(self), ["Compressor", "Warm Bass"])
        self.assertTrue(self.load(self.listed_uri("drums", "808 Kit.adg"), T1)["ok"])

    def test_samples_load_from_any_served_category(self):
        for category, path, name in (("samples", None, "Kick.wav"), ("packs", ["Cool Pack"], "Loop.wav"),
                                     ("user_library", None, "Vocal.wav")):
            self.assertTrue(self.load(self.listed_uri(category, name, path), T1)["ok"], name)

    def test_user_presets_load_only_with_the_flag(self):
        for category, path, name in (("user_library", None, "Mine.adg"), ("packs", ["Cool Pack"], "Lead.adg"),
                                     ("current_project", None, "Take.adv"), ("sounds", ["Bass"], "Pack Pad.adg")):
            uri = self.listed_uri(category, name, path, USER_PRESETS)
            self.assertTrue(self.load(uri, T1)["ok"], name)
            self.h.flags = {}
            response = self.load(uri, T1)           # the flag is checked again at load time
            self.assertEqual((response["error"]["code"], response["error"]["details"]["reason"]),
                             ("not_supported", "blocked_content"), name)

    def test_plugins_load_only_with_the_flag(self):
        uri = self.listed_uri("plugins", "Serum", flags=PLUGINS)
        response = self.load(uri, T1)
        self.assertTrue(response["ok"], response)
        self.assertEqual(loaded_names(self), ["Compressor", "Serum"])    # allowed plugin stays
        self.h.flags = {}
        self.assertEqual(self.load(uri, T1)["error"]["code"], "not_supported")


class LoadRefusalTests(BrowserCase):
    def assertRefused(self, response, why=None):
        self.assertFalse(response["ok"], response)
        error = response["error"]
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "blocked_content"))
        if why is not None:
            self.assertEqual(error["details"].get("blocked"), why)
        self.assertEqual(self.h.song.log, [])
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.browser.loaded, [])
        self.assertEqual(loaded_names(self), ["Compressor"])

    def refused_listed(self, category, name, path=None, flags=FLAGS_ALL, why=None):
        uri = self.listed_uri(category, name, path, flags)
        self.h.reset_log()
        self.assertRefused(self.load(uri, T1), why)

    def test_amxd_and_als_are_never_loadable_even_with_every_opt_in(self):
        self.refused_listed("user_library", "Evil.amxd", why="max_for_live")
        self.refused_listed("user_library", "Song.als", why="live_set")
        self.refused_listed("current_project", "Live Set.als", why="live_set")
        self.refused_listed("user_library", "Double%2Eamxd", why="max_for_live")
        self.refused_listed("user_library", "Hidden.amxd", why="max_for_live")

    def test_pack_adg_reached_through_sounds_is_refused_without_allow_user_presets(self):
        self.refused_listed("sounds", "Pack Pad.adg", ["Bass"], flags={}, why="user_content")
        self.refused_listed("sounds", "Pack Unmarked.adg", ["Bass"], flags={}, why="user_content")
        self.refused_listed("drums", "Pack Kit.adg", flags={}, why="user_content")
        self.refused_listed("packs", "Core Lookalike.adg", ["Cool Pack"], flags={}, why="user_content")

    def test_external_devices_are_blocked_before_the_load(self):
        self.refused_listed("instruments", "External Instrument", why="external_device")
        self.refused_listed("audio_effects", "External Audio Effect", why="external_device")

    def test_unclassifiable_items_are_refused(self):
        self.refused_listed("samples", "Noise.exe")
        self.refused_listed("samples", "NoExtension")

    def test_overlong_uris_cannot_be_loaded(self):
        head = "query:Samples#" + "a" * (1024 - len("query:Samples#") - 4) + ".wav"
        self.browser.set_category("samples", sample_item("hides.amxd", head + "Evil.amxd"))
        shown = self.listing("samples", flags=FLAGS_ALL)["hides.amxd"]["uri"]
        self.assertRefused(self.load(shown, T1))

    def test_uris_that_were_never_listed_are_refused(self):
        for uri in ("query:Max#Audio%20Effect", "query:Max#Convolution.amxd", "query:Modulators#Envelope",
                    "query:Plugins#VST3:Serum", CORE + "Bass:Warm%20Bass.adg", "", "x" * 1000):
            self.assertRefused(self.load(uri, T1))

    def test_max_for_live_category_cannot_be_reached_by_list_or_load(self):
        error = self.h.error("browser_list", {"category": "max_for_live"})
        self.assertEqual(error["code"], "not_supported")
        self.assertRefused(self.load("query:Max#Audio%20Effect", T1))

    def test_a_new_connection_starts_with_an_empty_uri_map(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        self.h.state.bind_connection(2)
        self.assertRefused(self.load(uri, T1))

    def test_plugin_file_listed_with_plugins_but_loaded_without_is_refused(self):
        uri = self.listed_uri("user_library", "Patch.fxp", flags=FLAGS_ALL)
        self.h.flags = USER_PRESETS
        self.h.reset_log()
        self.assertRefused(self.load(uri, T1), "plugin")

    def test_track_must_exist_and_match_its_name_guard(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        self.assertEqual(self.load(uri, {"kind": "track", "index": 9})["error"]["code"], "not_found")
        error = self.load(uri, {"kind": "track", "index": 1, "expect_name": "wrong"})["error"]
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_found", "name_mismatch"))
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.browser.loaded, [])

    def test_batch_path_repeats_every_check(self):
        uri = self.listed_uri("user_library", "Evil.amxd", flags=FLAGS_ALL)
        self.h.reset_log()
        error = self.batch_error("browser_load", {"track": T1, "uri": uri})
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "blocked_content"))
        self.assertEqual(self.h.song.log, [])
        self.assertEqual(self.browser.loaded, [])

    def test_batch_load_is_one_undo_step(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        self.h.reset_log()
        result = self.h.ok("batch", {"ops": [{"cmd": "browser_load", "args": {"track": T1, "uri": uri}},
                                              {"cmd": "browser_load", "args": {"track": T1, "uri": uri}}]})
        self.assertEqual([r["ok"] for r in result["results"]], [True, True])
        self.assertEqual(self.h.song.events, ["begin", "end"])
        self.assertIs(self.selected(), self.h.song.tracks[0])


class LoadCleanupTests(BrowserCase):
    def assertCleaned(self, response, expect_names):
        self.assertFalse(response["ok"], response)
        error = response["error"]
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "blocked_content"))
        self.assertIs(error["details"]["partial"], True)
        self.assertEqual(loaded_names(self), expect_names)
        self.assertIs(self.selected(), self.h.song.tracks[0])       # restored on every path

    def leftovers(self, rack):
        chains = list(rack.chains) + list(rack.return_chains)
        chains += [c for pad in getattr(rack, "drum_pads", []) for c in pad.chains]
        return sum(len(c.devices) for c in chains)

    def test_max_for_live_inside_a_factory_rack_is_removed(self):
        uri = self.listed_uri("sounds", "Wobble.adg", ["Bass"])
        self.assertCleaned(self.load(uri, T1), ["Compressor", "Hiding Rack"])
        self.assertEqual(self.leftovers(self.h.song.tracks[1].devices[-1]), 0)

    def test_plugin_in_a_return_chain_is_removed_unless_allow_plugins(self):
        uri = self.listed_uri("sounds", "Pluck.adg", ["Bass"])
        self.assertCleaned(self.load(uri, T1), ["Compressor", "Hiding Rack"])
        self.assertEqual(self.leftovers(self.h.song.tracks[1].devices[-1]), 0)
        self.h.flags = PLUGINS
        self.assertTrue(self.load(uri, T1)["ok"])
        self.assertEqual(self.leftovers(self.h.song.tracks[1].devices[-1]), 1)

    def test_external_device_in_a_drum_pad_is_removed(self):
        uri = self.listed_uri("sounds", "Ext.adg", ["Bass"])
        self.assertCleaned(self.load(uri, T1), ["Compressor", "Hiding Kit"])
        self.assertEqual(self.leftovers(self.h.song.tracks[1].devices[-1]), 0)

    def test_external_class_behind_an_innocent_uri_is_removed(self):
        uri = self.listed_uri("instruments", "Mystery Synth")
        self.assertCleaned(self.load(uri, T1), ["Compressor"])

    def test_a_top_level_max_device_is_removed(self):
        self.browser.set_category("user_library", FakeItem("Odd.adv", "query:UserLibrary#Presets:Odd.adv",
                                                            loadable=True, loader=devices_loader(max_device)))
        uri = self.listed_uri("user_library", "Odd.adv", flags=USER_PRESETS)
        self.assertCleaned(self.load(uri, T1), ["Compressor"])

    def test_pre_existing_blocked_devices_are_left_alone(self):
        old = max_device("Old Max")
        self.h.song.tracks[1].devices.append(old)
        attach(self.h.song, old)
        uri = self.listed_uri("audio_effects", "Compressor")
        self.assertTrue(self.load(uri, T1)["ok"])
        self.assertEqual(loaded_names(self), ["Compressor", "Old Max", "Compressor"])

    def test_clean_nested_preset_is_kept(self):
        self.browser.set_category("sounds", FakeItem("Fine.adg", CORE + "Fine.adg", loadable=True, loader=devices_loader(
            lambda: FakeRack("Fine", [FakeChain("In", [FakeDevice("Reverb", "Reverb")])]))))
        self.assertTrue(self.load(self.listed_uri("sounds", "Fine.adg"), T1)["ok"])
        self.assertEqual(self.leftovers(self.h.song.tracks[1].devices[-1]), 1)

    def test_selection_is_restored_when_the_load_itself_fails(self):
        def boom(track):
            raise RuntimeError("cannot load")
        self.browser.set_category("audio_effects", FakeItem("Broken", "query:AudioFx#Broken", loadable=True,
                                                             device=True, loader=boom))
        response = self.load(self.listed_uri("audio_effects", "Broken"), T1)
        self.assertEqual(response["error"]["code"], "lom_error")
        self.assertIs(response["error"]["details"]["partial"], True)
        self.assertIs(self.selected(), self.h.song.tracks[0])
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_chain_that_cannot_delete_loses_the_whole_new_device(self):
        from .fake_devices import FakeChainNoDelete
        def make():
            rack = FakeRack("Locked", [FakeChainNoDelete("In", [max_device()])])
            return rack
        self.browser.set_category("sounds", FakeItem("Locked.adg", CORE + "Locked.adg", loadable=True,
                                                      loader=devices_loader(make)))
        self.assertCleaned(self.load(self.listed_uri("sounds", "Locked.adg"), T1), ["Compressor"])

    def test_an_unverifiable_huge_tree_is_removed(self):
        def make():
            rack = FakeRack("Huge", [FakeChain("c%d" % i, [FakeDevice("d%d_%d" % (i, j), "Generic")
                                                           for j in range(60)]) for i in range(9)])
            return rack
        self.browser.set_category("sounds", FakeItem("Huge.adg", CORE + "Huge.adg", loadable=True,
                                                      loader=devices_loader(make)))
        response = self.load(self.listed_uri("sounds", "Huge.adg"), T1)
        self.assertCleaned(response, ["Compressor"])
        self.assertIs(response["error"]["details"]["verified"], False)

    def test_load_cleanup_in_batch_still_restores_the_selection(self):
        uri = self.listed_uri("sounds", "Wobble.adg", ["Bass"])
        self.h.reset_log()
        error = self.batch_error("browser_load", {"track": T1, "uri": uri})
        self.assertEqual(error["code"], "not_supported")
        self.assertIs(self.selected(), self.h.song.tracks[0])


if __name__ == "__main__":
    unittest.main()
