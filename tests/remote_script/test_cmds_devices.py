"""T4b devices and parameters (docs/01-protocol.md section 7.8)."""

import unittest

from .device_world import (C, D, M, R0, T0, T1, T2, UTILITY0, DeviceCase, world)
from .fake_devices import (FakeChain, FakeChainNoDelete, FakeDevice, FakeRack, external_device, max_device,
                           plugin_device, rack_hiding)

GAIN, MODE, LOCKED = 1, 2, 3          # Utility parameter indexes
UTIL = D(T0, UTILITY0)                # the Utility on track 0
CHAIN_UTIL = D(T0, 1, {"chain": 0, "device": 1})
STEP_A = {"chain": 0}


class DeviceListTests(DeviceCase):
    def test_lists_the_track_chain_with_device_info(self):
        result = self.h.ok("device_list", {"container": C(T0)})
        self.assertEqual([i["name"] for i in result["items"]], ["Operator", "FX Rack", "Utility"])
        self.assertEqual(result["total"], 3)
        self.assertIsNone(result["next_offset"])
        first, rack, util = result["items"]
        self.assertEqual(first["path"], [0])
        self.assertEqual(first["class_name"], "UltraAnalog")
        self.assertEqual(first["type"], "instrument")
        self.assertIs(first["is_active"], True)
        self.assertIs(first["can_have_chains"], False)
        self.assertEqual(first["parameter_count"], 2)
        self.assertIs(rack["can_have_chains"], True)
        self.assertEqual(util["path"], [2])
        self.assertNoSideEffects()

    def test_lists_a_chain_container_with_paths_that_resolve_back(self):
        result = self.h.ok("device_list", {"container": C(T0, 1, STEP_A)})
        self.assertEqual([i["name"] for i in result["items"]], ["Compressor", "Utility"])
        self.assertEqual(result["items"][1]["path"], [1, {"chain": 0, "device": 1}])
        again = self.h.ok("device_get", {"device": D(T0, *result["items"][1]["path"])})
        self.assertEqual(again["device"]["name"], "Utility")

    def test_lists_return_chain_and_drum_pad_containers(self):
        self.assertEqual(self.names(T0, 1, {"return_chain": 0}), ["Reverb"])
        self.assertEqual(self.names(T2, 0, {"drum_pad": 36, "chain": 0}), ["Compressor"])
        pad = self.h.ok("device_list", {"container": C(T2, 0, {"drum_pad": 38, "chain": 0})})
        self.assertEqual(pad["items"][0]["path"], [0, {"drum_pad": 38, "chain": 0, "device": 0}])

    def test_lists_return_and_master_tracks(self):
        self.assertEqual(self.names(R0), ["Reverb"])
        self.assertEqual(self.names(M), ["Master Utility"])

    def test_empty_container_and_paging(self):
        self.assertEqual(self.h.ok("device_list", {"container": C(T0, 1, {"chain": 1})})["items"], [])
        page = self.h.ok("device_list", {"container": C(T0), "limit": 2})
        self.assertEqual((len(page["items"]), page["total"], page["next_offset"]), (2, 3, 2))
        rest = self.h.ok("device_list", {"container": C(T0), "limit": 2, "offset": 2})
        self.assertEqual([i["name"] for i in rest["items"]], ["Utility"])
        self.assertIsNone(rest["next_offset"])

    def test_missing_targets_are_not_found(self):
        self.assertEqual(self.h.error("device_list", {"container": C(T0, 9, STEP_A)})["code"], "not_found")
        self.assertEqual(self.h.error("device_list", {"container": C(T0, 1, {"chain": 7})})["code"],
                         "not_found")
        self.assertEqual(self.h.error("device_list", {"container": C(T0, 1, {"return_chain": 3})})["code"],
                         "not_found")
        self.assertEqual(self.h.error("device_list",
                                      {"container": C(T2, 0, {"drum_pad": 99, "chain": 0})})["code"],
                         "not_found")
        self.assertEqual(self.h.error("device_list", {"container": C({"kind": "track", "index": 9})})["code"],
                         "not_found")

    def test_malformed_container_paths_are_invalid(self):
        for path in ([STEP_A], [1, {"chain": 0, "device": 0}, {"chain": 0}, 4],
                     [1, STEP_A, {"chain": 0, "device": 0}], [1, {"chain": 0, "device": 0}], [0]):
            error = self.h.error("device_list", {"container": C(T0, *path)})
            self.assertEqual(error["code"], "invalid_args", path)
        long_path = [1] + [{"chain": 0, "device": 0}] * 8
        self.assertEqual(self.h.error("device_list", {"container": C(T0, *long_path)})["code"],
                         "invalid_args")
        self.assertEqual(self.h.error("device_list", {})["code"], "invalid_args")

    def test_expect_name_guard_on_the_track(self):
        track = dict(T0, expect_name="nope")
        self.assertEqual(self.reason(self.h.error("device_list", {"container": C(track)})), "name_mismatch")

    def test_device_names_from_live_are_cleaned_and_capped(self):
        self.h.song.tracks[0].devices[0].name = "Op\u0007‮X" + "y" * 200
        name = self.h.ok("device_list", {"container": C(T0)})["items"][0]["name"]
        self.assertEqual(len(name), 128)
        self.assertNotIn("\u0007", name)
        self.assertNotIn("‮", name)


