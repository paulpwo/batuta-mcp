"""T4b browser_list and browser_search (docs/01-protocol.md section 7.10): what is served and how
every item is classified (category + URI source + extension, never the display name)."""

import queue
import unittest

from remote_script.BatutaMCP import limits
from remote_script.BatutaMCP.dispatcher import Job, MainThreadPump
from remote_script.BatutaMCP.browser_policy import CORE_LIBRARY_URI_PREFIXES

from .browser_world import PLUGINS, USER_PRESETS, BrowserCase, sample_item
from .device_world import FLAGS_ALL
from .fake_browser import CORE, FakeItem, devices_loader
from .fakes import uninstall_fake_live


class ListTests(BrowserCase):
    def test_item_shape_and_native_devices(self):
        items = self.listing("instruments")
        operator = items["Operator"]
        self.assertEqual(set(operator), {"name", "uri", "is_folder", "is_loadable", "is_device", "blocked"})
        self.assertEqual((operator["is_folder"], operator["is_loadable"], operator["is_device"],
                          operator["blocked"]), (True, True, True, None))
        self.assertEqual(operator["uri"], "query:Synths#Operator")
        self.assertTrue(self.listing("audio_effects")["Compressor"]["is_loadable"])
        self.assertTrue(self.listing("midi_effects")["Arpeggiator"]["is_loadable"])
        self.assertNoSideEffects()

    def test_external_devices_are_blocked_by_their_uri(self):
        for category, name in (("instruments", "External Instrument"), ("audio_effects", "External Audio Effect")):
            item = self.listing(category)[name]
            self.assertEqual((item["blocked"], item["is_loadable"]), ("external_device", False), name)

    def test_factory_is_decided_by_the_uri_source_not_the_category(self):
        items = self.listing("sounds", ["Bass"])
        for name in ("Warm Bass.adg", "Wobble.adg", "Pluck.adg", "Ext.adg"):
            self.assertEqual((items[name]["blocked"], items[name]["is_loadable"]), (None, True), name)
        for name in ("Pack Pad.adg", "Pack Unmarked.adg"):
            self.assertEqual((items[name]["blocked"], items[name]["is_loadable"]), ("user_content", False), name)
        drums = self.listing("drums")
        self.assertTrue(drums["808 Kit.adg"]["is_loadable"])
        self.assertEqual(drums["Pack Kit.adg"]["blocked"], "user_content")

    def test_core_marker_does_not_make_content_factory_outside_the_five_categories(self):
        items = self.listing("packs", ["Cool Pack"])
        self.assertEqual(items["Core Lookalike.adg"]["blocked"], "user_content")
        self.assertEqual(items["Lead.adg"]["blocked"], "user_content")
        self.assertTrue(CORE_LIBRARY_URI_PREFIXES[0] in items["Core Lookalike.adg"]["uri"])

    def test_user_presets_open_only_with_the_hello_flag(self):
        for flags in (None, {}, {"allow_user_presets": False}, PLUGINS):
            self.assertEqual(self.listing("sounds", ["Bass"], flags or {})["Pack Pad.adg"]["blocked"],
                             "user_content", flags)
        shown = self.listing("sounds", ["Bass"], USER_PRESETS)
        self.assertEqual((shown["Pack Pad.adg"]["blocked"], shown["Pack Pad.adg"]["is_loadable"]), (None, True))
        self.assertTrue(shown["Pack Unmarked.adg"]["is_loadable"])
        user = self.listing("user_library", flags=USER_PRESETS)
        for name in ("Mine.adg", "Synth.adv", "Clip.alc"):
            self.assertTrue(user[name]["is_loadable"], name)
        self.assertTrue(self.listing("current_project", flags=USER_PRESETS)["Take.adv"]["is_loadable"])
        self.assertTrue(self.listing("packs", ["Cool Pack"], USER_PRESETS)["Lead.adg"]["is_loadable"])

    def test_without_the_flag_every_user_preset_is_blocked(self):
        user = self.listing("user_library")
        for name in ("Mine.adg", "Synth.adv", "Clip.alc"):
            self.assertEqual((user[name]["blocked"], user[name]["is_loadable"]), ("user_content", False), name)
        self.assertEqual(self.listing("current_project")["Take.adv"]["blocked"], "user_content")

    def test_max_for_live_and_live_sets_are_never_loadable(self):
        for flags in ({}, FLAGS_ALL):
            user = self.listing("user_library", flags=flags)
            self.assertEqual((user["Evil.amxd"]["blocked"], user["Evil.amxd"]["is_loadable"]),
                             ("max_for_live", False))
            self.assertEqual((user["Song.als"]["blocked"], user["Song.als"]["is_loadable"]),
                             ("live_set", False))
            self.assertEqual(self.listing("current_project", flags=flags)["Live Set.als"]["blocked"], "live_set")

    def test_hostile_uris_cannot_hide_an_amxd(self):
        user = self.listing("user_library", flags=FLAGS_ALL)
        self.assertEqual(user["Double%2Eamxd"]["blocked"], "max_for_live")      # encoded twice
        self.assertEqual(user["Hidden.amxd"]["blocked"], "max_for_live")        # .amxd earlier in the URI
        self.assertEqual(user["Sneaky.amxd.adg"]["blocked"], "max_for_live")    # ".amxd" anywhere in a segment

    def test_classification_never_uses_the_display_name(self):
        self.browser.set_category(
            "user_library",
            FakeItem("Totally Safe.wav", "query:UserLibrary#Presets:Evil.amxd", loadable=True,
                     loader=devices_loader()),
            FakeItem("Evil.amxd", "query:UserLibrary#Presets:Fine.wav", loadable=True, loader=devices_loader()),
            FakeItem("Operator", "query:Synths#External%20Instrument", loadable=True, device=True,
                     loader=devices_loader()))
        items = self.listing("user_library", flags=FLAGS_ALL)
        self.assertEqual(items["Totally Safe.wav"]["blocked"], "max_for_live")
        self.assertEqual((items["Evil.amxd"]["blocked"], items["Evil.amxd"]["is_loadable"]),
                         ("max_for_live", False))  # T9j: a name can add a block, never lift one
        self.browser.set_category(
            "instruments",
            FakeItem("External Instrument", "query:Synths#Operator", loadable=True, device=True,
                     loader=devices_loader()),
            FakeItem("Fine Synth", "query:Synths#External%20Instrument", loadable=True, device=True,
                     loader=devices_loader()))
        items = self.listing("instruments")
        self.assertEqual(items["External Instrument"]["blocked"], "external_device")  # T9j: name blocks too
        self.assertEqual(items["Fine Synth"]["blocked"], "external_device")

    def test_samples_are_served_from_any_category(self):
        self.assertTrue(self.listing("samples")["Kick.wav"]["is_loadable"])
        self.assertTrue(self.listing("samples")["Snare.aif"]["is_loadable"])
        self.assertTrue(self.listing("packs", ["Cool Pack"])["Loop.wav"]["is_loadable"])
        self.assertTrue(self.listing("user_library")["Vocal.wav"]["is_loadable"])   # upper-case extension

    def test_unclassifiable_items_are_blocked(self):
        samples = self.listing("samples")
        for name in ("Noise.exe", "NoExtension"):
            self.assertFalse(samples[name]["is_loadable"], name)
            self.assertIsNotNone(samples[name]["blocked"], name)

    def test_overlong_uris_are_never_classified_from_a_truncated_copy(self):
        head = "query:Samples#" + "a" * (1024 - len("query:Samples#") - 4) + ".wav"   # 1024 chars, ends .wav
        self.assertEqual(len(head), 1024)
        self.browser.set_category(
            "samples",
            sample_item("hides.amxd", head + "Evil.amxd"),
            sample_item("long.wav", head + "b" * 10 + ".wav"))
        for name, item in self.listing("samples", flags=FLAGS_ALL).items():
            self.assertEqual((item["is_loadable"], item["blocked"] is not None), (False, True), name)
            self.assertLessEqual(len(item["uri"]), 1024)

    def test_plugin_files_outside_the_plugin_category_need_allow_plugins(self):
        self.assertEqual(self.listing("user_library", flags=USER_PRESETS)["Patch.fxp"]["blocked"], "plugin")
        self.assertTrue(self.listing("user_library", flags=dict(USER_PRESETS, **PLUGINS))["Patch.fxp"]["is_loadable"])

    def test_plugins_category_is_served_only_with_allow_plugins(self):
        for flags in ({}, USER_PRESETS):
            self.h.flags = flags
            error = self.h.error("browser_list", {"category": "plugins"})
            self.assertEqual(self.refusal(error), ("not_supported", "disabled_by_config"))
        shown = self.listing("plugins", flags=PLUGINS)
        self.assertTrue(shown["Serum"]["is_loadable"])
        self.assertEqual(shown["Serum"]["blocked"], None)

    def test_max_for_live_modulators_and_unnamed_categories_are_never_served(self):
        for flags in ({}, FLAGS_ALL):
            self.h.flags = flags
            for category in ("max_for_live", "modulators", "clips", "Instruments", "", "legacy_libraries"):
                error = self.h.error("browser_list", {"category": category})
                self.assertEqual(self.refusal(error), ("not_supported", "blocked_content"), category)
                error = self.h.error("browser_search", {"query": "a", "category": category})
                self.assertEqual(self.refusal(error), ("not_supported", "blocked_content"), category)

    def test_absent_category_is_not_supported(self):
        self.browser.remove_category("samples")
        error = self.h.error("browser_list", {"category": "samples"})
        self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "live_version"))

    def test_no_live_module_is_not_supported(self):
        uninstall_fake_live()
        self.assertEqual(self.h.error("browser_list", {"category": "samples"})["code"], "not_supported")

    def test_path_navigation_and_errors(self):
        self.assertEqual(sorted(self.listing("sounds")), ["Bass"])
        self.assertIn("Warm Bass.adg", self.listing("sounds", ["Bass"]))
        self.assertEqual(self.h.error("browser_list", {"category": "sounds", "path": ["Nope"]})["code"], "not_found")
        self.assertEqual(self.h.error("browser_list", {"category": "sounds", "path": ["Bass"] * 9})["code"],
                         "invalid_args")
        self.browser.set_category("sounds", FakeItem("Dup", "query:Sounds#A", []), FakeItem("Dup", "query:Sounds#B", []))
        error = self.h.error("browser_list", {"category": "sounds", "path": ["Dup"]})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "ambiguous_name"))

    def test_paging_and_limits(self):
        page = self.h.ok("browser_list", {"category": "user_library", "limit": 3})
        self.assertEqual((len(page["items"]), page["total"], page["next_offset"]), (3, 10, 3))
        rest = self.h.ok("browser_list", {"category": "user_library", "limit": 200, "offset": 3})
        self.assertEqual((len(rest["items"]), rest["next_offset"]), (7, None))
        self.assertEqual(self.h.ok("browser_list", {"category": "user_library"})["items"][0]["name"], "Mine.adg")
        for limit in (0, 201):
            self.assertEqual(self.h.error("browser_list", {"category": "user_library", "limit": limit})["code"],
                             "invalid_args")

    def test_live_strings_are_cleaned_and_capped(self):
        self.browser.set_category("samples", sample_item("Bad\u0007‮" + "n" * 200 + ".wav",
                                                          "query:Samples#x\u0007.wav"))
        item = self.h.ok("browser_list", {"category": "samples"})["items"][0]
        self.assertEqual(len(item["name"]), 128)
        self.assertNotIn("\u0007", item["name"] + item["uri"])
        self.assertNotIn("‮", item["name"])

    def test_listing_never_mutates(self):
        self.listing("sounds", ["Bass"])
        self.listing("user_library")
        self.assertNoSideEffects()
        self.assertEqual(self.browser.loaded, [])


