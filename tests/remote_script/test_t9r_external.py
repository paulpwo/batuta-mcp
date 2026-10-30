"""T9r part 2: External devices load by default (browser.allow_external_devices) and recording with a
live external input is acknowledgeable instead of final: the refusal carries `acknowledgeable: true`
and the same request passes when the server sends `external_input_ack` (never a tool argument)."""

import unittest

from remote_script.BatutaMCP import browser_policy, content_policy

from .browser_world import BrowserCase
from .clip_world import ClipCase
from .device_world import T1, T0
from .fake_devices import external_device, FakeDevice
from .test_t4b_review_sweep import SweepCase
from .fake_browser import devices_loader

EXT = {"allow_external_devices": True}
ACK = {"external_input_ack": ["t1"]}  # the ids the server sends back (the T9s binding)


class ExternalDeviceBrowserTests(BrowserCase):
    def names(self):
        return [d.name for d in self.h.song.tracks[1].devices]

    def test_classify(self):
        name = "External Instrument"
        self.assertEqual(browser_policy.classify("instruments", "query:Instruments#External%20Instrument", True,
                                                 {}, None, name), "external_device")
        self.assertIsNone(browser_policy.classify("instruments", "query:Instruments#External%20Instrument", True,
                                                  EXT, None, name))

    def test_insert_names_and_offence(self):
        self.assertEqual(content_policy.blocked_insert_name("External Audio Effect"), "external_device")
        self.assertIsNone(content_policy.blocked_insert_name("External Audio Effect", allow_external=True))
        self.assertIsNone(content_policy.blocked_insert_name("ProxyInstrumentDevice", allow_external=True))
        self.assertEqual(content_policy.offence(external_device(), False), "external_device")
        self.assertIsNone(content_policy.offence(external_device(), False, allow_external=True))
        self.assertEqual(content_policy.offence(FakeDevice("Rack", "PluginDevice"), False, allow_external=True),
                         "plugin")

    def test_an_external_device_in_a_rack_stays_with_the_flag_and_goes_without(self):
        uri = self.listed_uri("sounds", "Ext.adg", ["Bass"], flags=EXT)
        self.assertTrue(self.load(uri, T1)["ok"])
        pad_devices = sum(len(c.devices) for pad in self.h.song.tracks[1].devices[-1].drum_pads
                          for c in pad.chains)
        self.assertEqual(pad_devices, 1)
        self.h.flags = {}
        response = self.load(uri, T1)
        self.assertEqual(response["error"]["details"]["removed"], ["external_device"])

    def test_an_external_class_behind_an_innocent_uri_loads_with_the_flag(self):
        uri = self.listed_uri("instruments", "Mystery Synth", flags=EXT)
        self.assertTrue(self.load(uri, T1)["ok"])
        self.assertEqual(len(self.names()), 2)

    def test_max_for_live_flag_does_not_open_external(self):
        uri = self.listed_uri("sounds", "Ext.adg", ["Bass"], flags={"allow_max_for_live": True})
        self.assertEqual(self.load(uri, T1)["error"]["details"]["removed"], ["external_device"])


class ExternalSweepTests(SweepCase):
    def test_a_late_external_device_stays_with_the_flag(self):
        self.h.flags = EXT
        uri = self.put("Late.adg", loader=devices_loader(external_device), deferred=1)
        self.load(uri, T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor", "Line Out"])

    def test_a_late_external_device_is_swept_without_the_flag(self):
        uri = self.put("Late.adg", loader=devices_loader(external_device), deferred=1)
        self.load(uri, T1)
        self.land(self.pump())
        self.assertEqual(self.names(), ["Compressor"])


class AcknowledgeTests(ClipCase):
    """Track 1 is an audio track on Ext. In, armed by hand: an external input is live."""

    def refusal(self, name, args):
        error = self.h.error(name, args)
        self.assertEqual(error["code"], "not_supported", error)
        return error["details"]

    def test_refusals_are_acknowledgeable_and_name_the_tracks(self):
        self.external_live()
        for name, args in (("song_set", {"record_mode": True}), ("trigger_session_record", {}),
                           ("slot_fire", {"track": T0, "slot": 0, "record_length": 4}),
                           ("song_set", {"session_record": True})):
            details = self.refusal(name, args)
            self.assertEqual(details["reason"], "external_input_live")
            self.assertIs(details["acknowledgeable"], True)
            self.assertTrue(details["tracks"])

    def test_the_ack_lets_the_same_requests_through(self):
        self.external_live()
        self.h.flags = ACK
        self.h.ok("song_set", {"record_mode": True})
        self.assertTrue(self.h.song.record_mode)
        self.h.ok("trigger_session_record", {})

    def test_the_ack_is_per_request_and_not_a_tool_argument(self):
        self.external_live()
        error = self.h.error("song_set", {"record_mode": True, "external_input_ack": True})
        self.assertEqual(error["code"], "invalid_args")
        self.assertFalse(self.h.song.record_mode)

    def test_arming_and_monitoring_an_external_audio_track_ask_and_pass_with_the_ack(self):
        track = self.h.song.tracks[1]
        for args in ({"arm": True}, {"monitoring_state": 0}):
            details = self.refusal("track_set", dict(args, track=T1))
            self.assertIs(details["acknowledgeable"], True, args)
            self.assertEqual(details["tracks"], [track.name])
        self.h.flags = ACK
        self.h.ok("track_set", {"track": T1, "arm": True})
        self.h.ok("track_set", {"track": T1, "monitoring_state": 0})

    def test_a_safe_audio_track_stays_unarmable_even_with_the_ack(self):
        track = self.h.song.tracks[1]
        for option in track.available_input_routing_types:
            if getattr(option, "display_name", "") == "Resampling":
                track.input_routing_type = option
        self.h.flags = ACK
        details = self.h.error("track_set", {"track": T1, "arm": True})["details"]
        self.assertEqual(details["reason"], "audio_arm_blocked")
        self.assertNotIn("acknowledgeable", details)

    def test_duplicate_of_an_external_live_track(self):
        self.external_live()
        details = self.refusal("track_duplicate", {"track": T1})
        self.assertIs(details["acknowledgeable"], True)
        self.h.flags = ACK
        self.h.ok("track_duplicate", {"track": T1})

    def test_a_batch_that_needs_the_ack_is_refused_before_anything_runs(self):
        self.external_live()
        ops = [{"cmd": "song_set", "args": {"tempo": 100}}, {"cmd": "song_set", "args": {"record_mode": True}}]
        response = self.h.run("batch", {"ops": ops})
        self.assertFalse(response["ok"])
        self.assertIs(response["error"]["details"]["acknowledgeable"], True)
        self.assertEqual(self.h.song.log, [])
        self.h.flags = ACK
        self.assertTrue(self.h.run("batch", {"ops": ops})["ok"])

    def test_the_ears_arm_rule_is_not_relaxed_by_the_ack(self):
        self.h.flags = ACK
        error = self.h.error("track_create", {"type": "audio", "name": "batuta-ears"})
        self.assertEqual(error["details"]["reason"], "reserved_name")


if __name__ == "__main__":
    unittest.main()
