"""A fake Live browser for the T4b tests.

Categories are root items with children, like Live's `browser.instruments`, `browser.sounds`, and so
on. `load_item` loads onto the SELECTED track (the only target Live supports) by running the item's
loader, which appends devices to that track. The tree holds hostile content on purpose: Max for Live
files, Live sets, a Pack preset shown inside `sounds`, presets with nested Max / plugin / External
devices, and plugin entries. `CORE` is the URI marker the script treats as proof of Core Library.
"""

import types

from remote_script.BatutaMCP.browser_policy import CORE_LIBRARY_URI_PREFIXES

from .fake_devices import (INSTRUMENT, FakeDevice, FakeDrumRack, FakeRack, attach, external_device,
                           max_device, plugin_device, rack_hiding, utility)
from .fakes import install_fake_live

CORE = CORE_LIBRARY_URI_PREFIXES[0]
PACK = "query:Packs#Cool%20Pack:"
USER = "query:UserLibrary#Presets:"
PROJECT = "query:CurrentProject#"


class FakeItem:
    """A browser item. Reads only. `reads` counts children handed out (class-wide, for cost tests);
    `virtual=(count, make)` serves `count` children built on demand by `make(index)`."""

    reads = 0

    def __init__(self, name, uri, children=None, loadable=False, device=False, loader=None,
                 on_children=None, source=None, virtual=None, on_load=None, deferred=0):
        self.name = name
        self.uri = uri
        self._children = children
        self._virtual = virtual
        self.is_loadable = loadable
        self.is_device = device
        self.loader = loader
        self._on_children = on_children
        self._source = source
        self.on_load = on_load      # hook(browser, track): replaces the standard loader
        self.deferred = deferred    # ticks before the load takes effect (asynchronous Live)

    @property
    def source(self):
        if self._source is None:
            raise AttributeError("source")
        return self._source

    @property
    def is_folder(self):
        return self._children is not None or self._virtual is not None

    def iter_children(self):
        if self._on_children is not None:
            self._on_children(self)
        if self._virtual is not None:
            count, make = self._virtual
            for index in range(count):
                FakeItem.reads += 1
                yield make(index)
            return
        for child in self._children or []:
            FakeItem.reads += 1
            yield child

    @property
    def children(self):
        return list(self.iter_children())


class FakeItemNoIter(FakeItem):
    """An item on a Live without `iter_children`: only `children` exists."""

    def __getattribute__(self, name):
        if name == "iter_children":
            raise AttributeError(name)
        return object.__getattribute__(self, name)

    @property
    def children(self):
        return list(FakeItem.iter_children(self))


def device_loader(name, class_name="Generic", device_type=2):
    return lambda track: [FakeDevice(name, class_name, device_type)]


def devices_loader(*makers):
    return lambda track: [maker() for maker in makers]


def folder(name, uri, *children):
    return FakeItem(name, uri, list(children))


class FakeBrowser:
    CATEGORIES = ("instruments", "drums", "sounds", "audio_effects", "midi_effects", "packs",
                  "user_library", "samples", "current_project", "plugins", "max_for_live",
                  "modulators")

    def __init__(self, song):
        self._song = song
        self.loaded = []
        self.pending = []
        for name in self.CATEGORIES:
            setattr(self, name, FakeItem(name, "query:" + name, []))

    def set_category(self, name, *children):
        setattr(self, name, FakeItem(name, "query:" + name, list(children)))

    def remove_category(self, name):
        del self.__dict__[name]

    def load_item(self, item):
        self._song.log.append("call:Browser.load_item")
        if not item.is_loadable or (item.loader is None and item.on_load is None):
            raise RuntimeError("Item is not loadable")
        track = self._song.view.selected_track
        if item.deferred:
            self.pending.append([item.deferred, item, track])
            return
        self._apply(item, track)

    def _apply(self, item, track):
        if item.on_load is not None:
            item.on_load(self, track)
        else:
            for device in item.loader(track):
                attach(self._song, device)
                track.devices.append(device)
        self.loaded.append(item.uri)

    def advance(self):
        """One main-thread tick for asynchronous loads: due items take effect now."""
        for entry in list(self.pending):
            entry[0] -= 1
            if entry[0] <= 0:
                self.pending.remove(entry)
                self._apply(entry[1], entry[2])


