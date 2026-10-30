"""T4b review round 1, classification: Proxy devices, plugin extensions, segments anywhere, item
source, normalised insert names, error mapping, gain-guard data for the master volume."""

import unittest

from remote_script.BatutaMCP.browser_policy import CORE_LIBRARY_SOURCES
from remote_script.BatutaMCP.errors import BatutaError
from remote_script.BatutaMCP.recording_safety import RecordingSafety
from remote_script.BatutaMCP.state import ScriptState

from .browser_world import PLUGINS, BrowserCase, sample_item
from .device_world import FLAGS_ALL, M, T0, T1, T2, C, D, DeviceCase, world
from .fake_browser import CORE, FakeItem, devices_loader
from .fake_devices import FakeDevice, attach

RACK = D(T0, 1)
CHAIN = {"kind": "chain", "index": 0}


def preset(name, uri, source=None, device=False, loader=None):
    return FakeItem(name, uri, loadable=True, device=device, source=source,
                    loader=loader or devices_loader(lambda: FakeDevice("Operator", "UltraAnalog", 1)))


class ProxyDeviceTests(BrowserCase):
    """M-3 (A38): Proxy device classes are External devices whatever their display name."""

    def proxy(self, class_name="ProxyAudioEffectDevice", name="My Synth"):
        return FakeDevice(name, class_name)

    def test_renamed_proxy_device_in_a_user_preset_is_removed_post_load(self):
        self.browser.set_category("user_library", preset(
            "Proxy.adv", "query:UserLibrary#Presets:Proxy.adv", loader=devices_loader(self.proxy)))
        self.h.flags = FLAGS_ALL
        uri = self.listed_uri("user_library", "Proxy.adv")
        response = self.load(uri, T1)
        self.assertEqual(response["error"]["code"], "not_supported")
        self.assertEqual(response["error"]["details"]["removed"], ["external_device"])
        self.assertEqual([d.name for d in self.h.song.tracks[1].devices], ["Compressor"])

    def test_every_proxy_class_is_removed_after_device_insert(self):
        for class_name in ("ProxyAudioEffectDevice", "ProxyInstrumentDevice", "proxyFutureDevice"):
            self.h.song.device_factories["Odd"] = lambda c=class_name: self.proxy(c)
            error = self.h.error("device_insert", {"container": C(T1), "name": "Odd"})
            self.assertEqual(error["code"], "not_supported", class_name)
            self.assertEqual([d.name for d in self.h.song.tracks[1].devices], ["Compressor"])

    def test_proxy_devices_count_as_external_live_in_the_recording_walk(self):
        safety = RecordingSafety(ScriptState(), lambda: self.h.song)
        self.assertEqual(safety.external_live_tracks(), [])
        for class_name in ("ProxyAudioEffectDevice", "ProxyInstrumentDevice", "ProxyZ"):
            device = self.proxy(class_name)
            self.h.song.tracks[2].devices.append(device)
            self.assertEqual(safety.external_live_tracks(), [self.h.song.tracks[2].name], class_name)
            self.h.song.tracks[2].devices.remove(device)

    def test_proxy_in_a_rack_blocks_recording_commands(self):
        self.h.song.tracks[0].devices[1].chains[0].devices.append(self.proxy("ProxyInstrumentDevice"))
        error = self.h.error("slot_fire", {"track": T2, "slot": 0, "record_length": 4})
        self.assertEqual(error["details"]["reason"], "external_input_live")


class PluginExtensionTests(BrowserCase):
    """Minor 1: .vstpreset / .component / .aupreset are longer than 8 characters."""

    def test_long_plugin_extensions_are_plugins_even_for_devices(self):
        self.browser.set_category("audio_effects", *[
            preset("Foo" + ext, "query:AudioFx#Foo" + ext, device=True)
            for ext in (".component", ".aupreset", ".vstpreset")])
        items = self.listing("audio_effects")
        for name in ("Foo.component", "Foo.aupreset", "Foo.vstpreset"):
            self.assertEqual((items[name]["blocked"], items[name]["is_loadable"]), ("plugin", False), name)
        items = self.listing("audio_effects", flags=PLUGINS)
        self.assertTrue(items["Foo.component"]["is_loadable"])