class DeviceGetTests(DeviceCase):
    def test_returns_device_and_parameters(self):
        result = self.h.ok("device_get", {"device": UTIL})
        self.assertEqual(result["device"]["name"], "Utility")
        self.assertEqual(result["device"]["path"], [UTILITY0])
        self.assertEqual(result["total"], 4)
        self.assertIsNone(result["next_offset"])
        on, gain, mode, locked = result["parameters"]
        self.assertEqual([p["index"] for p in result["parameters"]], [0, 1, 2, 3])
        self.assertEqual(on["name"], "Device On")
        self.assertEqual(gain["name"], "Gain")
        self.assertEqual((gain["value"], gain["min"], gain["max"], gain["default"]), (0.0, -35.0, 35.0, 0.0))
        self.assertEqual(gain["display"], "0.0 dB")
        self.assertIs(gain["is_quantized"], False)
        self.assertIsNone(gain["value_items"])
        self.assertIs(gain["is_enabled"], True)
        self.assertEqual(gain["automation_state"], "none")
        self.assertIs(mode["is_quantized"], True)
        self.assertEqual(mode["value_items"], ["Stereo", "Mono", "Mid/Side"])
        self.assertIs(locked["is_enabled"], False)
        self.assertNoSideEffects()

    def test_nested_device_and_paging_of_parameters(self):
        result = self.h.ok("device_get", {"device": CHAIN_UTIL, "limit": 2, "offset": 1})
        self.assertEqual([p["index"] for p in result["parameters"]], [1, 2])
        self.assertEqual((result["total"], result["next_offset"]), (4, 3))
        self.assertEqual(result["device"]["path"], [1, {"chain": 0, "device": 1}])

    def test_limit_is_capped_at_128(self):
        self.assertEqual(self.h.error("device_get", {"device": UTIL, "limit": 129})["code"], "invalid_args")
        many = FakeDevice("Wide", "Wide", 2, [])
        from .fake_lom import FakeParameter
        many.parameters += [FakeParameter("p%d" % i, 0.0) for i in range(200)]
        self.h.song.tracks[1].devices.append(many)
        result = self.h.ok("device_get", {"device": D(T1, 1)})
        self.assertEqual(len(result["parameters"]), 128)
        self.assertEqual((result["total"], result["next_offset"]), (201, 128))

    def test_missing_device_is_not_found(self):
        self.assertEqual(self.h.error("device_get", {"device": D(T0, 9)})["code"], "not_found")
        self.assertEqual(self.h.error("device_get", {"device": D(T0, 1, {"chain": 0, "device": 9})})["code"],
                         "not_found")

    def test_unknown_automation_state_reads_as_null(self):
        self.h.song.tracks[0].devices[0].parameters[1].automation_state = 7
        result = self.h.ok("device_get", {"device": D(T0, 0)})
        self.assertIsNone(result["parameters"][1]["automation_state"])


