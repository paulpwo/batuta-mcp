"""Shared setup for the T4b device, rack and browser tests."""

import unittest

from .fake_devices import (FakeChain, FakeDevice, FakeDrumRack, FakeRack, attach, default_factories,
                           utility, INSTRUMENT)
from .fake_lom import LomHarness

T0 = {"kind": "track", "index": 0}  # MIDI: Operator, a rack (chains + return chain), Utility
T1 = {"kind": "track", "index": 1}  # audio: Compressor
T2 = {"kind": "track", "index": 2}  # MIDI: a drum rack
R0 = {"kind": "return", "index": 0}
M = {"kind": "master"}

OPERATOR, RACK, UTILITY0 = 0, 1, 2   # device indexes on track 0
CHAIN_A, CHAIN_B = 0, 1
FLAGS_ALL = {"allow_plugins": True, "allow_user_presets": True}


def D(track, *path):
    """A DeviceRef: `D(T0, 1, {"chain": 0, "device": 1})`."""
    return {"track": track, "path": list(path)}


def C(track, *path):
    """A ContainerRef (the path may be empty or end with a chain without a device)."""
    return {"track": track, "path": list(path)}


def world(flags=None, edition=None):
    """Track 0 holds Operator, a rack and a Utility; track 1 a Compressor; track 2 a drum rack."""
    h = LomHarness(kinds=("midi", "audio", "midi"), returns=1, scenes=2, flags=flags, edition=edition)
    song = h.song
    song.device_factories.update(default_factories())
    rack = FakeRack("FX Rack", chains=[
        FakeChain("Chain A", [FakeDevice("Compressor", "Compressor2"), utility()]),
        FakeChain("Chain B", []),
    ], return_chains=[FakeChain("Return Chain", [FakeDevice("Reverb", "Reverb")])], variations=2)
    song.tracks[0].devices += [FakeDevice("Operator", "UltraAnalog", INSTRUMENT), rack, utility()]
    song.tracks[1].devices += [FakeDevice("Compressor", "Compressor2")]
    song.tracks[2].devices += [FakeDrumRack("Kit", {36: [FakeDevice("Compressor", "Compressor2")],
                                                      38: [utility()]})]
    song.master_track.devices += [utility("Master Utility")]
    song.return_tracks[0].devices += [FakeDevice("Reverb", "Reverb")]
    for track in song.tracks + song.return_tracks + [song.master_track]:
        for device in track.devices:
            attach(song, device)
    h.reset_log()
    return h


class DeviceCase(unittest.TestCase):
    """A `world()` harness with assertions shared by the T4b suites."""

    flags = None

    def setUp(self):
        self.h = world(self.flags)

    def reason(self, error):
        return error["details"]["reason"]

    def assertNoSideEffects(self):
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.h.song.log, [])

    def assertOneUndoStep(self):
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def names(self, track, *path):
        """Device names found at DeviceRef `path` container of `track` through the script itself."""
        result = self.h.ok("device_list", {"container": C(track, *path)})
        return [item["name"] for item in result["items"]]

    def batch_error(self, name, args, flags=None):
        if flags is not None:
            self.h.flags = flags
        response = self.h.run("batch", {"ops": [{"cmd": name, "args": args}]})
        if not response["ok"]:   # a record guard refuses the whole batch up front (nothing ran)
            return response["error"]
        result = response["result"]
        self.assertFalse(result["results"][0]["ok"], (name, args))
        return result["results"][0]["error"]
