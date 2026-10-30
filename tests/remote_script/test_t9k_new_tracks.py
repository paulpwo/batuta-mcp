"""T9k (F-T9-19): a browser load that makes Live create a track reports it (`new_tracks`, `landed_on`)
in the synchronous result and in the sweep outcome; the track is never removed or disarmed."""

from .browser_world import BrowserCase
from .device_world import T1
from .fake_browser import CORE, FakeItem
from .fake_devices import FakeDevice, attach
from .test_t4b_review_sweep import SweepCase, new_track_hook


def arming_hook(browser, track):
    """Like Live: an instrument onto an audio track makes a new armed MIDI track next to it."""
    song = browser._song
    index = song.tracks.index(track) + 1
    song.create_midi_track(index)
    created = song.tracks[index]
    created.arm = True
    device = FakeDevice("Drum Rack", "DrumGroupDevice", 1)
    attach(song, device)
    created.devices.append(device)


class SyncNewTrackTests(SweepCase):
    def test_the_new_track_is_reported_and_left_alone(self):
        uri = self.put("Rack.adg", on_load=arming_hook)
        before = len(self.h.song.tracks)
        result = self.load(uri, T1)["result"]
        self.assertEqual(len(self.h.song.tracks), before + 1)
        created = self.h.song.tracks[2]
        self.assertTrue(created.arm)
        self.assertEqual(result["new_tracks"], [{"kind": "track", "index": 2, "name": created.name, "arm": True}])
        self.assertEqual(result["landed_on"], {"kind": "track", "index": 2})
        self.assertEqual(self.names(2), ["Drum Rack"])
        self.assertEqual((result["verified"], result["sweep_pending"]), (True, False))

    def test_no_new_track_means_no_extra_fields(self):
        result = self.load(self.listed_uri("audio_effects", "Compressor"), T1)["result"]
        self.assertNotIn("new_tracks", result)
        self.assertNotIn("landed_on", result)


class SweepNewTrackTests(SweepCase):
    def test_a_late_track_is_recorded_in_the_sweep_outcome(self):
        uri = self.put("Late.adg", on_load=arming_hook, deferred=1)
        result = self.load(uri, T1)["result"]
        self.assertTrue(result["sweep_pending"])
        self.assertNotIn("new_tracks", result)
        self.land(self.pump())
        outcome = self.h.state.recent_sweeps()[0]
        created = self.h.song.tracks[2]
        self.assertEqual(outcome["new_tracks"], [{"kind": "track", "index": 2, "name": created.name, "arm": True}])
        self.assertEqual(outcome["landed_on"], {"kind": "track", "index": 2})
        self.assertTrue(created.arm)
        self.assertEqual(self.names(2), ["Drum Rack"])
