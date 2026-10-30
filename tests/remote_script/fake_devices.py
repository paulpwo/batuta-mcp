"""Fake devices, racks, chains and drum pads for the T4b tests.

They follow the Live Object Model closely enough for the command handlers: a device exposes
`class_name`, `type`, `parameters` (the first one is "Device On") and `is_active`; racks own chains,
return chains and variations; drum racks own 128 pads; chains and tracks insert and delete devices
through factories registered on the song. Every write lands in `song.log` once the object tree is
attached (see `attach`), so tests can prove that read commands never mutate.
"""

from .fake_lom import FakeParameter, Logged, plain_text, pan_text, volume_text

DEVICE_ON = "Device On"
INSTRUMENT, AUDIO_EFFECT, MIDI_EFFECT = 1, 2, 3


def on_off_text(raw):
    return "On" if raw >= 0.5 else "Off"


def db_text(raw):
    return "%.1f dB" % raw


class Noted(Logged):
    """Logged objects that also record method calls (`call:` entries) in the shared log."""

    def _note(self, text):
        log = self.__dict__.get("_log")
        if log is not None:
            log.append("call:" + text)


class FakeDevice(Noted):
    can_have_chains = False
    can_have_drum_pads = False

    def __init__(self, name, class_name="Generic", device_type=AUDIO_EFFECT, params=None):
        self.name = name
        self.class_name = class_name
        self.type = device_type
        self.parameters = [FakeParameter(DEVICE_ON, 1.0, 0.0, 1.0, on_off_text, items=("Off", "On"))]
        self.parameters += params if params is not None else [FakeParameter("Amount", 0.5)]

    @property
    def is_active(self):
        return self.parameters[0].value >= 0.5

    def clone(self):
        copy = FakeDevice(self.name, self.class_name, self.type,
                          [FakeParameter(p.name, p.value, p.min, p.max, p._text, p.is_enabled,
                                         p._items, p.default_value) for p in self.parameters[1:]])
        return copy


def utility(name="Utility"):
    """An audio effect with a dB gain parameter (the gain guard's main target)."""
    return FakeDevice(name, "StereoGain", AUDIO_EFFECT, [
        FakeParameter("Gain", 0.0, -35.0, 35.0, db_text),
        FakeParameter("Mode", 0.0, 0.0, 2.0, plain_text, items=("Stereo", "Mono", "Mid/Side")),
        FakeParameter("Locked", 0.5, 0.0, 1.0, plain_text, is_enabled=False),
    ])


class FakeChainMixer(Logged):
    def __init__(self):
        self.volume = FakeParameter("Volume", 0.85, 0.0, 1.0, volume_text)
        self.panning = FakeParameter("Pan", 0.0, -1.0, 1.0, pan_text)


class FakeChain(Noted):
    def __init__(self, name="Chain", devices=None):
        self.name = name
        self.color = 0x445566
        self.mute = False
        self.solo = False
        self.devices = list(devices or [])
        self.mixer_device = FakeChainMixer()

    def insert_device(self, name, index):
        insert_into(self.devices, self._song, name, index, "Chain")

    def delete_device(self, index):
        delete_from(self.devices, self._song, index, "Chain")


class FakeChainNoDelete(FakeChain):
    """A chain on a Live version without chain-level device deletion (assumption A11 false)."""

    def __getattribute__(self, name):
        if name == "delete_device":
            raise AttributeError(name)
        return object.__getattribute__(self, name)


class FakeRack(FakeDevice):
    can_have_chains = True

    def __init__(self, name="Audio Effect Rack", chains=None, return_chains=None,
                 class_name="AudioEffectGroupDevice", variations=0, device_type=AUDIO_EFFECT):
        super().__init__(name, class_name, device_type)
        self.chains = list(chains or [])
        self.return_chains = list(return_chains or [])
        self.visible_macro_count = 8
        self.variation_count = variations
        self._selected = 0
        self.macro_log = []

    @property
    def selected_variation_index(self):
        return self._selected

    @selected_variation_index.setter
    def selected_variation_index(self, value):
        if not 0 <= value < max(self.variation_count, 1):
            raise RuntimeError("variation index out of range")
        self._selected = value

    def insert_chain(self, index):
        self._note("rack.insert_chain")
        if not 0 <= index <= len(self.chains):
            raise RuntimeError("chain index out of range")
        chain = FakeChain("Chain %d" % (len(self.chains) + 1))
        attach(self._song, chain)
        self.chains.insert(index, chain)

    def store_variation(self):
        self._note("rack.store_variation")
        self.variation_count += 1
        self._selected = self.variation_count - 1

    def recall_selected_variation(self):
        self._note("rack.recall_selected_variation")
        self.macro_log.append(("recall", self._selected))

    def delete_selected_variation(self):
        self._note("rack.delete_selected_variation")
        self.variation_count -= 1
        self._selected = max(0, min(self._selected, self.variation_count - 1))

    def randomize_macros(self):
        self._note("rack.randomize_macros")
        self.macro_log.append(("randomize", None))

    def clone(self):
        raise NotImplementedError("racks are not cloned by the fake")