class ParamGetTests(DeviceCase):
    def test_device_parameter(self):
        result = self.h.ok("param_get", {"param": {"device": UTIL, "index": GAIN}})
        self.assertEqual((result["index"], result["name"], result["value"]), (GAIN, "Gain", 0.0))
        self.assertEqual(result["display"], "0.0 dB")
        self.assertIsNone(result["display_at_value"])

    def test_at_value_adds_display_without_writing(self):
        result = self.h.ok("param_get", {"param": {"device": UTIL, "index": GAIN}, "at_value": 12.0})
        self.assertEqual(result["display_at_value"], "12.0 dB")
        self.assertEqual(result["value"], 0.0)
        self.assertNoSideEffects()
        self.assertEqual(self.h.song.tracks[0].devices[UTILITY0].parameters[GAIN].value, 0.0)

    def test_at_value_outside_the_range_is_out_of_range(self):
        error = self.h.error("param_get", {"param": {"device": UTIL, "index": GAIN}, "at_value": 99})
        self.assertEqual(error["code"], "out_of_range")

    def test_mixer_parameters_use_the_same_shape(self):
        volume = self.h.ok("param_get", {"param": {"mixer": "volume", "track": T0}, "at_value": 1.0})
        self.assertEqual(volume["display"], "0.0 dB")
        self.assertEqual(volume["display_at_value"], "6.0 dB")
        self.assertIsNone(volume["index"])
        send = self.h.ok("param_get", {"param": {"mixer": "send", "track": T0, "index": 0}})
        self.assertEqual(send["index"], 0)

    def test_missing_parameter_is_not_found(self):
        self.assertEqual(self.h.error("param_get", {"param": {"device": UTIL, "index": 9}})["code"],
                         "not_found")

    def test_at_value_must_be_a_number(self):
        for bad in (True, "1"):
            self.assertEqual(self.h.error("param_get", {"param": {"device": UTIL, "index": GAIN},
                                                      "at_value": bad})["code"], "invalid_args")


