"""T4b racks, chains and drum pads (docs/01-protocol.md section 7.9)."""

import unittest

from .device_world import D, T0, T1, T2, DeviceCase, RACK
from .fake_devices import FakeChain, FakeDevice, FakeRack, FakeRackNoInsertChain

RACK_REF = D(T0, RACK)
KIT_REF = D(T2, 0)
COMPRESSOR_REF = D(T1, 0)
CHAIN_A = {"kind": "chain", "index": 0}
RETURN_CHAIN = {"kind": "return_chain", "index": 0}


class RackGetTests(DeviceCase):
    def test_describes_chains_return_chains_and_variations(self):
        result = self.h.ok("rack_get", {"device": RACK_REF})
        self.assertEqual([c["name"] for c in result["chains"]], ["Chain A", "Chain B"])
        self.assertEqual([c["name"] for c in result["return_chains"]], ["Return Chain"])
        self.assertEqual((result["macro_count"], result["variation_count"], result["selected_variation"]),
                         (8, 2, 0))
        self.assertIs(result["can_have_drum_pads"], False)
        first = result["chains"][0]
        self.assertEqual((first["index"], first["device_count"], first["mute"], first["solo"]), (0, 2, False, False))
        self.assertEqual(first["color"], 0x445566)
        self.assertEqual(first["volume"]["display"], "0.0 dB")
        self.assertEqual(first["volume"]["volume_db"], 0.0)
        self.assertEqual((first["volume"]["min"], first["volume"]["max"]), (0.0, 1.0))
        self.assertEqual(first["pan"]["display"], "C")
        self.assertEqual(result["return_chains"][0]["device_count"], 1)
        self.assertNoSideEffects()

    def test_drum_rack_and_non_racks(self):
        self.assertIs(self.h.ok("rack_get", {"device": KIT_REF})["can_have_drum_pads"], True)
        error = self.h.error("rack_get", {"device": COMPRESSOR_REF})
        self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "not_a_rack"))
        self.assertEqual(self.h.error("rack_get", {"device": D(T0, 9)})["code"], "not_found")

    def test_chain_names_are_cleaned(self):
        self.h.song.tracks[0].devices[RACK].chains[0].name = "A\u0007" + "x" * 300
        name = self.h.ok("rack_get", {"device": RACK_REF})["chains"][0]["name"]
        self.assertEqual(len(name), 128)
        self.assertNotIn("\u0007", name)


class ChainSetTests(DeviceCase):
    def chain(self, which=0):
        return self.h.song.tracks[0].devices[RACK].chains[which]

    def test_sets_every_field_in_one_undo_step(self):
        result = self.h.ok("chain_set", {"device": RACK_REF, "chain": CHAIN_A, "name": "Lead", "color": 255,
                                         "mute": True, "solo": True, "volume": 0.5, "pan": -0.5})
        info = result["chain"]
        self.assertEqual((info["name"], info["color"], info["mute"], info["solo"]), ("Lead", 255, True, True))
        self.assertEqual(info["volume"]["value"], 0.5)
        self.assertEqual(info["pan"]["value"], -0.5)
        self.assertEqual(info["index"], 0)
        chain = self.chain()
        self.assertEqual((chain.name, chain.color, chain.mute, chain.solo), ("Lead", 255, True, True))
        self.assertEqual(chain.mixer_device.volume.value, 0.5)
        self.assertOneUndoStep()

    def test_return_chain(self):
        self.h.ok("chain_set", {"device": RACK_REF, "chain": RETURN_CHAIN, "mute": True})
        self.assertIs(self.h.song.tracks[0].devices[RACK].return_chains[0].mute, True)

    def test_volume_db_maps_through_the_display_like_mixer_set(self):
        result = self.h.ok("chain_set", {"device": RACK_REF, "chain": CHAIN_A, "volume_db": -6.0})
        self.assertAlmostEqual(result["chain"]["volume"]["volume_db"], -6.0, delta=0.1)
        error = self.h.error("chain_set", {"device": RACK_REF, "chain": CHAIN_A, "volume_db": 20})
        self.assertEqual(error["code"], "out_of_range")
        error = self.h.error("chain_set", {"device": RACK_REF, "chain": CHAIN_A, "volume": 0.5, "volume_db": -6})
        self.assertEqual(error["code"], "invalid_args")

    def test_invalid_requests_change_nothing_and_open_no_undo_step(self):
        cases = [
            ({"chain": CHAIN_A}, "invalid_args"),
            ({"chain": CHAIN_A, "volume": 1.5}, "out_of_range"),
            ({"chain": CHAIN_A, "pan": 2}, "out_of_range"),
            ({"chain": {"kind": "chain", "index": 9}, "mute": True}, "not_found"),
            ({"chain": {"kind": "return_chain", "index": 9}, "mute": True}, "not_found"),
            ({"chain": {"kind": "other", "index": 0}, "mute": True}, "invalid_args"),
            ({"chain": CHAIN_A, "color": 1 << 24}, "invalid_args"),
            ({"chain": CHAIN_A, "mute": 1}, "invalid_args"),
            ({"chain": CHAIN_A, "name": "x" * 129}, "invalid_args"),
        ]
        for extra, code in cases:
            args = dict({"device": RACK_REF}, **extra)
            self.assertEqual(self.h.error("chain_set", args)["code"], code, extra)
            self.assertNoSideEffects()

    def test_failed_volume_does_not_apply_the_other_fields(self):
        self.h.error("chain_set", {"device": RACK_REF, "chain": CHAIN_A, "name": "Nope", "volume": 9})
        self.assertEqual(self.chain().name, "Chain A")

    def test_not_a_rack(self):
        error = self.h.error("chain_set", {"device": COMPRESSOR_REF, "chain": CHAIN_A, "mute": True})
        self.assertEqual(self.reason(error), "not_a_rack")

    def test_batch_path_repeats_the_check(self):
        error = self.batch_error("chain_set", {"device": RACK_REF, "chain": CHAIN_A, "volume": 3})
        self.assertEqual(error["code"], "out_of_range")
        self.assertEqual(self.h.song.log, [])


