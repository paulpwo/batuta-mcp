"""T5c-1 parity additions: view_show / view_focus / view_get, global clip_trigger_quantization in
song_set / song_info, and device_insert on return and master tracks."""

import sys
import unittest

from remote_script.BatutaMCP.command_set import build_registry

from . import fakes
from .device_world import C, M, R0, T1, DeviceCase
from .fake_lom import LomHarness

LIVE_NAMES = {"session": "Session", "arrangement": "Arranger", "detail_clip": "Detail/Clip",
              "detail_device": "Detail/DeviceChain", "browser": "Browser"}
LABELS = ["none", "8 bars", "4 bars", "2 bars", "1 bar", "1/2", "1/2T", "1/4", "1/4T", "1/8", "1/8T",
          "1/16", "1/16T", "1/32"]


class ViewCase(unittest.TestCase):
    def setUp(self):
        self.live = fakes.install_fake_live("12.4.7")
        self.addCleanup(fakes.uninstall_fake_live)
        self.view = self.live.Application.get_application().view
        self.h = LomHarness()

    def assertNoSetEffects(self):
        self.assertEqual(self.h.song.events, [])
        self.assertEqual(self.h.song.log, [])


class CatalogTests(unittest.TestCase):
    def test_view_commands_are_registered_non_mutating_and_never_destructive(self):
        entries = {e["name"]: e for e in build_registry().catalog_entries()}
        for name in ("view_show", "view_focus", "view_get"):
            self.assertEqual(entries[name], {"name": name, "mutating": False, "destructive": "never",
                                             "conditions": []}, name)

    def test_catalog_is_83_plus_three_view_commands(self):
        self.assertEqual(len(build_registry().names()), 86)

    def test_view_commands_are_not_resumable_and_have_no_edition_delta(self):
        registry = build_registry()
        for name in ("view_show", "view_focus", "view_get"):
            self.assertFalse(registry.get(name).resumable)
            self.assertIsNone(registry.get(name).edition_delta)


class ViewShowTests(ViewCase):
    def test_each_view_maps_to_the_live_name(self):
        for arg, live in LIVE_NAMES.items():
            self.view.calls[:] = []
            result = self.h.ok("view_show", {"view": arg})
            self.assertEqual(self.view.calls, [("show_view", live)], arg)
            self.assertEqual(result, {"view": arg, "visible": True}, arg)
        self.assertNoSetEffects()

    def test_switching_main_view_hides_the_other(self):
        self.h.ok("view_show", {"view": "arrangement"})
        self.assertEqual(self.h.ok("view_get")["main"], "arrangement")
        self.h.ok("view_show", {"view": "session"})
        self.assertEqual(self.h.ok("view_get")["main"], "session")

    def test_invalid_views_are_refused_before_any_call(self):
        for bad in ("Session", "Arranger", "Detail", "detail", "SESSION", "", None, 1, True,
                    ["session"], "session\n"):
            self.assertEqual(self.h.error("view_show", {"view": bad})["code"], "invalid_args", bad)
        self.assertEqual(self.h.error("view_show", {})["code"], "invalid_args")
        self.assertEqual(self.h.error("view_show", {"view": "session", "x": 1})["code"], "invalid_args")
        self.assertEqual(self.view.calls, [])

    def test_live_failure_is_reported_without_set_effects(self):
        self.view.fail_with = RuntimeError("boom")
        self.assertEqual(self.h.error("view_show", {"view": "session"})["code"], "lom_error")
        self.assertNoSetEffects()

    def test_without_the_application_view_it_is_not_supported(self):
        del sys.modules["Live"]
        error = self.h.error("view_show", {"view": "session"})
        self.assertEqual(error["code"], "not_supported")
        self.assertEqual(error["details"]["reason"], "live_version")

    def test_works_inside_a_batch_without_an_undo_step_of_its_own(self):
        result = self.h.ok("batch", {"ops": [{"cmd": "view_show", "args": {"view": "browser"}}]})
        self.assertTrue(result["results"][0]["ok"])
        self.assertEqual(self.view.calls, [("show_view", "Browser")])
        self.assertEqual(self.h.song.events, [])
        mixed = self.h.ok("batch", {"ops": [{"cmd": "view_show", "args": {"view": "arrangement"}},
                                            {"cmd": "song_set", "args": {"tempo": 100}}]})
        self.assertTrue(all(r["ok"] for r in mixed["results"]))
        self.assertEqual(self.h.song.events, ["begin", "end"])