class SearchTests(BrowserCase):
    def search(self, query, **extra):
        return self.h.ok("browser_search", dict({"query": query}, **extra))

    def test_finds_loadable_items_case_insensitively_with_their_path(self):
        result = self.search("compress")
        self.assertEqual([i["name"] for i in result["items"]], ["Compressor"])
        item = result["items"][0]
        self.assertEqual(set(item), {"name", "uri", "path", "is_loadable", "blocked"})
        self.assertEqual((item["path"], item["is_loadable"], item["blocked"]), (["Compressor"], True, None))
        self.assertFalse(result["truncated"])
        self.assertGreater(result["visited"], 5)
        self.assertNoSideEffects()

    def test_nested_items_report_their_folder_path(self):
        result = self.search("warm bass")
        self.assertEqual(result["items"][0]["path"], ["Bass", "Warm Bass.adg"])
        self.assertEqual(self.search("bass op", category="instruments")["items"][0]["path"],
                         ["Operator", "Bass Op.adv"])

    def test_loadable_only_hides_blocked_items(self):
        names = [i["name"] for i in self.search("pad")["items"]]
        self.assertEqual(names, [])                       # Pack Pad.adg needs allow_user_presets
        shown = self.search("pad", loadable_only=False)["items"]
        self.assertEqual([(i["name"], i["blocked"], i["is_loadable"]) for i in shown],
                         [("Pack Pad.adg", "user_content", False)])
        self.h.flags = USER_PRESETS
        self.assertEqual([i["name"] for i in self.search("pad")["items"]], ["Pack Pad.adg"])

    def test_blocked_content_is_never_returned_as_loadable(self):
        for flags in ({}, FLAGS_ALL):
            self.h.flags = flags
            for query in ("amxd", "als", "external", "evil"):
                for item in self.search(query)["items"]:
                    self.assertNotIn(item["blocked"] or "", ("max_for_live", "live_set", "external_device"))
                    self.assertTrue(item["is_loadable"])
            shown = {i["name"]: i for i in self.search("amxd", loadable_only=False)["items"]}
            self.assertEqual(shown["Evil.amxd"]["blocked"], "max_for_live")

    def test_max_for_live_category_content_is_not_searched(self):
        self.h.flags = FLAGS_ALL
        self.assertEqual(self.search("Max Audio Effect", loadable_only=False)["items"], [])
        self.assertEqual(self.search("Convolution", loadable_only=False)["items"], [])
        self.assertEqual(self.search("Envelope", loadable_only=False)["items"], [])   # modulators

    def test_plugins_are_searched_only_with_allow_plugins(self):
        self.assertEqual(self.search("serum", loadable_only=False)["items"], [])
        self.h.flags = PLUGINS
        self.assertEqual([i["name"] for i in self.search("serum")["items"]], ["Serum", "Serum Preset"])

    def test_category_filter(self):
        self.assertEqual([i["name"] for i in self.search("kit", category="drums")["items"]], ["808 Kit.adg"])
        self.assertEqual(self.search("kick", category="drums")["items"], [])

    def test_limit_and_truncation(self):
        self.browser.set_category("samples", *[sample_item("take %d.wav" % i, "query:Samples#t%d.wav" % i)
                                                 for i in range(60)])
        result = self.search("take", category="samples", limit=5)
        self.assertEqual(len(result["items"]), 5)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(self.search("take", category="samples")["items"]), 25)
        self.assertEqual(len(self.search("take", category="samples", limit=50)["items"]), 50)
        for bad in (0, 51):
            self.assertEqual(self.h.error("browser_search", {"query": "a", "limit": bad})["code"], "invalid_args")

    def test_query_bounds(self):
        for query in ("", "x" * 65, 5):
            self.assertEqual(self.h.error("browser_search", {"query": query})["code"], "invalid_args")
        self.assertEqual(self.search("x" * 64)["items"], [])

    def test_visits_at_most_3000_nodes(self):
        self.browser.set_category("samples", *[sample_item("n%d.wav" % i, "query:Samples#n%d.wav" % i)
                                                 for i in range(3500)])
        result = self.search("zzz", category="samples")
        self.assertEqual((result["visited"], result["truncated"]), (limits.SEARCH_NODE_CAP, True))

    def test_exact_cap_is_not_truncated(self):
        self.browser.set_category("samples", *[sample_item("n%d.wav" % i, "query:Samples#n%d.wav" % i)
                                                 for i in range(100)])
        result = self.search("zzz", category="samples")
        self.assertEqual((result["visited"], result["truncated"]), (100, False))

    def test_breadth_first_order(self):
        self.browser.set_category(
            "sounds",
            FakeItem("deep", "query:Sounds#deep", [FakeItem("hit deep", "query:Sounds#hd", [
                FakeItem("hit deepest.wav", "query:Sounds#hdd.wav", loadable=True,
                         loader=devices_loader())])]),
            sample_item("hit shallow.wav", "query:Sounds#hs.wav"))
        names = [i["name"] for i in self.search("hit", category="sounds", loadable_only=False)["items"]]
        self.assertEqual(names, ["hit shallow.wav", "hit deep", "hit deepest.wav"])

    def test_children_of_blocked_devices_are_not_searched(self):
        self.browser.set_category("instruments", FakeItem(
            "External Instrument", "query:Synths#External%20Instrument",
            [sample_item("hidden child.wav", "query:Synths#hidden.wav")], loadable=True, device=True,
            loader=devices_loader()), FakeItem(
            "Operator", "query:Synths#Operator", [sample_item("shown child.wav", "query:Synths#shown.wav")],
            loadable=True, device=True, loader=devices_loader()))
        self.assertEqual([i["name"] for i in self.search("child", loadable_only=False)["items"]],
                         ["shown child.wav"])

    def test_results_register_uris_for_a_later_load(self):
        uri = self.search("kick")["items"][0]["uri"]
        self.assertEqual(self.load(uri)["ok"], True)

    def test_search_in_batch_is_forbidden(self):
        error = self.h.error("batch", {"ops": [{"cmd": "browser_search", "args": {"query": "a"}}]})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "forbidden_in_batch"))

    def test_search_is_read_only_and_opens_no_undo_step(self):
        self.search("a")
        self.assertNoSideEffects()