class ParamSetTests(DeviceCase):
    def test_items_form_sets_values_in_one_undo_step(self):
        result = self.h.ok("param_set", {"device": UTIL, "items": [
            {"index": GAIN, "value": 3.5}, {"index": MODE, "value": 1}]})
        self.assertEqual([p["value"] for p in result["params"]], [3.5, 1.0])
        self.assertEqual(result["params"][0]["display"], "3.5 dB")
        self.assertEqual(self.h.song.tracks[0].devices[UTILITY0].parameters[GAIN].value, 3.5)
        self.assertOneUndoStep()

    def test_param_form_on_a_device_and_on_the_mixer(self):
        result = self.h.ok("param_set", {"param": {"device": UTIL, "index": GAIN}, "value": -2.0})
        self.assertEqual(result["params"][0]["value"], -2.0)
        result = self.h.ok("param_set", {"param": {"mixer": "pan", "track": T1}, "value": 0.5})
        self.assertEqual(self.h.song.tracks[1].mixer_device.panning.value, 0.5)
        self.assertEqual(result["params"][0]["display"], "25R")

    def test_nested_device(self):
        self.h.ok("param_set", {"device": CHAIN_UTIL, "items": [{"index": GAIN, "value": 1.0}]})
        self.assertEqual(self.h.song.tracks[0].devices[1].chains[0].devices[1].parameters[GAIN].value, 1.0)

    def test_out_of_range_is_rejected_before_any_write_or_undo_step(self):
        error = self.h.error("param_set", {"device": UTIL, "items": [
            {"index": GAIN, "value": 1.0}, {"index": MODE, "value": 9}]})
        self.assertEqual(error["code"], "out_of_range")
        self.assertNoSideEffects()
        self.assertEqual(self.h.song.tracks[0].devices[UTILITY0].parameters[GAIN].value, 0.0)

    def test_quantized_parameters_need_integer_values(self):
        error = self.h.error("param_set", {"device": UTIL, "items": [{"index": MODE, "value": 1.5}]})
        self.assertEqual(error["code"], "invalid_args")
        self.assertEqual(self.reason(error), "quantized_needs_integer")
        self.assertNoSideEffects()
        self.h.ok("param_set", {"device": UTIL, "items": [{"index": MODE, "value": 2.0}]})

    def test_disabled_parameters_are_refused(self):
        error = self.h.error("param_set", {"device": UTIL, "items": [{"index": LOCKED, "value": 1.0}]})
        self.assertEqual(error["code"], "invalid_args")
        self.assertEqual(self.reason(error), "parameter_disabled")
        self.assertNoSideEffects()

    def test_unknown_and_duplicate_indexes(self):
        error = self.h.error("param_set", {"device": UTIL, "items": [{"index": 9, "value": 0}]})
        self.assertEqual(error["code"], "not_found")
        error = self.h.error("param_set", {"device": UTIL, "items": [
            {"index": GAIN, "value": 1.0}, {"index": GAIN, "value": 2.0}]})
        self.assertEqual(self.reason(error), "duplicate_index")
        self.assertNoSideEffects()

    def test_exactly_one_form_is_required(self):
        param = {"device": UTIL, "index": GAIN}
        for args in ({}, {"device": UTIL}, {"param": param}, {"device": UTIL, "param": param},
                     {"device": UTIL, "items": [{"index": GAIN, "value": 1}], "value": 1},
                     {"param": param, "value": 1, "items": [{"index": GAIN, "value": 1}]}):
            self.assertEqual(self.h.error("param_set", args)["code"], "invalid_args", args)

    def test_item_count_and_value_types(self):
        too_many = [{"index": 0, "value": 0}] * 65
        self.assertEqual(self.h.error("param_set", {"device": UTIL, "items": too_many})["code"], "invalid_args")
        self.assertEqual(self.h.error("param_set", {"device": UTIL, "items": []})["code"], "invalid_args")
        for bad in (True, "1", None):
            self.assertEqual(self.h.error("param_set", {"param": {"device": UTIL, "index": GAIN},
                                                      "value": bad})["code"], "invalid_args")

    def test_batch_checks_each_op_when_it_runs(self):
        error = self.batch_error("param_set", {"device": UTIL, "items": [{"index": LOCKED, "value": 1.0}]})
        self.assertEqual(self.reason(error), "parameter_disabled")
        self.assertEqual(self.h.song.log, [])


class DeviceEnableTests(DeviceCase):
    def test_disables_and_enables_through_device_on(self):
        result = self.h.ok("device_enable", {"device": UTIL, "enabled": False})
        self.assertIs(result["device"]["is_active"], False)
        self.assertEqual(self.h.song.tracks[0].devices[UTILITY0].parameters[0].value, 0.0)
        self.assertOneUndoStep()
        self.assertIs(self.h.ok("device_enable", {"device": UTIL, "enabled": True})["device"]["is_active"], True)

    def test_device_without_device_on_in_slot_zero_is_not_found(self):
        self.h.song.tracks[1].devices[0].parameters[0].name = "Gain"
        self.h.reset_log()
        error = self.h.error("device_enable", {"device": D(T1, 0), "enabled": False})
        self.assertEqual(error["code"], "not_found")
        self.assertNoSideEffects()

    def test_nested_device_and_argument_types(self):
        self.h.ok("device_enable", {"device": CHAIN_UTIL, "enabled": False})
        self.assertEqual(self.h.song.tracks[0].devices[1].chains[0].devices[1].parameters[0].value, 0.0)
        for bad in (0, "yes", None):
            self.assertEqual(self.h.error("device_enable", {"device": UTIL, "enabled": bad})["code"],
                             "invalid_args")
        self.assertEqual(self.h.error("device_enable", {"device": D(T0, 9), "enabled": True})["code"],
                         "not_found")


