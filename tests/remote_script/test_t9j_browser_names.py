"""T9j (F-T9-18): items reached through sounds, drums and samples have opaque FileId URIs, so the
extension comes from the display name; folders are browsable, not blocked; native devices under
drums are allowed. Every block still applies to the name as well as the URI."""

from .browser_world import USER_PRESETS, BrowserCase
from .device_world import FLAGS_ALL, T1
from .fake_browser import FakeItem, devices_loader, folder
from .fake_devices import FakeDevice, FakeRack


def leaf(name, uri, device=False, loadable=True):
    return FakeItem(name, uri, loadable=loadable, device=device,
                    loader=devices_loader(lambda: FakeRack(name)))


class FileIdNameTests(BrowserCase):
    def test_preset_name_extension_decides_when_the_uri_has_none(self):
        self.browser.set_category(
            "sounds", leaf("808 Pure.adg", "query:Sounds#Bass:FileId_24509"))
        self.browser.set_category(
            "drums", leaf("808 Core Kit.adg", "query:Drums#FileId_24756"))
        for category, name in (("sounds", "808 Pure.adg"), ("drums", "808 Core Kit.adg")):
            closed = self.listing(category, flags={})[name]
            self.assertEqual((closed["blocked"], closed["is_loadable"]), ("user_content", False), name)
            opened = self.listing(category, flags=USER_PRESETS)[name]
            self.assertEqual((opened["blocked"], opened["is_loadable"]), (None, True), name)

    def test_sample_name_extension_is_allowed_without_opt_in(self):
        self.browser.set_category(
            "samples", leaf("4 Partials All Combos.wav", "query:Samples#FileId_41435"))
        item = self.listing("samples", flags={})["4 Partials All Combos.wav"]
        self.assertEqual((item["blocked"], item["is_loadable"]), (None, True))

    def test_no_extension_anywhere_stays_user_content(self):
        self.browser.set_category("samples", leaf("Mystery", "query:Samples#FileId_1"))
        item = self.listing("samples", flags=FLAGS_ALL)["Mystery"]
        self.assertEqual((item["blocked"], item["is_loadable"]), ("user_content", False))

    def test_the_uri_extension_wins_over_the_name(self):
        self.browser.set_category("samples", leaf("Kick.wav", "query:Samples#Kick.exe"))
        self.assertEqual(self.listing("samples", flags=FLAGS_ALL)["Kick.wav"]["blocked"], "user_content")

    def test_every_block_applies_to_the_name(self):
        self.browser.set_category(
            "sounds",
            leaf("Evil.amxd", "query:Sounds#FileId_1"),
            leaf("Song.als", "query:Sounds#FileId_2"),
            leaf("Cool M4L Pad.adg", "query:Sounds#FileId_3"),
            leaf("Max for Live Thing.adg", "query:Sounds#FileId_4"),
            leaf("External Instrument", "query:Sounds#FileId_5"))
        items = self.listing("sounds", flags=FLAGS_ALL)
        self.assertEqual(items["Evil.amxd"]["blocked"], "max_for_live")
        self.assertEqual(items["Song.als"]["blocked"], "live_set")
        self.assertEqual(items["Cool M4L Pad.adg"]["blocked"], "max_for_live")
        self.assertEqual(items["Max for Live Thing.adg"]["blocked"], "max_for_live")
        self.assertEqual(items["External Instrument"]["blocked"], "external_device")
        self.assertTrue(all(not item["is_loadable"] for item in items.values()))
        self.browser.set_category("sounds", leaf("Patch.fxp", "query:Sounds#FileId_6"))
        self.assertEqual(self.listing("sounds", flags={})["Patch.fxp"]["blocked"], "plugin")

    def test_file_id_item_loads_when_presets_are_allowed(self):
        self.browser.set_category("sounds", leaf("808 Pure.adg", "query:Sounds#Bass:FileId_24509"))
        uri = self.listed_uri("sounds", "808 Pure.adg", flags=USER_PRESETS)
        self.assertTrue(self.load(uri, T1)["ok"])

    def test_folders_are_not_reported_blocked(self):
        self.browser.set_category(
            "sounds",
            folder("Bass", "query:Sounds#Bass", leaf("808 Pure.adg", "query:Sounds#Bass:FileId_1")),
            folder("Hidden.amxd", "query:Sounds#FileId_9"),
            folder("Max for Live", "query:Sounds#FileId_10"))
        items = self.listing("sounds", flags={})
        self.assertEqual((items["Bass"]["blocked"], items["Bass"]["is_loadable"]), (None, False))
        self.assertEqual(items["Hidden.amxd"]["blocked"], "max_for_live")
        self.assertEqual(items["Max for Live"]["blocked"], "max_for_live")

    def test_a_folder_can_never_be_loaded(self):
        folder_item = FakeItem("Kits", "query:Drums#Kits", [], loadable=True, loader=devices_loader())
        self.browser.set_category("drums", folder_item)
        item = self.listing("drums", flags=FLAGS_ALL)["Kits"]
        self.assertFalse(item["is_loadable"])
        response = self.load(item["uri"], T1)
        self.assertEqual(response["error"]["code"], "not_supported")

    def test_native_device_under_drums_is_allowed(self):
        self.browser.set_category(
            "drums",
            FakeItem("Drum Rack", "query:Drums#Drum%20Rack", loadable=True, device=True,
                     loader=devices_loader(lambda: FakeDevice("Drum Rack", "DrumGroupDevice", 1))),
            FakeItem("External Instrument", "query:Drums#External%20Instrument", loadable=True,
                     device=True, loader=devices_loader()),
            leaf("Loose Kit", "query:Drums#FileId_3"))
        items = self.listing("drums", flags={})
        self.assertEqual((items["Drum Rack"]["blocked"], items["Drum Rack"]["is_loadable"]), (None, True))
        self.assertEqual(items["External Instrument"]["blocked"], "external_device")
        self.assertEqual(items["Loose Kit"]["blocked"], "user_content")
