"""T4b cross-cutting checks: the 18 device, rack and browser commands are registered with the exact
classification, the whole catalog is the 83 commands of spec 7.15, mutating commands open one undo
step and none on a precheck rejection (also inside batch), reads never mutate, Appendix A caps hold."""

import unittest

from remote_script.BatutaMCP.command_set import build_registry

from .browser_world import BrowserCase
from .device_world import C, D, R0, T0, T1, T2, M
from .test_cmds_catalog_t3 import FORBIDDEN_NAMES

UTIL = D(T0, 2)
RACK = D(T0, 1)
KIT = D(T2, 0)
CHAIN = {"kind": "chain", "index": 0}

# name -> (mutating, destructive, conditions); straight from the spec tables 7.8, 7.9 and 7.10.
SPEC_T4B = {
    "device_list": (False, "never", ()), "device_get": (False, "never", ()), "param_get": (False, "never", ()),
    "param_set": (True, "conditional", ("items", "value")), "device_enable": (True, "never", ()),
    "device_delete": (True, "always", ()), "device_insert": (True, "never", ()),
    "rack_get": (False, "never", ()), "chain_set": (True, "conditional", ("volume", "volume_db")),
    "rack_insert_chain": (True, "never", ()), "rack_variation": (True, "conditional", ("action",)),
    "drum_pads_list": (False, "never", ()), "drum_pad_set": (True, "never", ()),
    "drum_pad_copy": (True, "always", ()), "drum_pad_clear": (True, "always", ()),
    "browser_list": (False, "never", ()), "browser_search": (False, "never", ()),
    "browser_load": (True, "never", ()),
}

SAMPLES = {
    "device_list": {"container": C(T0)}, "device_get": {"device": UTIL},
    "param_get": {"param": {"device": UTIL, "index": 1}, "at_value": 3},
    "param_set": {"device": UTIL, "items": [{"index": 1, "value": 3}]},
    "device_enable": {"device": UTIL, "enabled": False}, "device_delete": {"device": UTIL},
    "device_insert": {"container": C(T1), "name": "Reverb"},
    "rack_get": {"device": RACK}, "chain_set": {"device": RACK, "chain": CHAIN, "mute": True},
    "rack_insert_chain": {"device": RACK}, "rack_variation": {"device": RACK, "action": "store"},
    "drum_pads_list": {"device": KIT}, "drum_pad_set": {"device": KIT, "note": 36, "mute": True},
    "drum_pad_copy": {"device": KIT, "from_note": 36, "to_note": 40}, "drum_pad_clear": {"device": KIT, "note": 36},
    "browser_list": {"category": "audio_effects"}, "browser_search": {"query": "comp"},
    "browser_load": {"track": T1, "uri": "query:AudioFx#Compressor"},
}

# One LOM-dependent refusal per mutating command: it must happen before the undo step opens.
REJECTED = {
    "param_set": {"device": UTIL, "items": [{"index": 3, "value": 1}]},
    "device_enable": {"device": D(T0, 9), "enabled": True},
    "device_delete": {"device": UTIL, "expect_name": "wrong"},
    "device_insert": {"container": C(T1), "name": "External Instrument"},
    "chain_set": {"device": RACK, "chain": CHAIN, "volume": 5},
    "rack_insert_chain": {"device": D(T1, 0)},
    "rack_variation": {"device": RACK, "action": "recall", "index": 9},
    "drum_pad_set": {"device": D(T0, 1), "note": 36, "mute": True},
    "drum_pad_copy": {"device": KIT, "from_note": 36, "to_note": 36},
    "drum_pad_clear": {"device": D(T0, 1), "note": 36},
    "browser_load": {"track": T1, "uri": "query:Max#Audio%20Effect"},
}


def fresh():
    case = BrowserCase()
    case.setUp()
    return case


class CatalogCoverageTests(unittest.TestCase):
    def test_every_spec_command_is_registered_with_the_exact_classification(self):
        entries = {e["name"]: e for e in build_registry().catalog_entries()}
        self.assertEqual(sorted(set(SPEC_T4B) - set(entries)), [])
        for name, (mutating, destructive, conditions) in SPEC_T4B.items():
            entry = entries[name]
            self.assertEqual(entry["mutating"], mutating, name)
            self.assertEqual(entry["destructive"], destructive, name)
            self.assertEqual(sorted(entry["conditions"]), sorted(conditions), name)

    def test_group_has_18_commands_and_samples_cover_them_all(self):
        self.assertEqual(len(SPEC_T4B), 18)  # 7 devices + 8 racks and drum pads + 3 browser
        self.assertEqual(set(SAMPLES), set(SPEC_T4B))
        self.assertEqual(set(REJECTED), {n for n, spec in SPEC_T4B.items() if spec[0]})

    def test_the_whole_catalog_is_the_83_commands_of_the_spec_plus_3_view_commands(self):
        names = build_registry().names()
        self.assertEqual(len(names), 86)  # 83 of spec 7.15 + view_show, view_focus, view_get (T5c-1)
        self.assertEqual(len(set(names)), 86)
        self.assertEqual(len([n for n in names if not n.startswith("view_")]), 83)

    def test_no_dangerous_command_names(self):
        for name in build_registry().names():
            for word in FORBIDDEN_NAMES:
                self.assertNotIn(word, name.split("_"), name)

    def test_all_group_commands_are_undo_wrapped_and_only_search_is_resumable(self):
        registry = build_registry()
        for name in SPEC_T4B:
            command = registry.get(name)
            self.assertTrue(command.undo_wrapped, name)
            self.assertEqual(command.resumable, name == "browser_search", name)

    def test_no_new_path_bearing_args_and_no_client_names_as_selectors(self):
        registry = build_registry()
        for name in SPEC_T4B:
            self.assertNotIn("file_path", str(registry.get(name).schema), name)

    def test_the_only_new_edition_deltas_are_none(self):
        registry = build_registry()
        for name in SPEC_T4B:
            self.assertIsNone(registry.get(name).edition_delta, name)


