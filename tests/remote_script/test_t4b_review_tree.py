"""T4b review round 1, M-1: a device tree that cannot be fully seen is never trusted. Loads and inserts
are refused up front when the existing tree is truncated; a truncated post-load tree deletes every new
top-level device (never an existing one) and says "not verified"."""

import unittest

from .browser_world import BrowserCase
from .device_world import C, D, FLAGS_ALL, T0, T1
from .fake_browser import CORE, FakeItem, devices_loader
from .fake_devices import FakeChain, FakeDevice, FakeRack, attach, max_device


def crowd(count):
    return [FakeDevice("old%d" % i, "Generic") for i in range(count)]


def huge_rack(name="Huge"):
    return FakeRack(name, [FakeChain("c%d" % i, [FakeDevice("d%d_%d" % (i, j), "Generic") for j in range(60)])
                           for i in range(9)])


class PreLoadTruncationTests(BrowserCase):
    def fill_track(self, count=501):
        self.h.song.tracks[1].devices += crowd(count)
        for device in self.h.song.tracks[1].devices:
            attach(self.h.song, device)
        self.h.reset_log()

    def assertTreeTooLarge(self, error):
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "tree_too_large"))

    def test_browser_load_is_refused_when_the_existing_tree_is_truncated(self):
        uri = self.listed_uri("audio_effects", "Compressor")
        self.fill_track()
        self.assertTreeTooLarge(self.load(uri, T1)["error"])
        self.assertEqual(self.h.song.log, [])
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.browser.loaded, [])

    def test_device_insert_is_refused_when_the_existing_tree_is_truncated(self):
        self.fill_track()
        self.assertTreeTooLarge(self.h.error("device_insert", {"container": C(T1), "name": "Reverb"}))
        self.assertEqual(self.h.song.log, [])
        self.assertEqual(self.h.song.events, [])

    def test_the_batch_path_repeats_the_refusal(self):
        self.fill_track()
        self.assertTreeTooLarge(self.batch_error("device_insert", {"container": C(T1), "name": "Reverb"}))
        self.assertEqual(self.h.song.log, [])

    def test_exactly_500_devices_are_still_fully_visible(self):
        self.fill_track(498)      # plus the Compressor already there and the new Reverb: exactly 500
        self.h.ok("device_insert", {"container": C(T1), "name": "Reverb"})


class PostLoadTruncationTests(BrowserCase):
    def setUp(self):
        super().setUp()
        self.top = self.h.song.tracks[1].devices

    def add_item(self, make, name="Huge.adg", **extra):
        self.browser.set_category("sounds", FakeItem(name, CORE + name, loadable=True,
                                                      loader=devices_loader(make), **extra))
        return self.listed_uri("sounds", name)

    def test_unverifiable_load_deletes_new_top_level_devices_and_says_not_verified(self):
        error = self.load(self.add_item(huge_rack), T1)["error"]
        self.assertEqual(error["code"], "not_supported")
        self.assertIs(error["details"]["verified"], False)
        self.assertIn("not verified", error["message"])
        self.assertNotIn("removed", error["message"].lower())
        self.assertEqual([d.name for d in self.top], ["Compressor"])

    def test_verified_cleanup_still_says_removed(self):
        self.browser.set_category("sounds", FakeItem("M.adg", CORE + "M.adg", loadable=True,
                                                      loader=devices_loader(max_device)))
        error = self.load(self.listed_uri("sounds", "M.adg"), T1)["error"]
        self.assertIn("removed", error["message"])
        self.assertIs(error["details"]["verified"], True)

    def test_existing_devices_survive_even_when_the_new_one_lands_in_front(self):
        before = list(self.top)

        def in_front(browser, track):
            rack = huge_rack()
            attach(browser._song, rack)
            track.devices.insert(0, rack)
        uri = self.add_item(huge_rack, on_load=in_front)
        self.assertEqual(self.load(uri, T1)["error"]["code"], "not_supported")
        self.assertEqual(len(self.top), len(before))
        self.assertTrue(all(a is b for a, b in zip(self.top, before)))

    def test_two_new_top_level_devices_are_both_deleted_in_position_order(self):
        def two(browser, track):
            for name in ("HugeA", "HugeB"):
                rack = huge_rack(name)
                attach(browser._song, rack)
                track.devices.append(rack)
        uri = self.add_item(huge_rack, on_load=two)
        self.load(uri, T1)
        self.assertEqual([d.name for d in self.top], ["Compressor"])

    def test_a_huge_new_device_inside_an_existing_chain_is_deleted_from_that_chain(self):
        self.h.song.device_factories["Huge"] = huge_rack
        before = [d.name for d in self.h.song.tracks[0].devices[1].chains[1].devices]
        error = self.h.error("device_insert", {"container": C(T0, 1, {"chain": 1}), "name": "Huge"})
        self.assertEqual(error["code"], "not_supported")
        self.assertIs(error["details"]["verified"], False)
        self.assertIn("not verified", error["message"])
        self.assertEqual([d.name for d in self.h.song.tracks[0].devices[1].chains[1].devices], before)
        self.assertEqual(self.h.song.tracks[0].devices[1].name, "FX Rack")

    def test_a_huge_new_top_level_device_from_device_insert_is_deleted(self):
        self.h.song.device_factories["Huge"] = huge_rack
        error = self.h.error("device_insert", {"container": C(T1), "name": "Huge"})
        self.assertIn("not verified", error["message"])
        self.assertEqual([d.name for d in self.top], ["Compressor"])


if __name__ == "__main__":
    unittest.main()