class SegmentGateTests(BrowserCase):
    """Minor 2: any decoded URI segment holding .amxd or .als, or naming Max for Live, is blocked."""

    def listed(self, name, uri, source=None, flags=FLAGS_ALL):
        self.browser.set_category("user_library", preset(name, uri, source))
        return self.listing("user_library", flags=flags)[name]

    def test_amxd_and_als_anywhere_in_a_segment(self):
        for uri, why in (("query:UserLibrary#Presets:Set.als:Inner.adv", "live_set"),
                         ("query:UserLibrary#Presets:Set.ALS/Inner.adv", "live_set"),
                         ("query:UserLibrary#Presets:Folder.amxd.bak:x.wav", "max_for_live"),
                         ("query:UserLibrary#Presets:a%2eAMXD%2Fb.wav", "max_for_live"),
                         ("query:UserLibrary#Presets:x.amxd-old:y.adv", "max_for_live")):
            item = self.listed("Thing", uri)
            self.assertEqual((item["blocked"], item["is_loadable"]), (why, False), uri)

    def test_max_for_live_segments_and_sources(self):
        for uri in ("query:UserLibrary#Presets:Max%20for%20Live:Thing.adv",
                    "query:UserLibrary#Presets:MaxForLive:Thing.adv",
                    "query:UserLibrary#Presets:Max-4-Live:Thing.adv",
                    "query:Packs#M4L:Thing.adv", "query:UserLibrary#Presets:m4l_tools:Thing.adv"):
            self.assertEqual(self.listed("Thing", uri)["blocked"], "max_for_live", uri)
        self.assertEqual(self.listed("Thing", "query:UserLibrary#Presets:Thing.adv",
                                     source="Max for Live")["blocked"], "max_for_live")

    def test_ordinary_names_are_not_caught(self):
        for uri in ("query:UserLibrary#Presets:Maximum%20Pad.adv", "query:UserLibrary#Presets:Dm4lead.adv",
                    "query:UserLibrary#Presets:Salsa.adv"):
            self.assertIsNone(self.listed("Thing", uri)["blocked"], uri)


class NativeDeviceCategoryTests(BrowserCase):
    """A device item only counts as native inside instruments, audio_effects, midi_effects and drums."""

    def test_device_items_elsewhere_are_blocked_even_with_every_opt_in(self):
        for category in ("user_library", "packs", "samples", "current_project", "sounds"):
            self.browser.set_category(category, preset("Thing", "query:%s#Thing" % category, device=True))
            item = self.listing(category, flags=FLAGS_ALL)["Thing"]
            self.assertEqual((item["is_loadable"], item["blocked"] is not None), (False, True), category)

    def test_a_native_device_under_drums_loads(self):  # T9j: the Drum Rack device is listed there
        self.browser.set_category("drums", preset("Thing", "query:Drums#Thing", device=True))
        self.assertTrue(self.listing("drums")["Thing"]["is_loadable"])

    def test_same_item_in_a_native_category_loads(self):
        self.browser.set_category("midi_effects", preset("Thing", "query:MidiFx#Thing", device=True))
        self.assertTrue(self.listing("midi_effects")["Thing"]["is_loadable"])


class CoreSourceTests(BrowserCase):
    """Minor 3 (A39): BrowserItem.source decides when present; the URI marker is the second signal."""

    def sounds(self, *items):
        self.browser.set_category("sounds", *items)
        return self.listing("sounds")

    def test_source_constant_exists(self):
        self.assertTrue(CORE_LIBRARY_SOURCES and all(isinstance(s, str) for s in CORE_LIBRARY_SOURCES))

    def test_core_source_is_factory_whatever_the_uri(self):
        shown = self.sounds(preset("A.adg", "query:Sounds#A.adg", source=CORE_LIBRARY_SOURCES[0]))
        self.assertTrue(shown["A.adg"]["is_loadable"])

    def test_other_source_beats_a_core_looking_uri(self):
        shown = self.sounds(preset("B.adg", CORE + "B.adg", source="Cool Pack"),
                            preset("C.adg", CORE + "C.adg", source=CORE_LIBRARY_SOURCES[0] + " (copy)"))
        for name in ("B.adg", "C.adg"):
            self.assertEqual(shown[name]["blocked"], "user_content", name)

    def test_without_a_source_the_uri_marker_is_used(self):
        shown = self.sounds(preset("D.adg", CORE + "D.adg"), preset("E.adg", "query:Sounds#E.adg"))
        self.assertTrue(shown["D.adg"]["is_loadable"])
        self.assertEqual(shown["E.adg"]["blocked"], "user_content")

    def test_load_rechecks_the_source(self):
        self.browser.set_category("sounds", preset("A.adg", "query:Sounds#A.adg", source=CORE_LIBRARY_SOURCES[0]))
        uri = self.listed_uri("sounds", "A.adg")
        self.assertTrue(self.load(uri, T1)["ok"])
        self.h.state.lookup_uri(uri)["source"] = "Cool Pack"
        self.assertEqual(self.load(uri, T1)["error"]["code"], "not_supported")