class ResumableSearchTests(BrowserCase):
    """browser_search is a generator handler: across ticks it stays within the 15 ms slice."""

    COST = 0.0078125  # seconds a `children` read costs in the fake (exact in binary)

    def setUp(self):
        super().setUp()
        self.tick_costs = []
        clock = self.h.clock

        def slow(item):
            clock.advance(self.COST)

        folders = [FakeItem("f%d" % i, "query:Samples#f%d" % i,
                            [sample_item("s%d_%d.wav" % (i, j), "query:Samples#s%d_%d.wav" % (i, j))
                             for j in range(3)], on_children=slow) for i in range(12)]
        self.browser.set_category("samples", *folders)

    def pump(self):
        inbound = queue.Queue(maxsize=64)
        posted = []
        pump = MainThreadPump(inbound, self.h.dispatcher, lambda cid, frame: posted.append(frame),
                              lambda cid: True, clock=self.h.clock)
        return inbound, posted, pump

    def job(self, args, request_id=1, timeout=15.0):
        command, normalized = self.h.registry.prepare_call("browser_search", args)
        return Job(1, request_id, command, normalized, self.h.clock() + timeout, {})

    def test_search_spans_ticks_and_matches_the_synchronous_result(self):
        inbound, posted, pump = self.pump()
        inbound.put(self.job({"query": "s11_", "category": "samples"}))
        ticks = 0
        while not posted and ticks < 50:
            before = self.h.clock()
            pump.drain()
            ticks += 1
            self.tick_costs.append(self.h.clock() - before)
        self.assertGreater(ticks, 2)
        self.assertLess(ticks, 50)
        self.assertTrue(posted[0]["ok"])
        self.assertEqual(len(posted[0]["result"]["items"]), 3)
        sync = self.h.ok("browser_search", {"query": "s11_", "category": "samples"})
        self.assertEqual(posted[0]["result"], sync)

    def test_each_tick_stays_within_the_slice_plus_one_step(self):
        inbound, posted, pump = self.pump()
        inbound.put(self.job({"query": "s11_", "category": "samples"}))
        for _ in range(50):
            before = self.h.clock()
            pump.drain()
            self.assertLessEqual(self.h.clock() - before, limits.SEARCH_SLICE_S + self.COST)
            if posted:
                break
        self.assertTrue(posted)

    def test_other_requests_answer_after_the_search(self):
        inbound, posted, pump = self.pump()
        inbound.put(self.job({"query": "s11_", "category": "samples"}, request_id=1))
        command, normalized = self.h.registry.prepare_call("catalog", {})
        inbound.put(Job(1, 2, command, normalized, self.h.clock() + 5, {}))
        for _ in range(50):
            pump.drain()
        self.assertEqual([frame["id"] for frame in posted], [1, 2])

    def test_default_timeout_is_15_seconds(self):
        self.assertEqual(self.h.registry.get("browser_search").default_timeout_ms, 15000)


class LruTests(BrowserCase):
    def test_uri_map_keeps_the_last_5000_listed_items(self):
        count = limits.URI_MAP_ENTRIES + 100
        self.browser.set_category("samples", *[sample_item("n%d.wav" % i, "query:Samples#n%d.wav" % i)
                                                 for i in range(count)])
        offset = 0
        while offset is not None:
            offset = self.h.ok("browser_list", {"category": "samples", "limit": 200, "offset": offset})["next_offset"]
        self.assertEqual(self.load("query:Samples#n0.wav")["error"]["code"], "not_supported")
        self.assertTrue(self.load("query:Samples#n%d.wav" % (count - 1))["ok"])
        self.assertTrue(self.load("query:Samples#n100.wav")["ok"])


if __name__ == "__main__":
    unittest.main()