class FakeRackNoInsertChain(FakeRack):
    """A Live version without Rack.insert_chain (assumption A11 false)."""

    def __getattribute__(self, name):
        if name == "insert_chain":
            raise AttributeError(name)
        return object.__getattribute__(self, name)


class FakeDrumPad(Noted):
    def __init__(self, note, chains=None):
        self.note = note
        self.mute = False
        self.solo = False
        self.chains = list(chains or [])

    @property
    def name(self):
        return self.chains[0].name if self.chains else ""

    def delete_all_chains(self):
        self._note("pad.delete_all_chains")
        self.chains = []


class FakeDrumRack(FakeRack):
    can_have_drum_pads = True

    def __init__(self, name="Drum Rack", filled=None):
        """`filled`: {note: [device, ...]} pads that hold one chain with those devices."""
        super().__init__(name, class_name="DrumGroupDevice", device_type=INSTRUMENT)
        self.drum_pads = [FakeDrumPad(note) for note in range(128)]
        for note, devices in (filled or {}).items():
            self.drum_pads[note].chains = [FakeChain("Pad %d" % note, devices)]

    def copy_pad(self, source, destination):
        self._note("rack.copy_pad")
        if not (0 <= source < 128 and 0 <= destination < 128):
            raise RuntimeError("pad out of range")
        target = self.drum_pads[destination]
        target.chains = []
        for chain in self.drum_pads[source].chains:
            copy = FakeChain(chain.name, [device.clone() for device in chain.devices])
            attach(self._song, copy)
            target.chains.append(copy)


def insert_into(devices, song, name, index, owner):
    """Track.insert_device / Chain.insert_device: a factory builds the device, Live rejects unknown names."""
    song.log.append("call:%s.insert_device" % owner)
    factory = song.device_factories.get(name)
    if factory is None:
        raise RuntimeError("Device not found: %s" % name)
    if not 0 <= index <= len(devices):
        raise RuntimeError("index out of range")
    device = factory()
    attach(song, device)
    devices.insert(index, device)


def delete_from(devices, song, index, owner):
    song.log.append("call:%s.delete_device" % owner)
    if not 0 <= index < len(devices):
        raise RuntimeError("index out of range")
    del devices[index]


def attach(song, thing):
    """Point a device tree at the song's log and device factories (like objects living in a set)."""
    thing._log = song.log
    thing._song = song
    for param in getattr(thing, "parameters", ()):
        param._log = song.log
    mixer = getattr(thing, "mixer_device", None)
    if mixer is not None:
        mixer._log = song.log
        mixer.volume._log = song.log
        mixer.panning._log = song.log
    for chain in list(getattr(thing, "chains", ())) + list(getattr(thing, "return_chains", ())):
        attach(song, chain)
    for pad in getattr(thing, "drum_pads", ()):
        attach(song, pad)
    for device in getattr(thing, "devices", ()):
        attach(song, device)


def default_factories():
    """Built-in devices Live can insert by name, plus hostile ones that only a test registers."""
    return {
        "Operator": lambda: FakeDevice("Operator", "UltraAnalog", INSTRUMENT),
        "Compressor": lambda: FakeDevice("Compressor", "Compressor2"),
        "Reverb": lambda: FakeDevice("Reverb", "Reverb"),
        "Utility": utility,
        "Audio Effect Rack": lambda: FakeRack("Audio Effect Rack"),
        "Drum Rack": lambda: FakeDrumRack("Drum Rack"),
        "External Audio Effect": lambda: FakeDevice("External Audio Effect", "ExternalAudioEffect"),
        "External Instrument": lambda: FakeDevice("External Instrument", "ExternalInstrument",
                                                  INSTRUMENT),
    }


def max_device(name="Loop Tool", class_name="MxDeviceAudioEffect"):
    return FakeDevice(name, class_name)


def plugin_device(name="Serum", class_name="PluginDevice"):
    return FakeDevice(name, class_name, INSTRUMENT)


def external_device(name="Line Out", class_name="ExternalAudioEffect"):
    return FakeDevice(name, class_name)


def rack_hiding(device, where="chain"):
    """A rack that carries `device` in a chain, a return chain or a drum pad."""
    if where == "drum_pad":
        return FakeDrumRack("Hiding Kit", {36: [device]})
    chain = FakeChain("Inner", [device])
    if where == "return_chain":
        return FakeRack("Hiding Rack", return_chains=[chain])
    return FakeRack("Hiding Rack", chains=[chain])