class DeviceDeleteTests(DeviceCase):
    def test_deletes_a_track_device_in_one_undo_step(self):
        result = self.h.ok("device_delete", {"device": UTIL})
        self.assertEqual(result, {"deleted": {"name": "Utility"}})
        self.assertEqual(self.names(T0), ["Operator", "FX Rack"])
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_deletes_a_chain_device(self):
        self.h.ok("device_delete", {"device": CHAIN_UTIL})
        self.assertEqual(self.names(T0, 1, STEP_A), ["Compressor"])

    def test_expect_name_mismatch_is_not_found_before_the_undo_step(self):
        error = self.h.error("device_delete", {"device": UTIL, "expect_name": "Operator"})
        self.assertEqual((error["code"], self.reason(error)), ("not_found", "name_mismatch"))
        self.assertNoSideEffects()
        self.h.ok("device_delete", {"device": UTIL, "expect_name": "Utility"})

    def test_missing_device(self):
        self.assertEqual(self.h.error("device_delete", {"device": D(T0, 7)})["code"], "not_found")
        self.assertNoSideEffects()

    def test_chain_without_device_deletion_is_not_supported(self):
        self.h.song.tracks[0].devices[1].chains[0] = FakeChainNoDelete("Chain A", [FakeDevice("Compressor", "Compressor2"), utility_device()])
        from .fake_devices import attach
        attach(self.h.song, self.h.song.tracks[0].devices[1])
        self.h.reset_log()
        error = self.h.error("device_delete", {"device": CHAIN_UTIL})
        self.assertEqual(error["code"], "not_supported")
        self.assertNoSideEffects()

    def test_batch_path_repeats_the_check(self):
        error = self.batch_error("device_delete", {"device": UTIL, "expect_name": "wrong"})
        self.assertEqual(error["code"], "not_found")
        self.assertEqual(self.h.song.log, [])


def utility_device():
    from .fake_devices import utility
    return utility()


class DeviceInsertTests(DeviceCase):
    def test_inserts_at_the_end_by_default(self):
        result = self.h.ok("device_insert", {"container": C(T1), "name": "Reverb"})
        self.assertEqual(result["device"]["name"], "Reverb")
        self.assertEqual(result["device"]["path"], [1])
        self.assertEqual(self.names(T1), ["Compressor", "Reverb"])
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_inserts_at_an_index(self):
        result = self.h.ok("device_insert", {"container": C(T1), "name": "Reverb", "index": 0})
        self.assertEqual(result["device"]["path"], [0])
        self.assertEqual(self.names(T1), ["Reverb", "Compressor"])
        self.assertEqual(self.h.error("device_insert", {"container": C(T1), "name": "Reverb",
                                                        "index": 5})["code"], "out_of_range")
        self.assertEqual(self.h.error("device_insert", {"container": C(T1), "name": "Reverb",
                                                        "index": -2})["code"], "invalid_args")

    def test_inserts_into_a_chain_and_returns_the_nested_path(self):
        result = self.h.ok("device_insert", {"container": C(T0, 1, {"chain": 1}), "name": "Compressor"})
        self.assertEqual(result["device"]["path"], [1, {"chain": 1, "device": 0}])
        self.assertEqual(self.names(T0, 1, {"chain": 1}), ["Compressor"])
        result = self.h.ok("device_insert", {"container": C(T0, 1, {"return_chain": 0}), "name": "Utility",
                                              "index": 0})
        self.assertEqual(result["device"]["path"], [1, {"return_chain": 0, "device": 0}])

    def test_inserts_into_a_drum_pad_chain(self):
        result = self.h.ok("device_insert", {"container": C(T2, 0, {"drum_pad": 36, "chain": 0}),
                                              "name": "Reverb"})
        self.assertEqual(result["device"]["path"], [0, {"drum_pad": 36, "chain": 0, "device": 1}])

    def test_name_pattern_is_enforced(self):
        for name in ("", "x" * 65, "Reverb;", "Reverb\n", "Rev|erb", "R" * 70):
            self.assertEqual(self.h.error("device_insert", {"container": C(T1), "name": name})["code"],
                             "invalid_args", name)
        self.assertNoSideEffects()

    def test_unknown_built_in_name_is_not_found_and_nothing_changes(self):
        error = self.h.error("device_insert", {"container": C(T1), "name": "No Such Device"})
        self.assertEqual(error["code"], "not_found")
        self.assertEqual(self.names(T1), ["Compressor"])

    def test_external_devices_are_refused_before_the_call(self):
        for name in ("External Audio Effect", "External Instrument", "external audio effect",
                     "EXTERNAL  INSTRUMENT", " External Instrument "):
            error = self.h.error("device_insert", {"container": C(T1), "name": name})
            self.assertEqual((error["code"], self.reason(error)), ("not_supported", "blocked_content"), name)
        self.assertNoSideEffects()
        self.assertEqual(self.names(T1), ["Compressor"])

    def test_max_for_live_names_are_refused_before_the_call(self):
        for name in ("Max Audio Effect", "max instrument", "Max MIDI Effect", "Thing.amxd", "Set.als"):
            error = self.h.error("device_insert", {"container": C(T1), "name": name})
            self.assertEqual((error["code"], self.reason(error)), ("not_supported", "blocked_content"), name)
        self.assertNoSideEffects()

    def test_external_is_refused_inside_batch_too(self):
        error = self.batch_error("device_insert", {"container": C(T1), "name": "External Instrument"})
        self.assertEqual((error["code"], self.reason(error)), ("not_supported", "blocked_content"))
        self.assertEqual(self.h.song.log, [])
        self.assertEqual(self.names(T1), ["Compressor"])

    def test_missing_container_is_not_found(self):
        self.assertEqual(self.h.error("device_insert", {"container": C(T1, 0, {"chain": 0}),
                                                        "name": "Reverb"})["code"], "not_found")
        self.assertNoSideEffects()