class InsertNameTests(DeviceCase):
    """Minor 4: names are normalised (alphanumerics only, case-folded) and blocked by prefix."""

    def test_blocked_prefixes_ignore_case_and_punctuation(self):
        for name in ("External-Instrument", "Ext.ernal Audio Effect", "EXTERNAL", "M4L Utility", "m 4 l",
                     "Max.Instrument", "Maximum Thing", "Proxy Audio Effect", "Proxy-Synth",
                     "(Max) Thing", "  max"):
            error = self.h.error("device_insert", {"container": C(T1), "name": name})
            self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "blocked_content"),
                             name)
        self.assertNoSideEffects()

    def test_ordinary_names_still_insert(self):
        for name in ("Reverb", "Utility", "Compressor"):
            self.h.ok("device_insert", {"container": C(T1), "name": name})


class InsertErrorMappingTests(DeviceCase):
    """Minor 7: only 'unknown device' becomes not_found; other failures keep their own code."""

    def failing(self, error):
        def make():
            raise error
        self.h.song.device_factories["Boom"] = make

    def test_a_limit_message_is_a_lom_error_with_the_edition_hint(self):
        self.failing(RuntimeError("Maximum number of devices reached"))
        error = self.h.error("device_insert", {"container": C(T1), "name": "Boom"})
        self.assertEqual(error["code"], "lom_error")
        self.assertIs(error["details"]["partial"], True)
        self.assertEqual(error["details"]["suspected"], "edition_limit")

    def test_typed_errors_pass_through(self):
        self.failing(BatutaError("edition_limit", "limit", {"resource": "devices"}))
        self.assertEqual(self.h.error("device_insert", {"container": C(T1), "name": "Boom"})["code"],
                         "edition_limit")
        self.failing(BatutaError("not_supported", "no", {"reason": "edition"}))
        self.assertEqual(self.h.error("device_insert", {"container": C(T1), "name": "Boom"})["code"],
                         "not_supported")

    def test_other_exceptions_are_lom_errors(self):
        self.failing(ValueError("broken"))
        self.assertEqual(self.h.error("device_insert", {"container": C(T1), "name": "Boom"})["code"], "lom_error")

    def test_unknown_names_are_still_not_found(self):
        self.assertEqual(self.h.error("device_insert", {"container": C(T1), "name": "Nope"})["code"], "not_found")


class ChainVolumeDbRangeTests(DeviceCase):
    def test_boundaries(self):
        for value in (-70, 6):
            self.h.ok("chain_set", {"device": RACK, "chain": CHAIN, "volume_db": value})
        for value in (-70.5, -71, 6.5, 7):
            self.assertEqual(self.h.error("chain_set", {"device": RACK, "chain": CHAIN,
                                                       "volume_db": value})["code"], "out_of_range", value)


class MasterGainGuardDataTests(DeviceCase):
    """Minor 5: param_set / param_get on the master volume carry the dB text the server needs."""

    def test_master_volume_through_param_get_and_param_set(self):
        param = {"mixer": "volume", "track": M}
        info = self.h.ok("param_get", {"param": param, "at_value": 1.0})
        self.assertEqual((info["display"], info["display_at_value"]), ("0.0 dB", "6.0 dB"))
        result = self.h.ok("param_set", {"param": param, "value": 1.0})
        self.assertEqual(result["params"][0]["display"], "6.0 dB")
        self.assertEqual(self.h.song.master_track.mixer_device.volume.value, 1.0)


if __name__ == "__main__":
    unittest.main()
