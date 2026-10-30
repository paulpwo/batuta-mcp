import unittest

from remote_script.BatutaMCP import edition
from remote_script.BatutaMCP.errors import BatutaError
from remote_script.BatutaMCP.recording_safety import RecordingSafety
from remote_script.BatutaMCP.state import ScriptState

from .fakes import (FakeChain, FakeDevice, FakeDrumPad, FakeRoutingType,
                    FakeRoutingTypeNoObject, FakeSong, FakeTrack)


class EditionTests(unittest.TestCase):
    def test_detect_lite(self):
        self.assertEqual(edition.detect_edition("Live 12 Lite 12.4.7"), "lite")
        self.assertEqual(edition.detect_edition("12.4.7 LITE"), "lite")

    def test_detect_unknown_when_not_lite(self):
        self.assertEqual(edition.detect_edition("12.4.3"), "unknown")
        self.assertEqual(edition.detect_edition(None), "unknown")

    def test_resolve_prefers_detection_then_hint(self):
        self.assertEqual(edition.resolve_edition("lite", "suite"), ("lite", "detected"))
        self.assertEqual(edition.resolve_edition("unknown", "suite"), ("suite", "hint"))
        self.assertEqual(edition.resolve_edition("unknown", "bogus"), ("unknown", "none"))
        self.assertEqual(edition.resolve_edition("unknown", None), ("unknown", "none"))
        self.assertEqual(edition.resolve_edition("unknown", "unknown"), ("unknown", "none"))

    def test_limits_table(self):
        self.assertEqual(edition.limit_for("lite", "tracks"), 8)
        self.assertEqual(edition.limit_for("lite", "scenes"), 16)
        self.assertEqual(edition.limit_for("lite", "returns"), 2)
        self.assertIsNone(edition.limit_for("suite", "tracks"))
        self.assertEqual(edition.limit_for("standard", "returns"), 12)
        self.assertIsNone(edition.limit_for("unknown", "tracks"))

    def test_precheck_allows_last_free_slot_and_refuses_beyond(self):
        policy = edition.EditionPolicy("lite")
        policy.check("tracks", current=7)
        with self.assertRaises(BatutaError) as ctx:
            policy.check("tracks", current=8)
        self.assertEqual(ctx.exception.code, "edition_limit")
        self.assertEqual(ctx.exception.details,
                         {"resource": "tracks", "limit": 8, "current": 8, "edition": "lite"})

    def test_precheck_adding_more_than_one(self):
        policy = edition.EditionPolicy("lite")
        with self.assertRaises(BatutaError):
            policy.check("tracks", current=6, adding=3)
        policy.check("tracks", current=6, adding=2)

    def test_unlimited_and_unknown_editions_never_refuse(self):
        edition.EditionPolicy("suite").check("tracks", current=500)
        edition.EditionPolicy("unknown").check("scenes", current=500)
        with self.assertRaises(BatutaError):
            edition.EditionPolicy("suite").check("returns", current=12)

    def test_projection_uses_running_counts(self):
        policy = edition.EditionPolicy("lite")
        current = {"tracks": 6, "scenes": 0, "returns": 0}
        policy.check_projection(current, [{"tracks": 2}, {"tracks": -1}, {"tracks": 1}])
        with self.assertRaises(BatutaError) as ctx:
            policy.check_projection(current, [{"tracks": 1}, {"tracks": 1}, {"tracks": 1}])
        self.assertEqual(ctx.exception.code, "edition_limit")
        self.assertEqual(ctx.exception.details["op_index"], 2)
        self.assertEqual(ctx.exception.details["resource"], "tracks")

    def test_projection_ignores_ops_without_effect(self):
        edition.EditionPolicy("lite").check_projection(
            {"tracks": 8, "scenes": 0, "returns": 0}, [None, {}, {"tracks": -1}])

    def test_suspected_limit_message(self):
        self.assertTrue(edition.looks_like_limit_error("Maximum number of tracks reached"))
        self.assertTrue(edition.looks_like_limit_error("not available in Live Lite"))
        self.assertFalse(edition.looks_like_limit_error("index out of range"))