class DeviceInsertCleanupTests(DeviceCase):
    """The new device tree is checked after the call (spec 7.8 and 7.10 post-load cleanup)."""

    def hostile(self, name, make):
        self.h.song.device_factories[name] = make

    def assertCleaned(self, name, expect_left):
        error = self.h.error("device_insert", {"container": C(T1), "name": name})
        self.assertEqual((error["code"], self.reason(error)), ("not_supported", "blocked_content"))
        self.assertIs(error["details"]["partial"], True)
        self.assertEqual(self.names(T1), expect_left)

    def test_a_max_device_is_removed_again(self):
        self.hostile("Loop Tool", max_device)
        self.assertCleaned("Loop Tool", ["Compressor"])

    def test_a_plugin_device_is_removed_again_even_with_allow_plugins(self):
        self.h.flags = {"allow_plugins": True, "allow_user_presets": True}
        self.hostile("Serum", plugin_device)
        self.assertCleaned("Serum", ["Compressor"])

    def test_an_external_device_under_an_innocent_name_is_removed_again(self):
        self.hostile("Line Tool", external_device)
        self.assertCleaned("Line Tool", ["Compressor"])

    def test_class_names_are_matched_case_insensitively_and_by_prefix(self):
        for class_name in ("MaxDevice", "maxaudioeffect", "AuPluginDevice", "Vst3PluginDevice"):
            self.hostile("Odd", lambda c=class_name: FakeDevice("Odd", c))
            self.assertCleaned("Odd", ["Compressor"])

    def test_nested_devices_are_removed_from_chains_return_chains_and_drum_pads(self):
        for where in ("chain", "return_chain", "drum_pad"):
            for make in (max_device, plugin_device, external_device):
                self.hostile("Wrapper", lambda w=where, m=make: rack_hiding(m(), w))
                error = self.h.error("device_insert", {"container": C(T1), "name": "Wrapper"})
                self.assertEqual(error["code"], "not_supported", (where, make))
                wrapper = self.h.song.tracks[1].devices[-1]
                self.assertEqual(wrapper.name in ("Hiding Rack", "Hiding Kit"), True)
                self.assertEqual(self.leftovers(wrapper), 0, (where, make))
                del self.h.song.tracks[1].devices[-1]

    def leftovers(self, rack):
        found = 0
        chains = list(rack.chains) + list(rack.return_chains)
        chains += [c for pad in getattr(rack, "drum_pads", []) for c in pad.chains]
        for chain in chains:
            found += len(chain.devices)
        return found

    def test_cleanup_when_the_chain_cannot_delete_removes_the_whole_new_device(self):
        def make():
            rack = rack_hiding(max_device(), "chain")
            rack.chains[0] = FakeChainNoDelete("Inner", rack.chains[0].devices)
            return rack
        self.hostile("Wrapper", make)
        error = self.h.error("device_insert", {"container": C(T1), "name": "Wrapper"})
        self.assertEqual(error["code"], "not_supported")
        self.assertEqual(self.names(T1), ["Compressor"])

    def test_cleanup_in_a_chain_container_removes_the_new_device_from_that_chain(self):
        self.hostile("Loop Tool", max_device)
        error = self.h.error("device_insert", {"container": C(T0, 1, {"chain": 1}), "name": "Loop Tool"})
        self.assertEqual(error["code"], "not_supported")
        self.assertEqual(self.names(T0, 1, {"chain": 1}), [])

    def test_a_blocked_device_is_never_removed_from_an_existing_rack(self):
        locked = FakeRack("Locked Rack", [FakeChainNoDelete("In", [])])
        self.h.song.tracks[1].devices.append(locked)
        from .fake_devices import attach
        attach(self.h.song, locked)
        self.hostile("Loop Tool", max_device)
        error = self.h.error("device_insert", {"container": C(T1, 1, {"chain": 0}), "name": "Loop Tool"})
        self.assertEqual(error["code"], "lom_error")
        self.assertIs(error["details"]["partial"], True)
        self.assertEqual(self.names(T1), ["Compressor", "Locked Rack"])    # the rack survives

    def test_blocked_content_below_the_depth_cap_cannot_be_verified_and_is_removed(self):
        def make():
            inner = rack_hiding(max_device(), "chain")
            for _ in range(8):
                inner = FakeRack("Level", [FakeChain("In", [inner])])
            return inner
        self.hostile("Deep", make)
        error = self.h.error("device_insert", {"container": C(T1), "name": "Deep"})
        self.assertEqual(error["code"], "not_supported")
        self.assertIs(error["details"]["verified"], False)
        self.assertEqual(self.names(T1), ["Compressor"])

    def test_a_clean_nested_tree_is_kept(self):
        self.hostile("Wrapper", lambda: rack_hiding(FakeDevice("Reverb", "Reverb"), "chain"))
        result = self.h.ok("device_insert", {"container": C(T1), "name": "Wrapper"})
        self.assertEqual(result["device"]["name"], "Hiding Rack")
        self.assertEqual(self.leftovers(self.h.song.tracks[1].devices[-1]), 1)

    def test_pre_existing_devices_are_never_removed(self):
        self.h.song.tracks[1].devices.append(max_device("Old Max"))
        self.hostile("Reverb2", lambda: FakeDevice("Reverb", "Reverb"))
        self.h.ok("device_insert", {"container": C(T1), "name": "Reverb2"})
        self.assertEqual(self.names(T1), ["Compressor", "Old Max", "Reverb"])

    def test_a_tree_too_large_to_verify_fails_closed(self):
        def make():
            rack = FakeRack("Huge")
            rack.chains = [self.chain_with(60) for _ in range(9)]
            return rack
        self.hostile("Huge", make)
        error = self.h.error("device_insert", {"container": C(T1), "name": "Huge"})
        self.assertEqual(error["code"], "not_supported")
        self.assertEqual(self.names(T1), ["Compressor"])

    def chain_with(self, count):
        return FakeChain("Many", [FakeDevice("D%d" % i, "Generic") for i in range(count)])


if __name__ == "__main__":
    unittest.main()
