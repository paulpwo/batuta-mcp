"""Shared setup for the T4a clip, note, envelope and arrangement tests."""

import unittest

from .fake_lom import FakeClip, FakeDeviceStub, LomHarness

T0 = {"kind": "track", "index": 0}  # MIDI
T1 = {"kind": "track", "index": 1}  # audio
T2 = {"kind": "track", "index": 2}  # MIDI
R0 = {"kind": "return", "index": 0}
M = {"kind": "master"}
IMPORT = {"allow_audio_import": True}
NOTES = ((60, 0.0, 1.0), (64, 1.0, 1.0), (67, 2.0, 1.0))  # ids 1, 2, 3 when seeded in order


def S(track, slot):
    return {"kind": "session", "track": track, "slot": slot}


def A(track, index, **extra):
    return dict({"kind": "arrangement", "track": track, "index": index}, **extra)


def world(flags=None, edition=None, scenes=3):
    """Tracks: 0 MIDI, 1 audio, 2 MIDI; one return; slots (0,0) MIDI clip with NOTES and (1,0) audio clip."""
    h = LomHarness(kinds=("midi", "audio", "midi"), scenes=scenes, flags=flags, edition=edition)
    put_clip(h, 0, 0, True, "Midi A", 4.0, NOTES)
    put_clip(h, 1, 0, False, "Audio A", 4.0)
    return h


def put_clip(h, track, slot, midi=True, name="Clip", length=4.0, notes=()):
    clip = FakeClip(name, midi, length)
    if notes:
        clip.seed_notes(*notes)
    h.song.tracks[track].clip_slots[slot].clip = clip
    h.reset_log()
    return clip


def put_arrangement(h, track, start, length=4.0, midi=True, name="Arr", extent=None):
    """An arrangement clip with a `length`-beat loop; `extent` stretches it on the timeline."""
    clip = FakeClip(name, midi, length)
    h.song.tracks[track]._place(clip, start, extent)
    h.reset_log()
    return clip


def add_device(h, track=0, params=3, name="Comp"):
    device = FakeDeviceStub(name, "Compressor2", 2, params)
    h.song.tracks[track].devices.append(device)
    return device


class ClipCase(unittest.TestCase):
    """Base class: a `world()` harness plus assertions shared by the T4a suites."""

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

    def batch_error(self, name, args, flags=None):
        """Run one op inside a batch; return that op's error (the batch itself succeeds)."""
        if flags is not None:
            self.h.flags = flags
        response = self.h.run("batch", {"ops": [{"cmd": name, "args": args}]})
        if not response["ok"]:   # a record guard refuses the whole batch up front (nothing ran)
            return response["error"]
        result = response["result"]
        self.assertFalse(result["results"][0]["ok"], (name, args))
        return result["results"][0]["error"]

    def external_live(self):
        """The owner armed audio track 1 on its Ext. In input by hand."""
        self.h.song.tracks[1]._arm = True
        self.h.reset_log()