class RackInsertChainTests(DeviceCase):
    def test_appends_by_default_and_returns_the_new_chain(self):
        result = self.h.ok("rack_insert_chain", {"device": RACK_REF})
        self.assertEqual(result["chain"]["index"], 2)
        self.assertEqual(len(self.h.song.tracks[0].devices[RACK].chains), 3)
        self.assertOneUndoStep()

    def test_inserts_at_an_index(self):
        result = self.h.ok("rack_insert_chain", {"device": RACK_REF, "index": 0})
        self.assertEqual(result["chain"]["index"], 0)
        self.assertEqual(self.h.song.tracks[0].devices[RACK].chains[1].name, "Chain A")

    def test_bad_index_and_non_rack(self):
        self.assertEqual(self.h.error("rack_insert_chain", {"device": RACK_REF, "index": 3})["code"],
                         "out_of_range")
        self.assertEqual(self.h.error("rack_insert_chain", {"device": RACK_REF, "index": -2})["code"],
                         "invalid_args")
        self.assertEqual(self.reason(self.h.error("rack_insert_chain", {"device": COMPRESSOR_REF})),
                         "not_a_rack")
        self.assertNoSideEffects()

    def test_older_live_without_insert_chain_is_not_supported(self):
        old = FakeRackNoInsertChain("Old", [FakeChain("Only")])
        self.h.song.tracks[1].devices.append(old)
        from .fake_devices import attach
        attach(self.h.song, old)
        self.h.reset_log()
        error = self.h.error("rack_insert_chain", {"device": D(T1, 1)})
        self.assertEqual((error["code"], self.reason(error)), ("not_supported", "live_version"))
        self.assertNoSideEffects()


class RackVariationTests(DeviceCase):
    def rack(self):
        return self.h.song.tracks[0].devices[RACK]

    def test_store_adds_a_variation(self):
        result = self.h.ok("rack_variation", {"device": RACK_REF, "action": "store"})
        self.assertEqual(result, {"variation_count": 3, "selected_variation": 2})
        self.assertOneUndoStep()

    def test_recall_selects_then_recalls(self):
        result = self.h.ok("rack_variation", {"device": RACK_REF, "action": "recall", "index": 1})
        self.assertEqual(result, {"variation_count": 2, "selected_variation": 1})
        self.assertEqual(self.rack().macro_log, [("recall", 1)])

    def test_delete_removes_the_indexed_variation(self):
        result = self.h.ok("rack_variation", {"device": RACK_REF, "action": "delete", "index": 0})
        self.assertEqual(result["variation_count"], 1)

    def test_randomize(self):
        self.h.ok("rack_variation", {"device": RACK_REF, "action": "randomize"})
        self.assertEqual(self.rack().macro_log, [("randomize", None)])

    def test_index_rules(self):
        for action in ("recall", "delete"):
            self.assertEqual(self.reason(self.h.error("rack_variation", {"device": RACK_REF, "action": action})),
                             "index_required")
            self.assertEqual(self.h.error("rack_variation", {"device": RACK_REF, "action": action,
                                                             "index": 2})["code"], "out_of_range")
        for action in ("store", "randomize"):
            self.assertEqual(self.reason(self.h.error("rack_variation", {"device": RACK_REF, "action": action,
                                                                         "index": 0})), "index_not_allowed")
        self.assertEqual(self.h.error("rack_variation", {"device": RACK_REF, "action": "other"})["code"],
                         "invalid_args")
        self.assertNoSideEffects()
        self.assertEqual(self.rack().variation_count, 2)

    def test_recall_with_no_variations_is_out_of_range(self):
        self.rack().variation_count = 0
        self.assertEqual(self.h.error("rack_variation", {"device": RACK_REF, "action": "recall",
                                                         "index": 0})["code"], "out_of_range")

    def test_not_a_rack_and_unsupported_live(self):
        self.assertEqual(self.reason(self.h.error("rack_variation", {"device": COMPRESSOR_REF,
                                                                     "action": "store"})), "not_a_rack")
        plain = FakeRack("Plain")
        plain.store_variation = None
        self.h.song.tracks[1].devices.append(plain)
        from .fake_devices import attach
        attach(self.h.song, plain)
        error = self.h.error("rack_variation", {"device": D(T1, 1), "action": "store"})
        self.assertEqual((error["code"], self.reason(error)), ("not_supported", "live_version"))


