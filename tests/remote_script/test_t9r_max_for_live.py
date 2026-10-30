"""T9r: Max for Live is allowed by default (browser.allow_max_for_live). With the flag set the browser
classifies .amxd and M4L items as loadable, a loaded Max device stays (no sweep, no rack refusal) and
the max_for_live category is served. Without the flag every block stays as before. External devices,
.als sets and the plugin rules do not depend on the flag."""

import unittest

from remote_script.BatutaMCP import browser_policy, content_policy

from .browser_world import BrowserCase
from .device_world import T1
from .fake_browser import FakeItem, devices_loader
from .fake_devices import FakeDevice, external_device, max_device, rack_hiding
from .test_t4b_review_sweep import SweepCase

M4L = {"allow_max_for_live": True}
OFF = {"allow_max_for_live": False}


def blocked_reason(response):
    error = response["error"]
    return error["code"], error["details"]["reason"]


class ClassifyTests(unittest.TestCase):
    def classify(self, flags, uri, name=None, category="user_library", source=None, is_device=False):
        return browser_policy.classify(category, uri, is_device, flags, source, name)

    def test_amxd_and_m4l_names_are_loadable_with_the_flag(self):
        for uri, name in (("query:UserLibrary#Presets:Evil.amxd", "Evil.amxd"),
                          ("query:Sounds#FileId_1", "Hidden.amxd"),
                          ("query:UserLibrary#Presets:Thing.amxd.bak:x.wav", None)):
            self.assertIsNone(self.classify(M4L, uri, name), uri)
        both = {"allow_max_for_live": True, "allow_user_presets": True}
        self.assertIsNone(self.classify(both, "query:Packs#M4L:Thing.adv", "Thing", source="Max for Live",
                                        category="packs"))
        self.assertIsNone(self.classify(both, "query:UserLibrary#Presets:m4l_tools:Thing.adv"))

    def test_m4l_named_preset_is_an_ordinary_preset_with_the_flag(self):
        uri = "query:UserLibrary#Presets:Cool%20M4L%20Pad.adg"
        self.assertEqual(self.classify(M4L, uri, "Cool M4L Pad.adg"), "user_content")
        self.assertIsNone(self.classify({"allow_max_for_live": True, "allow_user_presets": True}, uri,
                                        "Cool M4L Pad.adg"))

    def test_without_the_flag_every_m4l_block_stays(self):
        for flags in ({}, OFF):
            self.assertEqual(self.classify(flags, "query:UserLibrary#Presets:Evil.amxd"), "max_for_live")
            self.assertEqual(self.classify(flags, "query:Sounds#FileId_1", "Cool M4L Pad.adg"), "max_for_live")
            self.assertEqual(self.classify(flags, "query:Packs#x", "Thing", source="Max for Live"),
                             "max_for_live")

    def test_max_for_live_category_devices_are_loadable_with_the_flag(self):
        self.assertIsNone(self.classify(M4L, "query:Max#Audio%20Effect", "Max Audio Effect",
                                        category="max_for_live", is_device=True))
        self.assertIsNone(self.classify(M4L, "query:Max#Convolution.amxd", "Convolution.amxd",
                                        category="max_for_live"))
        self.assertEqual(self.classify(OFF, "query:Max#Audio%20Effect", "Max Audio Effect",
                                       category="max_for_live", is_device=True), "max_for_live")

    def test_live_sets_external_and_plugins_do_not_depend_on_the_flag(self):
        self.assertEqual(self.classify(M4L, "query:UserLibrary#Presets:Song.als"), "live_set")
        self.assertEqual(self.classify(M4L, "query:Sounds#FileId_2", "External Instrument"), "external_device")
        self.assertEqual(self.classify(M4L, "query:Plugins#VST3:Serum", category="plugins"), "plugin")
        self.assertEqual(self.classify(M4L, "query:UserLibrary#Presets:Evil.amxd.als"), "live_set")


class ContentPolicyTests(unittest.TestCase):
    def test_insert_names(self):
        for name in ("Max Audio Effect", "m4l thing", "Thing.amxd"):
            self.assertEqual(content_policy.blocked_insert_name(name), "max_for_live", name)
            self.assertIsNone(content_policy.blocked_insert_name(name, allow_max=True), name)
        self.assertEqual(content_policy.blocked_insert_name("External Instrument", allow_max=True),
                         "external_device")
        self.assertEqual(content_policy.blocked_insert_name("Set.als", allow_max=True), "live_set")

    def test_offence(self):
        device = max_device()
        self.assertEqual(content_policy.offence(device, False), "max_for_live")
        self.assertIsNone(content_policy.offence(device, False, allow_max=True))
        self.assertIsNone(content_policy.offence(FakeDevice("Env", "MaxDevice"), False, allow_max=True))
        self.assertEqual(content_policy.offence(external_device(), True, allow_max=True), "external_device")


