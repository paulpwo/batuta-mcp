"""Deferred sweep for browser loads that have not landed yet (assumption A23).

If `load_item` is asynchronous, the new devices are not there when the handler returns, so the
post-load cleanup would see nothing. The load then registers a `Sweep`: update_display steps it once
per tick for up to 20 ticks (about 2 s). Cleanup only: it cannot stop code that already ran while the
item loaded, and one Cmd-Z after a sweep restores the blocked device (two undo the load).

What a sweep may touch is narrow, because it runs while the user (and the model) keep working:
  * it ends only when something NEW shows up that a load could have added; a device the user deleted
    just re-baselines it and it keeps ticking, and a timeout is reported unverified;
  * on the target track only new TOP-LEVEL devices at the load's insertion point count: appended after
    the previous last device, or (instruments) in the first slot or in the slot of a removed
    instrument. Anything the user adds elsewhere, or inside an existing rack, is left alone;
  * a new track counts as created by Live only if exactly one track appeared and it sits next to the
    target (index target - 1 or target + 1). Anything else is the user's and is ignored;
  * the selection the load restored (the previous track, when it is not the target) is watched with the
    same rules: an asynchronous load can still land there, and an offender at its insertion point goes;
  * tracks and devices the script itself makes in the window (track_create, track_duplicate,
    device_insert, browser_load, drum_pad_copy, also inside batch) are absorbed by `rebaseline`.

Residual risk, accepted: a user who hand-adds a device at the very same insertion point (or hand-
creates a single track right next to the target) inside the 2 s window looks exactly like the load
and is swept like it. The window is short and the sweep only removes Max for Live (unless allowed), disallowed
plugin and External devices.
"""

from . import content_policy, limits, lom

INSTRUMENT_TYPE = 1


class Sweep:
    def __init__(self, track, baseline, tracks_before, allow_plugins, also=None, allow_max=False, allow_external=False):
        self.track = track
        self.also_track, self.also_baseline = also if also is not None else (None, None)
        self.baseline = baseline
        self.tracks_before = tracks_before
        self.allow_plugins = allow_plugins
        self.allow_max = allow_max
        self.allow_external = allow_external
        self.ticks_left = limits.SWEEP_TICKS

    def rebaseline(self, song):
        """Absorb whatever the script itself just changed (called after its own mutations)."""
        try:
            tracks = lom.safe(lambda: list(song.tracks), [])
            if _exists(song, self.track):
                self.baseline = content_policy.Baseline(self.track)
            if self.also_track is not None and _exists(song, self.also_track):
                self.also_baseline = content_policy.Baseline(self.also_track)
            self.tracks_before = tracks
        except Exception:  # a failed refresh leaves the older, stricter baseline in place
            pass

    def step(self, song, log):
        """One tick. Returns the outcome dict when the sweep is over, else None. Never raises."""
        try:
            return self._step(song, log)
        except Exception as exc:  # a failing sweep must not take update_display down
            return self._done(log, "error", verified=False, exception=type(exc).__name__)

    def _step(self, song, log):
        tracks = lom.safe(lambda: list(song.tracks), [])
        if not _exists(song, self.track):
            return self._done(log, "track_gone", verified=False)
        now = content_policy.Baseline(self.track)
        eligible = self._eligible(self.baseline, now)
        also_now, also_eligible = None, []
        if self.also_track is not None and not _exists(song, self.also_track):
            self.also_track = self.also_baseline = None     # the previous track went away: nothing to watch
        if self.also_track is not None:
            also_now = content_policy.Baseline(self.also_track)
            also_eligible = self._eligible(self.also_baseline, also_now)
        created = self._live_created(tracks)
        if not eligible and not also_eligible and not created:
            if now.truncated or (also_now is not None and also_now.truncated):
                return self._done(log, "error", verified=False, exception="tree_too_large")
            self.baseline, self.tracks_before = now, tracks   # removals and hand edits are absorbed
            if also_now is not None:
                self.also_baseline = also_now
            self.ticks_left -= 1
            return self._done(log, "timeout", verified=False) if self.ticks_left <= 0 else None
        reasons = []
        song.begin_undo_step()
        try:
            found, verified = content_policy.purge_new_devices(self.track, self.baseline,
                                                               self.allow_plugins, only=eligible,
                                                               allow_max=self.allow_max, allow_external=self.allow_external)
            reasons += found
            if also_eligible:
                found, ok = content_policy.purge_new_devices(self.also_track, self.also_baseline,
                                                             self.allow_plugins, only=also_eligible,
                                                             allow_max=self.allow_max, allow_external=self.allow_external)
                reasons += found
                verified = verified and ok
            for track in created:
                found, ok = content_policy.purge_new_devices(track, content_policy.Baseline(None),
                                                             self.allow_plugins, allow_max=self.allow_max, allow_external=self.allow_external)
                reasons += found
                verified = verified and ok
        finally:
            song.end_undo_step()
        return self._done(log, "swept" if reasons else "clean", reasons, verified,
                          **lom.created_tracks_report(song, created))

    def _live_created(self, tracks):
        """The one new track next to the target, or []: other new tracks are not the load's."""
        fresh = lom.new_items(self.tracks_before, tracks)
        if len(fresh) != 1:
            return []
        where = lom.position_of(tracks, fresh[0])
        mine = lom.position_of(tracks, self.track)
        if where is None or mine is None or abs(where - mine) != 1:
            return []
        return fresh

    @staticmethod
    def _eligible(baseline, now):
        """New top-level devices sitting where a load puts them (see the module comment)."""
        old, top = baseline.top, now.top
        kept = [i for i, device in enumerate(top) if any(lom.same(device, was) for was in old)]
        last = kept[-1] if kept else -1
        freed = [i for i, was in enumerate(old)
                 if _is_instrument(was) and not any(lom.same(was, device) for device in top)]
        found = []
        for index, device in enumerate(top):
            if index in kept:
                continue
            if index > last or (_is_instrument(device) and (index == 0 or index in freed)):
                found.append(device)
        return found

    @staticmethod
    def _done(log, state, removed=(), verified=True, **extra):
        outcome = {"state": state, "removed": list(removed), "verified": verified}
        outcome.update(extra)
        log("sweep %s: removed %d, verified %s" % (state, len(outcome["removed"]), verified))
        return outcome


def _exists(song, track):
    """The target is still part of the set: a regular track, a return track or the master."""
    return lom.ref_for(song, track) is not None


def _is_instrument(device):
    return lom.safe(lambda: int(device.type)) == INSTRUMENT_TYPE