class DrumPadTests(DeviceCase):
    def kit(self):
        return self.h.song.tracks[2].devices[0]

    def test_list_defaults_to_pads_with_chains(self):
        result = self.h.ok("drum_pads_list", {"device": KIT_REF})
        self.assertEqual([i["note"] for i in result["items"]], [36, 38])
        self.assertEqual(result["items"][0], {"note": 36, "name": "Pad 36", "mute": False, "solo": False,
                                              "chain_count": 1})
        self.assertEqual(result["total"], 2)
        self.assertNoSideEffects()

    def test_list_all_pages_through_128_pads(self):
        page = self.h.ok("drum_pads_list", {"device": KIT_REF, "all": True})
        self.assertEqual((len(page["items"]), page["total"], page["next_offset"]), (100, 128, 100))
        rest = self.h.ok("drum_pads_list", {"device": KIT_REF, "all": True, "offset": 100})
        self.assertEqual((len(rest["items"]), rest["next_offset"]), (28, None))
        self.assertEqual(rest["items"][-1]["note"], 127)

    def test_not_a_drum_rack(self):
        for command, extra in (("drum_pads_list", {}), ("drum_pad_set", {"note": 36, "mute": True}),
                               ("drum_pad_copy", {"from_note": 36, "to_note": 40}),
                               ("drum_pad_clear", {"note": 36})):
            error = self.h.error(command, dict({"device": D(T0, RACK)}, **extra))
            self.assertEqual((error["code"], self.reason(error)), ("invalid_args", "not_a_drum_rack"), command)
        self.assertNoSideEffects()

    def test_set_mute_and_solo(self):
        result = self.h.ok("drum_pad_set", {"device": KIT_REF, "note": 36, "mute": True, "solo": True})
        self.assertEqual(result["pad"], {"note": 36, "name": "Pad 36", "mute": True, "solo": True,
                                         "chain_count": 1})
        self.assertEqual((self.kit().drum_pads[36].mute, self.kit().drum_pads[36].solo), (True, True))
        self.assertOneUndoStep()

    def test_set_validation(self):
        for args in ({"note": 36}, {"note": 128, "mute": True}, {"note": -1, "mute": True},
                     {"note": 36, "mute": "yes"}):
            self.assertEqual(self.h.error("drum_pad_set", dict({"device": KIT_REF}, **args))["code"],
                             "invalid_args", args)
        self.assertNoSideEffects()

    def test_copy_overwrites_the_target(self):
        result = self.h.ok("drum_pad_copy", {"device": KIT_REF, "from_note": 36, "to_note": 38})
        self.assertEqual(result["pad"]["note"], 38)
        self.assertEqual([c.devices[0].name for c in self.kit().drum_pads[38].chains], ["Compressor"])
        self.assertOneUndoStep()

    def test_copy_into_an_empty_pad(self):
        self.h.ok("drum_pad_copy", {"device": KIT_REF, "from_note": 38, "to_note": 40})
        self.assertEqual(len(self.kit().drum_pads[40].chains), 1)

    def test_copy_validation(self):
        for args in ({"from_note": 36, "to_note": 36}, {"from_note": 36, "to_note": 128},
                     {"from_note": -1, "to_note": 3}, {"from_note": 36}):
            self.assertEqual(self.h.error("drum_pad_copy", dict({"device": KIT_REF}, **args))["code"],
                             "invalid_args", args)
        self.assertNoSideEffects()

    def test_clear_removes_all_chains(self):
        self.assertEqual(self.h.ok("drum_pad_clear", {"device": KIT_REF, "note": 36}), {})
        self.assertEqual(self.kit().drum_pads[36].chains, [])
        self.assertEqual(self.kit().drum_pads[38].chains[0].name, "Pad 38")
        self.assertOneUndoStep()

    def test_batch_path_repeats_the_check(self):
        error = self.batch_error("drum_pad_copy", {"device": KIT_REF, "from_note": 5, "to_note": 5})
        self.assertEqual(error["code"], "invalid_args")
        self.assertEqual(self.h.song.log, [])


if __name__ == "__main__":
    unittest.main()