class ViewFocusTests(ViewCase):
    def test_each_view_maps_to_the_live_name_via_focus_view(self):
        for arg, live in LIVE_NAMES.items():
            self.view.calls[:] = []
            result = self.h.ok("view_focus", {"view": arg})
            self.assertEqual(self.view.calls, [("focus_view", live)], arg)
            self.assertEqual(result, {"view": arg, "visible": True}, arg)
        self.assertNoSetEffects()

    def test_invalid_view_refused(self):
        for bad in ("Browser", "nope", None, 3):
            self.assertEqual(self.h.error("view_focus", {"view": bad})["code"], "invalid_args", bad)
        self.assertEqual(self.view.calls, [])

    def test_live_failure_reported(self):
        self.view.fail_with = RuntimeError("boom")
        self.assertEqual(self.h.error("view_focus", {"view": "session"})["code"], "lom_error")


class ViewGetTests(ViewCase):
    def test_reports_main_view_and_every_visibility(self):
        result = self.h.ok("view_get")
        self.assertEqual(result["main"], "session")
        self.assertEqual(result["visible"], {"session": True, "arrangement": False, "detail_clip": False,
                                             "detail_device": False, "browser": False})
        self.h.ok("view_show", {"view": "detail_device"})
        self.h.ok("view_show", {"view": "arrangement"})
        result = self.h.ok("view_get")
        self.assertEqual(result["main"], "arrangement")
        self.assertTrue(result["visible"]["detail_device"])
        self.assertFalse(result["visible"]["session"])

    def test_main_is_null_when_neither_main_view_is_visible(self):
        self.view.visible.clear()
        self.assertIsNone(self.h.ok("view_get")["main"])

    def test_read_never_shows_or_focuses_and_never_touches_the_set(self):
        self.h.ok("view_get")
        self.assertEqual(self.view.calls, [])
        self.assertNoSetEffects()

    def test_args_are_rejected(self):
        self.assertEqual(self.h.error("view_get", {"view": "session"})["code"], "invalid_args")

    def test_missing_is_view_visible_is_not_supported(self):
        class NoVisible:
            def show_view(self, name):
                pass
        self.live.Application.get_application().view = NoVisible()
        error = self.h.error("view_get")
        self.assertEqual(error["code"], "not_supported")
        self.assertEqual(error["details"]["reason"], "live_version")


class ClipTriggerQuantizationTests(ViewCase):
    def test_song_info_reports_index_and_label(self):
        self.assertEqual(self.h.ok("song_info")["clip_trigger_quantization"], {"index": 4, "label": "1 bar"})

    def test_every_label_sets_its_index_in_enum_order(self):
        for index, label in enumerate(LABELS):
            result = self.h.ok("song_set", {"clip_trigger_quantization": label})
            self.assertEqual(result["applied"], ["clip_trigger_quantization"])
            self.assertEqual(self.h.song.clip_trigger_quantization, index, label)
            self.assertEqual(self.h.ok("song_info")["clip_trigger_quantization"],
                             {"index": index, "label": label})

    def test_every_index_is_accepted_and_written_as_an_int(self):
        for index in range(14):
            self.h.ok("song_set", {"clip_trigger_quantization": index})
            self.assertIs(type(self.h.song.clip_trigger_quantization), int)
            self.assertEqual(self.h.song.clip_trigger_quantization, index)

    def test_one_undo_step_and_applied_alongside_other_fields(self):
        self.h.reset_log()
        result = self.h.ok("song_set", {"tempo": 99, "clip_trigger_quantization": "1/8"})
        self.assertEqual(sorted(result["applied"]), ["clip_trigger_quantization", "tempo"])
        self.assertEqual(self.h.song.events, ["begin", "end"])
        self.assertEqual(self.h.song.clip_trigger_quantization, 9)

    def test_invalid_values_leave_no_trace(self):
        for bad in (14, -1, 1.5, True, False, None, "", "2 beats", "1 BAR", "1 bar ", "1/64", ["1 bar"],
                    {"index": 1}, "1\n"):
            self.h.reset_log()
            self.assertEqual(self.h.error("song_set", {"clip_trigger_quantization": bad})["code"],
                             "invalid_args", bad)
            self.assertNoSetEffects()
            self.assertEqual(self.h.song.clip_trigger_quantization, 4)

    def test_song_info_with_an_unknown_enum_value_has_a_null_label(self):
        self.h.song.clip_trigger_quantization = 99
        self.assertEqual(self.h.ok("song_info")["clip_trigger_quantization"], {"index": 99, "label": None})

    def test_song_info_without_the_property_reports_null(self):
        del self.h.song.clip_trigger_quantization
        self.assertIsNone(self.h.ok("song_info")["clip_trigger_quantization"])

    def test_works_inside_a_batch(self):
        result = self.h.ok("batch", {"ops": [{"cmd": "song_set",
                                              "args": {"clip_trigger_quantization": "none"}}]})
        self.assertTrue(result["results"][0]["ok"])
        self.assertEqual(self.h.song.clip_trigger_quantization, 0)

    def test_song_info_stays_a_pure_read(self):
        self.h.ok("song_info")
        self.assertNoSetEffects()