def build_tree(browser):
    """The standard hostile browser content used by most tests."""
    leaf = FakeItem
    browser.set_category(
        "instruments",
        leaf("Operator", "query:Synths#Operator", [
            leaf("Bass Op.adv", CORE + "Operator:Bass%20Op.adv", loadable=True,
                 loader=device_loader("Operator", "UltraAnalog", INSTRUMENT))],
             loadable=True, device=True, loader=device_loader("Operator", "UltraAnalog", INSTRUMENT)),
        leaf("External Instrument", "query:Synths#External%20Instrument", loadable=True, device=True,
             loader=lambda track: [external_device("External Instrument", "ExternalInstrument")]),
        leaf("Mystery Synth", "query:Synths#Mystery", loadable=True, device=True,
             loader=lambda track: [external_device("Mystery Synth", "ExternalInstrument")]))
    browser.set_category(
        "audio_effects",
        leaf("Compressor", "query:AudioFx#Compressor", loadable=True, device=True,
             loader=device_loader("Compressor", "Compressor2")),
        leaf("External Audio Effect", "query:AudioFx#External%20Audio%20Effect", loadable=True,
             device=True, loader=lambda track: [external_device()]))
    browser.set_category(
        "midi_effects",
        leaf("Arpeggiator", "query:MidiFx#Arpeggiator", loadable=True, device=True,
             loader=device_loader("Arpeggiator", "MidiArpeggiator", 3)))
    browser.set_category(
        "sounds",
        folder("Bass", "query:Sounds#Bass",
               leaf("Warm Bass.adg", CORE + "Bass:Warm%20Bass.adg", loadable=True,
                    loader=devices_loader(lambda: FakeRack("Warm Bass"))),
               leaf("Wobble.adg", CORE + "Bass:Wobble.adg", loadable=True,
                    loader=devices_loader(lambda: rack_hiding(max_device(), "chain"))),
               leaf("Pluck.adg", CORE + "Bass:Pluck.adg", loadable=True,
                    loader=devices_loader(lambda: rack_hiding(plugin_device(), "return_chain"))),
               leaf("Ext.adg", CORE + "Bass:Ext.adg", loadable=True,
                    loader=devices_loader(lambda: rack_hiding(external_device(), "drum_pad"))),
               leaf("Pack Pad.adg", PACK + "Pad.adg", loadable=True,
                    loader=devices_loader(lambda: FakeRack("Pack Pad"))),
               leaf("Pack Unmarked.adg", "query:Sounds#Bass:Unmarked.adg", loadable=True,
                    loader=devices_loader(lambda: FakeRack("Unmarked")))))
    browser.set_category(
        "drums",
        leaf("808 Kit.adg", CORE + "Drums:808%20Kit.adg", loadable=True,
             loader=devices_loader(lambda: FakeDrumRack("808 Kit", {36: [utility()]}))),
        leaf("Pack Kit.adg", PACK + "Kit.adg", loadable=True,
             loader=devices_loader(lambda: FakeDrumRack("Pack Kit"))))
    browser.set_category(
        "packs",
        folder("Cool Pack", "query:Packs#Cool%20Pack",
               leaf("Lead.adg", PACK + "Lead.adg", loadable=True,
                    loader=devices_loader(lambda: FakeRack("Lead"))),
               leaf("Loop.wav", PACK + "Loop.wav", loadable=True,
                    loader=devices_loader(lambda: FakeDevice("Simpler", "OriginalSimpler", INSTRUMENT))),
               leaf("Core Lookalike.adg", CORE + "Lookalike.adg", loadable=True,
                    loader=devices_loader(lambda: FakeRack("Lookalike")))))
    browser.set_category(
        "user_library",
        leaf("Mine.adg", USER + "Mine.adg", loadable=True,
             loader=devices_loader(lambda: FakeRack("Mine"))),
        leaf("Synth.adv", USER + "Synth.adv", loadable=True,
             loader=devices_loader(lambda: FakeDevice("Operator", "UltraAnalog", INSTRUMENT))),
        leaf("Clip.alc", USER + "Clip.alc", loadable=True,
             loader=devices_loader(lambda: FakeDevice("Operator", "UltraAnalog", INSTRUMENT))),
        leaf("Evil.amxd", USER + "Evil.amxd", loadable=True,
             loader=devices_loader(max_device)),
        leaf("Song.als", USER + "Song.als", loadable=True, loader=devices_loader()),
        leaf("Sneaky.amxd.adg", USER + "Sneaky.amxd%2Eadg", loadable=True,
             loader=devices_loader(lambda: FakeRack("Sneaky"))),
        leaf("Double%2Eamxd", USER + "Sneak%252Eamxd", loadable=True,
             loader=devices_loader(max_device)),
        leaf("Hidden.amxd", USER + "Hidden.amxd:Preset.adv", loadable=True,
             loader=devices_loader(max_device)),
        leaf("Patch.fxp", USER + "Patch.fxp", loadable=True, loader=devices_loader(plugin_device)),
        leaf("Vocal.wav", USER + "Vocal.WAV", loadable=True,
             loader=devices_loader(lambda: FakeDevice("Simpler", "OriginalSimpler", INSTRUMENT))))
    browser.set_category(
        "current_project",
        leaf("Take.adv", PROJECT + "Take.adv", loadable=True,
             loader=devices_loader(lambda: FakeDevice("Operator", "UltraAnalog", INSTRUMENT))),
        leaf("Live Set.als", PROJECT + "Live%20Set.als", loadable=True, loader=devices_loader()))
    browser.set_category(
        "samples",
        leaf("Kick.wav", "query:Samples#Kick.wav", loadable=True,
             loader=devices_loader(lambda: FakeDevice("Simpler", "OriginalSimpler", INSTRUMENT))),
        leaf("Snare.aif", "query:Samples#Snare.aif", loadable=True,
             loader=devices_loader(lambda: FakeDevice("Simpler", "OriginalSimpler", INSTRUMENT))),
        leaf("Noise.exe", "query:Samples#Noise.exe", loadable=True, loader=devices_loader()),
        leaf("NoExtension", "query:Samples#NoExtension", loadable=True, loader=devices_loader()))
    browser.set_category(
        "plugins",
        leaf("Serum", "query:Plugins#VST3:Serum", loadable=True, device=True,
             loader=devices_loader(plugin_device)),
        leaf("Serum Preset", "query:Plugins#VST3:Serum:Lead.fxp", loadable=True,
             loader=devices_loader(plugin_device)))
    browser.set_category(
        "max_for_live",
        leaf("Max Audio Effect", "query:Max#Audio%20Effect", loadable=True, device=True,
             loader=devices_loader(max_device)),
        leaf("Convolution.amxd", "query:Max#Convolution.amxd", loadable=True,
             loader=devices_loader(max_device)))
    browser.set_category(
        "modulators",
        leaf("Envelope Follower", "query:Modulators#Envelope", loadable=True, device=True,
             loader=devices_loader(lambda: FakeDevice("Envelope Follower", "Modulator"))))


def install_browser(harness, build=True):
    """Install a fake `Live` module whose application exposes a browser tied to the harness song."""
    live = install_fake_live()
    browser = FakeBrowser(harness.song)
    if build:
        build_tree(browser)
    application = types.SimpleNamespace(get_version_string=lambda: "12.4.7", browser=browser)
    live.Application.get_application = lambda: application
    harness.browser = browser
    return browser