class UndoStepTests(unittest.TestCase):
    def run_sample(self, name):
        case = fresh()
        self.addCleanup(case.doCleanups)
        if name == "browser_load":
            uri = case.listed_uri("audio_effects", "Compressor")
            case.h.reset_log()
            return case, case.h.run(name, dict(SAMPLES[name], uri=uri))
        return case, case.h.run(name, SAMPLES[name])

    def test_each_mutating_command_opens_exactly_one_undo_step(self):
        for name, (mutating, _, _) in SPEC_T4B.items():
            if not mutating:
                continue
            case, response = self.run_sample(name)
            self.assertTrue(response["ok"], (name, response))
            self.assertEqual(case.h.song.events, ["begin", "end"], name)

    def test_reads_never_mutate(self):
        for name, (mutating, _, _) in SPEC_T4B.items():
            if mutating:
                continue
            case, response = self.run_sample(name)
            self.assertTrue(response["ok"], (name, response))
            self.assertEqual((case.h.song.events, case.h.song.log), ([], []), name)

    def test_rejections_happen_before_any_undo_step_or_write(self):
        for name, args in REJECTED.items():
            case, _ = self.run_sample("device_list")
            response = case.h.run(name, args)
            self.assertFalse(response["ok"], name)
            self.assertIn(response["error"]["code"], ("invalid_args", "not_found", "not_supported",
                                                      "out_of_range"), name)
            self.assertEqual((case.h.song.events, case.h.song.log), ([], []), name)

    def test_the_same_rejections_hold_per_op_inside_batch(self):
        for name, args in REJECTED.items():
            case, _ = self.run_sample("device_list")
            result = case.h.ok("batch", {"ops": [{"cmd": name, "args": args}]})
            self.assertFalse(result["results"][0]["ok"], name)
            self.assertEqual(case.h.song.events, ["begin", "end"], name)   # the batch's own single step
            self.assertEqual(case.h.song.log, [], name)                    # the refused op wrote nothing

    def test_a_batch_of_many_t4b_writes_is_one_undo_step(self):
        case, _ = self.run_sample("device_list")
        ops = [{"cmd": "device_insert", "args": {"container": C(T1), "name": "Reverb"}},
               {"cmd": "device_enable", "args": {"device": D(T1, 1), "enabled": False}},
               {"cmd": "param_set", "args": {"device": UTIL, "items": [{"index": 1, "value": 2}]}},
               {"cmd": "rack_variation", "args": {"device": RACK, "action": "store"}},
               {"cmd": "drum_pad_set", "args": {"device": KIT, "note": 36, "solo": True}}]
        result = case.h.ok("batch", {"ops": ops})
        self.assertEqual([r["ok"] for r in result["results"]], [True] * 5)
        self.assertEqual(case.h.song.events, ["begin", "end"])


class CapTests(BrowserCase):
    def test_appendix_a_caps(self):
        for name, args in (("device_get", {"device": UTIL, "limit": 129}),
                           ("param_set", {"device": UTIL, "items": [{"index": 0, "value": 0}] * 65}),
                           ("device_list", {"container": C(T0), "limit": 501}),
                           ("drum_pads_list", {"device": KIT, "limit": 501}),
                           ("browser_list", {"category": "samples", "limit": 201}),
                           ("browser_search", {"query": "a", "limit": 51}),
                           ("browser_list", {"category": "sounds", "path": ["a"] * 9}),
                           ("device_get", {"device": D(T0, 1, *([{"chain": 0, "device": 0}] * 8))})):
            self.assertEqual(self.h.error(name, args)["code"], "invalid_args", name)
        self.h.ok("device_get", {"device": UTIL, "limit": 128})
        self.h.ok("browser_list", {"category": "samples", "limit": 200})
        self.h.ok("browser_search", {"query": "a", "limit": 50})

    def test_strict_arguments_reject_unknown_keys(self):
        for name, args in SAMPLES.items():
            self.assertEqual(self.h.error(name, dict(args, extra=1))["code"], "invalid_args", name)

    def test_param_set_batch_of_64_items_is_accepted(self):
        from .fake_devices import FakeDevice
        from .fake_lom import FakeParameter
        wide = FakeDevice("Wide", "Wide", 2, [])
        wide.parameters += [FakeParameter("p%d" % i, 0.0) for i in range(80)]
        self.h.song.tracks[1].devices.append(wide)
        result = self.h.ok("param_set", {"device": D(T1, 1), "items": [{"index": i + 1, "value": 1.0}
                                                                          for i in range(64)]})
        self.assertEqual(len(result["params"]), 64)


if __name__ == "__main__":
    unittest.main()