class DeviceInsertMasterAndReturnTests(DeviceCase):
    def test_inserts_on_a_return_track(self):
        result = self.h.ok("device_insert", {"container": C(R0), "name": "Compressor"})
        self.assertEqual(result["device"]["name"], "Compressor")
        self.assertEqual(result["device"]["path"], [1])
        self.assertEqual(self.names(R0), ["Reverb", "Compressor"])
        self.assertEqual(self.h.song.events, ["begin", "end"])
        self.assertIn("call:Track.insert_device", self.h.song.log)

    def test_inserts_on_the_master_track_at_an_index(self):
        result = self.h.ok("device_insert", {"container": C(M), "name": "Utility", "index": 0})
        self.assertEqual(result["device"]["path"], [0])
        self.assertEqual(self.names(M), ["Utility", "Master Utility"])
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_inserts_into_an_empty_return_and_master_chain_after_clearing(self):
        self.h.song.return_tracks[0].devices[:] = []
        self.h.song.master_track.devices[:] = []
        self.assertEqual(self.h.ok("device_insert", {"container": C(R0), "name": "Reverb"})
                         ["device"]["path"], [0])
        self.assertEqual(self.h.ok("device_insert", {"container": C(M), "name": "Compressor"})
                         ["device"]["path"], [0])

    def test_out_of_range_and_unknown_names_on_master_and_return(self):
        for ref in (R0, M):
            self.assertEqual(self.h.error("device_insert", {"container": C(ref), "name": "Utility",
                                                           "index": 9})["code"], "out_of_range")
            self.assertEqual(self.h.error("device_insert", {"container": C(ref), "name": "Nope"})["code"],
                             "not_found")

    def test_blocked_names_are_refused_before_any_call_on_master_and_return(self):
        for ref in (R0, M):
            for name in ("External Audio Effect", "External Instrument", "Max Audio Effect"):
                self.h.reset_log()
                error = self.h.error("device_insert", {"container": C(ref), "name": name})
                self.assertEqual(error["code"], "not_supported", name)
                self.assertEqual(error["details"]["reason"], "blocked_content", name)
                self.assertEqual(self.h.song.log, [])
                self.assertEqual(self.h.song.events, [])

    def test_hostile_device_inserted_on_master_is_removed_again(self):
        from .fake_devices import external_device
        self.h.song.device_factories["Sneaky"] = external_device
        before = self.names(M)
        error = self.h.error("device_insert", {"container": C(M), "name": "Sneaky"})
        self.assertEqual(error["code"], "not_supported")
        self.assertEqual(self.names(M), before)

    def test_inside_a_batch_on_return_and_master(self):
        result = self.h.ok("batch", {"ops": [
            {"cmd": "device_insert", "args": {"container": C(R0), "name": "Utility"}},
            {"cmd": "device_insert", "args": {"container": C(M), "name": "Compressor"}}]})
        self.assertTrue(all(r["ok"] for r in result["results"]))
        self.assertEqual(self.h.song.events, ["begin", "end"])

    def test_a_live_without_track_insert_device_is_not_supported_on_master_and_return(self):
        for track in (self.h.song.master_track, self.h.song.return_tracks[0]):
            base = type(track)

            class NoInsert(base):
                def __getattribute__(self, name):
                    if name == "insert_device":
                        raise AttributeError(name)
                    return base.__getattribute__(self, name)
            track.__class__ = NoInsert
        for ref in (R0, M):
            self.h.reset_log()
            error = self.h.error("device_insert", {"container": C(ref), "name": "Utility"})
            self.assertEqual((error["code"], error["details"]["reason"]), ("not_supported", "live_version"))
            self.assertEqual(self.h.song.log, [])

    def test_audio_track_still_works(self):
        self.assertEqual(self.h.ok("device_insert", {"container": C(T1), "name": "Reverb"})
                         ["device"]["path"], [1])


if __name__ == "__main__":
    unittest.main()