class BrowseTests(BrowserCase):
    def test_max_for_live_category_is_served_with_the_flag(self):
        shown = self.listing("max_for_live", flags=M4L)
        self.assertEqual((shown["Max Audio Effect"]["blocked"], shown["Max Audio Effect"]["is_loadable"]),
                         (None, True))
        self.assertIsNone(shown["Convolution.amxd"]["blocked"])

    def test_max_for_live_category_stays_refused_without_the_flag(self):
        for flags in ({}, OFF):
            self.h.flags = flags
            error = self.h.error("browser_list", {"category": "max_for_live"})
            self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "blocked_content"))

    def test_search_reaches_max_for_live_with_the_flag(self):
        self.h.flags = M4L
        names = [i["name"] for i in self.h.ok("browser_search", {"query": "Convolution"})["items"]]
        self.assertEqual(names, ["Convolution.amxd"])

    def test_amxd_in_the_user_library_is_listed_loadable_with_the_flag(self):
        shown = self.listing("user_library", flags=M4L)
        self.assertEqual((shown["Evil.amxd"]["blocked"], shown["Evil.amxd"]["is_loadable"]), (None, True))
        self.assertEqual(shown["Song.als"]["blocked"], "live_set")


class LoadTests(BrowserCase):
    def names(self, track=1):
        return [d.name for d in self.h.song.tracks[track].devices]

    def test_an_amxd_loads_and_stays_with_the_flag(self):
        uri = self.listed_uri("user_library", "Evil.amxd", flags=M4L)
        response = self.load(uri, T1)
        self.assertTrue(response["ok"], response)
        self.assertEqual(self.names(), ["Compressor", "Loop Tool"])
        self.assertEqual(self.h.song.tracks[1].devices[-1].class_name, "MxDeviceAudioEffect")

    def test_an_amxd_is_refused_when_the_flag_is_off_or_turned_off_after_listing(self):
        uri = self.listed_uri("user_library", "Evil.amxd", flags=M4L)
        self.h.flags = OFF
        self.assertEqual(blocked_reason(self.load(uri, T1)), ("not_supported", "blocked_content"))
        self.assertEqual(self.names(), ["Compressor"])

    def test_a_max_device_behind_an_innocent_uri_is_not_removed_with_the_flag(self):
        self.browser.set_category("user_library", FakeItem("Odd.adv", "query:UserLibrary#Presets:Odd.adv",
                                                            loadable=True, loader=devices_loader(max_device)))
        uri = self.listed_uri("user_library", "Odd.adv", flags={"allow_max_for_live": True,
                                                                 "allow_user_presets": True})
        self.assertTrue(self.load(uri, T1)["ok"])
        self.assertEqual(self.names(), ["Compressor", "Loop Tool"])

    def test_a_rack_holding_a_max_device_is_not_refused_with_the_flag(self):
        uri = self.listed_uri("sounds", "Wobble.adg", ["Bass"], flags=M4L)
        self.assertTrue(self.load(uri, T1)["ok"])
        rack = self.h.song.tracks[1].devices[-1]
        self.assertEqual(sum(len(c.devices) for c in list(rack.chains) + list(rack.return_chains)), 1)

    def test_a_rack_holding_a_max_device_is_still_refused_without_the_flag(self):
        uri = self.listed_uri("sounds", "Wobble.adg", ["Bass"], flags=OFF)
        response = self.load(uri, T1)
        self.assertEqual(blocked_reason(response), ("not_supported", "blocked_content"))
        self.assertEqual(response["error"]["details"]["removed"], ["max_for_live"])

    def test_external_devices_are_removed_even_with_the_flag(self):
        uri = self.listed_uri("sounds", "Ext.adg", ["Bass"], flags=M4L)
        response = self.load(uri, T1)
        self.assertEqual(response["error"]["details"]["removed"], ["external_device"])
        self.assertEqual(self.names(), ["Compressor", "Hiding Kit"])


class SweepTests(SweepCase):
    def late(self, make, name="Late.adg", ticks=1, **extra):
        return self.put(name, loader=devices_loader(make), deferred=ticks, **extra)

    def test_a_late_max_device_is_not_swept_with_the_flag(self):
        self.h.flags = M4L
        self.load(self.late(max_device), T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor", "Loop Tool"])
        self.assertEqual(self.h.state.sweeps, [])
        self.assertEqual(self.h.state.recent_sweeps()[0]["state"], "clean")

    def test_the_flag_of_the_load_that_started_the_sweep_decides(self):
        self.h.flags = M4L
        self.load(self.late(max_device), T1)
        self.h.flags = OFF
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor", "Loop Tool"])

    def test_a_late_max_device_is_still_swept_without_the_flag(self):
        self.h.flags = OFF
        self.load(self.late(max_device), T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor"])
        self.assertEqual(self.h.state.recent_sweeps()[0]["removed"], ["max_for_live"])

    def test_a_late_external_device_is_swept_with_the_flag(self):
        self.h.flags = M4L
        self.load(self.late(lambda: rack_hiding(external_device(), "chain")), T1)
        self.land(self.pump())
        self.assertEqual(self.h.state.recent_sweeps()[0]["removed"], ["external_device"])


if __name__ == "__main__":
    unittest.main()