def make_world():
    state = ScriptState()
    midi = FakeTrack("Keys", audio=False)
    audio = FakeTrack("Vox", audio=True)
    song = FakeSong(tracks=[midi, audio])
    safe = FakeRoutingType("Keys", attached_object=midi)
    ext = FakeRoutingType("Ext. In", attached_object=None)
    audio.available_input_routing_types = [ext, safe]
    audio.input_routing_type = ext
    return state, song, midi, audio, safe, ext


class RecordingSafetyTests(unittest.TestCase):
    def rs(self, state, song):
        return RecordingSafety(state, lambda: song)

    def assertRefused(self, reason, call, *args):
        with self.assertRaises(BatutaError) as ctx:
            call(*args)
        self.assertEqual(ctx.exception.code, "not_supported")
        self.assertEqual(ctx.exception.details["reason"], reason)
        return ctx.exception

    # (a)
    def test_audio_arm_refused_midi_arm_allowed(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        rs.check_arm(midi)
        self.assertRefused("audio_arm_blocked", rs.check_arm, audio)

    # (b)
    def test_ears_track_arm_requires_safe_input(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        rs.register_ears_track(audio, "batuta-ears", True)
        audio.input_routing_type = safe
        rs.check_arm(audio)
        audio.input_routing_type = ext
        self.assertRefused("audio_arm_blocked", rs.check_arm, audio)
        audio.input_routing_type = FakeRoutingType("Resampling", attached_object=None)
        rs.check_arm(audio)

    # (c)
    def test_monitoring_in_refused_on_audio_only(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        self.assertRefused("monitor_in_blocked", rs.check_monitoring, audio, 0)
        rs.check_monitoring(audio, 1)
        rs.check_monitoring(audio, 2)
        rs.check_monitoring(midi, 0)

    # (d)
    def test_routing_name_collision_is_ambiguous(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        twin = FakeRoutingType("Keys", attached_object=audio)
        with self.assertRaises(BatutaError) as ctx:
            rs.resolve_routing_type([safe, twin], "Keys")
        self.assertEqual(ctx.exception.code, "invalid_args")
        self.assertEqual(ctx.exception.details["reason"], "ambiguous_name")
        self.assertEqual(len(ctx.exception.details["candidates"]), 2)
        with self.assertRaises(BatutaError) as ctx:
            rs.resolve_routing_type([safe], "Nope")
        self.assertEqual(ctx.exception.code, "not_found")
        self.assertIs(rs.resolve_routing_type([safe, ext], "Ext. In"), ext)

    # (e)
    def test_record_start_refused_while_external_live(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        rs.check_record_start("slot_fire")  # nothing external yet
        audio.arm = True  # a hand-armed audio track with an external input
        error = self.assertRefused("external_input_live", rs.check_record_start, "slot_fire")
        self.assertEqual(error.details["tracks"], ["Vox"])
        song.record_mode = True
        self.assertRefused("external_input_live", rs.check_playback_while_recording, song)
        song.record_mode = False
        song.session_record = False
        rs.check_playback_while_recording(song)  # plain playback stays allowed

    def test_monitoring_in_also_makes_a_track_external_live(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        audio.current_monitoring_state = 0
        self.assertEqual(rs.external_live_tracks(), ["Vox"])

    def test_safe_input_or_unarmed_is_not_external_live(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        self.assertEqual(rs.external_live_tracks(), [])  # external input but not armed/monitored
        audio.arm = True
        audio.input_routing_type = safe
        self.assertEqual(rs.external_live_tracks(), [])

    def test_midi_tracks_never_count_as_external_audio(self):
        state, song, midi, audio, safe, ext = make_world()
        midi.arm = True
        midi.input_routing_type = FakeRoutingType("All Ins", attached_object=None)
        self.assertEqual(self.rs(state, song).external_live_tracks(), [])

    # (f)
    def test_duplicate_of_external_live_track_refused(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        rs.check_duplicate(audio)
        audio.arm = True
        self.assertRefused("external_input_live", rs.check_duplicate, audio)

    # (g)
    def test_non_drum_rack_pads_are_not_read(self):
        # Owner's Lite run: Live raises "Only drum racks can have pads!" (not AttributeError) when
        # drum_pads is read on an Instrument or Audio Effect Rack.
        class InstrumentRack(FakeDevice):
            can_have_drum_pads = False

            @property
            def drum_pads(self):
                raise RuntimeError("Only drum racks can have pads!")

        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        audio.devices = [InstrumentRack("Rack", "InstrumentGroupDevice", chains=[FakeChain([])])]
        self.assertEqual(rs.external_live_tracks(), [])
        audio.devices = [InstrumentRack("Rack", "InstrumentGroupDevice", chains=[FakeChain([
            FakeDevice("External Audio Effect", "ExternalAudioEffect")])])]
        self.assertEqual(rs.external_live_tracks(), ["Vox"])

    def test_external_device_inside_rack_chain_and_drum_pad(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        hidden = FakeDevice("External Audio Effect", "ExternalAudioEffect")
        audio.devices = [FakeDevice("Rack", "AudioEffectGroupDevice",
                                    chains=[FakeChain([FakeDevice("Inner", "Group",
                                                                  chains=[FakeChain([hidden])])])])]
        self.assertEqual(rs.external_live_tracks(), ["Vox"])
        audio.devices = [FakeDevice("Drums", "DrumGroupDevice",
                                    drum_pads=[FakeDrumPad([FakeChain([hidden])])])]
        self.assertEqual(rs.external_live_tracks(), ["Vox"])
        audio.devices = [FakeDevice("Rack", "Group",
                                    chains=[FakeChain([FakeDevice("Ext", "Group")])],
                                    return_chains=[FakeChain([FakeDevice("External Instrument",
                                                                         "ExternalInstrument")])])]
        self.assertEqual(rs.external_live_tracks(), ["Vox"])

    def test_walk_depth_and_device_caps_fail_closed(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        device = FakeDevice("Leaf", "Generic")
        for _ in range(12):
            device = FakeDevice("Wrap", "Group", chains=[FakeChain([device])])
        audio.devices = [device]
        self.assertEqual(rs.external_live_tracks(), ["Vox"])
        audio.devices = [FakeDevice("D%d" % i) for i in range(501)]
        self.assertEqual(rs.external_live_tracks(), ["Vox"])
        audio.devices = [FakeDevice("D%d" % i) for i in range(500)]
        self.assertEqual(rs.external_live_tracks(), [])

    # (k)
    def test_external_device_found_on_return_master_and_group_tracks(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        bad = FakeDevice("External Audio Effect", "ExternalAudioEffect")
        ret = FakeTrack("A-Reverb", audio=True)
        song.return_tracks = [ret]
        ret.devices = [bad]
        self.assertEqual(rs.external_live_tracks(), ["A-Reverb"])
        ret.devices = []
        song.master_track.devices = [bad]
        self.assertEqual(rs.external_live_tracks(), ["Master"])
        song.master_track.devices = []
        group = FakeTrack("Group", audio=True)
        group.devices = [bad]
        song.tracks.append(group)
        self.assertEqual(rs.external_live_tracks(), ["Group"])

    # (h)
    def test_checks_are_evaluated_at_call_time_not_cached(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        rs.register_ears_track(audio, "batuta-ears", True)
        audio.input_routing_type = safe
        rs.check_arm(audio)
        audio.input_routing_type = ext  # a later op in the same batch re-routes
        self.assertRefused("audio_arm_blocked", rs.check_arm, audio)

    def test_routing_result_check_for_armed_ears_track(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        rs.register_ears_track(audio, "batuta-ears", True)
        audio.arm = True
        self.assertRefused("audio_arm_blocked", rs.check_routing_result, audio, ext)
        rs.check_routing_result(audio, safe)
        audio.arm = False
        rs.check_routing_result(audio, ext)  # not armed: allowed

    # (i)
    def test_ears_identity_is_by_object_not_name(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        impostor = FakeTrack("batuta-ears", audio=True)
        song.tracks.append(impostor)
        with self.assertRaises(BatutaError) as ctx:
            rs.check_track_name("batuta-ears", ears_internal=False)
        self.assertEqual(ctx.exception.code, "invalid_args")
        self.assertRefused("audio_arm_blocked", rs.check_arm, impostor)
        rs.register_ears_track(audio, "batuta-ears", True)
        audio.name = "renamed"
        self.assertTrue(rs.is_ears_track(audio))
        self.assertFalse(rs.is_ears_track(impostor))

    def test_ears_registration_rules(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        with self.assertRaises(BatutaError):
            rs.check_track_name("other", ears_internal=True)
        rs.check_track_name("fine", ears_internal=False)
        rs.register_ears_track(audio, "batuta-ears", True)
        other = FakeTrack("x", audio=True)
        with self.assertRaises(BatutaError) as ctx:
            rs.register_ears_track(other, "batuta-ears", True)
        self.assertEqual(ctx.exception.code, "invalid_args")

    def test_ears_track_forgotten_when_deleted_from_the_set(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        rs.register_ears_track(audio, "batuta-ears", True)
        song.tracks.remove(audio)
        self.assertFalse(rs.is_ears_track(audio))
        again = FakeTrack("batuta-ears", audio=True)
        song.tracks.append(again)
        rs.register_ears_track(again, "batuta-ears", True)

    # (j)
    def test_renamed_track_cannot_spoof_a_safe_input(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        # A track renamed "Ext. In" yields a routing type whose attached object is that track:
        # safe by object, while the real external input keeps being classified external.
        spoof_track = FakeTrack("Ext. In", audio=True)
        song.tracks.append(spoof_track)
        spoof_type = FakeRoutingType("Ext. In", attached_object=spoof_track)
        self.assertTrue(rs.is_input_safe(audio, spoof_type))
        self.assertFalse(rs.is_input_safe(audio, ext))
        with self.assertRaises(BatutaError):
            rs.resolve_routing_type([ext, spoof_type], "Ext. In")  # ambiguous, never picked

    def test_fallback_classification_without_attached_object(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        by_name = FakeRoutingTypeNoObject("Keys")
        audio.available_input_routing_types = [by_name, ext]
        self.assertTrue(rs.is_input_safe(audio, by_name))
        self.assertFalse(rs.is_input_safe(audio, FakeRoutingTypeNoObject("Ext. In")))
        self.assertFalse(rs.is_input_safe(audio, FakeRoutingTypeNoObject("Resampling")))
        spoof = FakeTrack("Ext. In", audio=True)
        song.tracks.append(spoof)
        self.assertFalse(rs.is_input_safe(audio, FakeRoutingTypeNoObject("Ext. In")))
        song.tracks.append(FakeTrack("Keys", audio=False))  # duplicate name: collision
        self.assertFalse(rs.is_input_safe(audio, by_name))

    def test_resampling_and_no_input_are_safe_when_not_a_track(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = self.rs(state, song)
        self.assertTrue(rs.is_input_safe(audio, FakeRoutingType("Resampling")))
        self.assertTrue(rs.is_input_safe(audio, FakeRoutingType("No Input")))
        self.assertFalse(rs.is_input_safe(audio, FakeRoutingType("Ext. In")))
        self.assertFalse(rs.is_input_safe(audio, FakeRoutingType("1/2")))


if __name__ == "__main__":
    unittest.main()
