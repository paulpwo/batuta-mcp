"""Recording safety policy (docs/01-protocol.md section 5.6): no microphone or line-in capture.

Handlers of T3/T4 call these guards before touching the LOM; each guard evaluates the CURRENT set
state (never cached) and raises a typed error. Nothing here writes to the LOM.

Layers: (1) audio tracks cannot be armed except the script's own ears track, (2) audio inputs
cannot be monitored, (3) no recording may start while an external-live track exists.
Track and device objects are accessed through plain attribute reads inside small helpers so a
missing attribute fails closed instead of crashing.
"""

from . import limits
from .errors import BatutaError
from .textutil import clean

MONITORING_IN = 0  # Live: 0 = In, 1 = Auto, 2 = Off (spec section 6.3)
MAX_WALK_DEPTH = 8
MAX_WALK_DEVICES = 500  # per track
MAX_WALK_DEVICES_TOTAL = 2000  # per check, across all tracks

_EXTERNAL_CLASS_NAMES = frozenset(["ExternalAudioEffect", "ExternalInstrument",
                                   "ProxyAudioEffectDevice", "ProxyInstrumentDevice"])  # assumption A38
_PROXY_PREFIX = "proxy"  # any other Proxy* class is treated as an external device too (fail closed)
_EXTERNAL_DEVICE_NAMES = frozenset(["External Audio Effect", "External Instrument"])
_NON_TRACK_TYPE_NAMES = frozenset(["Ext. In", "Resampling", "No Input"])
_SAFE_SPECIAL_NAMES = frozenset(["Resampling", "No Input"])  # only when not attached to a track
_SAFE_CATEGORIES = frozenset(["resampling", "noinput"])  # compared without case, spaces, underscores


def _blocked(reason, message, **details):
    details["reason"] = reason
    return BatutaError("not_supported", message, details)


class RecordingSafety:
    """Policy object bound to the script state and a callable returning the current Song."""

    def __init__(self, state, song_provider, acknowledged=None):
        self._state = state
        self._song = song_provider
        # The track ids the owner was shown and confirmed, when the server passed `external_input_ack` for
        # THIS request (None otherwise). Only the server sets it; no tool argument can. Anything but a
        # list of ids (a bare True, a text) counts as no acknowledgement.
        self.acknowledged = frozenset(acknowledged) if isinstance(acknowledged, (list, tuple, frozenset)) else None

    def _ack_or_raise(self, reason, message, extra=(), **details):
        """Pass when the request carries an acknowledgement that covers EVERY track that is, or with `extra`
        (the tracks this command would make external-live) would become, external-live. Otherwise refuse
        with `acknowledgeable: true` naming exactly those tracks and their ids, so the server asks again."""
        entries = self.external_live_entries()
        known = {track_id for track_id, _ in entries}
        for track in extra:
            track_id = self.track_id(track)
            if track_id is None or track_id in known:
                continue
            known.add(track_id)
            entries.append((track_id, getattr(track, "name", "")))
        if self.acknowledged is not None and known <= self.acknowledged:
            return
        details["acknowledgeable"] = True
        details["tracks"] = [clean(name, limits.MAX_NAME_CHARS) for _, name in entries[:20]]
        details["track_ids"] = [track_id for track_id, _ in entries][:128]
        raise _blocked(reason, message, **details)

    def ack_covers(self, extra=()):
        """True when an acknowledgement for this request covers the external-live tracks plus `extra`."""
        if self.acknowledged is None:
            return False
        known = {track_id for track_id, _ in self.external_live_entries()}
        known.update(track_id for track_id in (self.track_id(t) for t in extra) if track_id is not None)
        return known <= self.acknowledged

    # ------------------------------------------------------------ set inspection

    def all_tracks(self):
        song = self._song()
        return list(song.tracks) + list(song.return_tracks) + [song.master_track]

    @staticmethod
    def is_audio_track(track):
        """Fail closed: only a track that is positively MIDI-only counts as non-audio."""
        return not (getattr(track, "has_midi_input", None) is True
                    and getattr(track, "has_audio_input", None) is False)

    def is_input_safe(self, track, routing_type):
        """SAFE = attached to a track of this set, or Resampling/No Input. Classified by OBJECT."""
        tracks = self.all_tracks()
        try:
            attached = routing_type.attached_object
        except AttributeError:
            return self._safe_by_name_fallback(track, routing_type, tracks)
        if attached is not None:
            return any(_same(attached, candidate) for candidate in tracks)
        # Prefer the category: display names are localized, so the English names below are only
        # a fallback (assumption A35; the exact category values are to be checked in Live). The
        # category may be text or an enum member; for an enum its `name` is read. Any category
        # that is recognized as text but not SAFE is unsafe (fail closed); only an absent or
        # unreadable category falls back to the English display name.
        category = getattr(routing_type, "category", None)
        label = category if isinstance(category, str) else getattr(category, "name", None)
        key = "".join(ch for ch in label.lower() if ch.isalnum()) if isinstance(label, str) else ""
        if key:
            return key in _SAFE_CATEGORIES
        return getattr(routing_type, "display_name", None) in _SAFE_SPECIAL_NAMES

    def _safe_by_name_fallback(self, track, routing_type, tracks):
        """Assumption A35 false: a type is SAFE only if its name is one unambiguous track name."""
        name = getattr(routing_type, "display_name", None)
        if name is None or name in _NON_TRACK_TYPE_NAMES:
            return False
        if [getattr(t, "name", None) for t in tracks].count(name) != 1:
            return False
        offered = [getattr(t, "display_name", None)
                   for t in getattr(track, "available_input_routing_types", [])]
        count = offered.count(name)
        if not any(_same(t, routing_type) for t in getattr(track, "available_input_routing_types", [])):
            count += 1
        return count == 1

    def track_ids(self):
        """[(id, track)] over every track: "t<i>" tracks, "r<i>" returns, "m" master. Positions are the one
        identity the script can always read (names may repeat); a set that changed shape no longer matches."""
        song = self._song()
        pairs = [("t%d" % i, t) for i, t in enumerate(song.tracks)]
        pairs += [("r%d" % i, t) for i, t in enumerate(song.return_tracks)]
        return pairs + [("m", song.master_track)]

    def track_id(self, track):
        """The id of `track`, or None when it is not in the set (callers then fail closed)."""
        found = [track_id for track_id, other in self.track_ids() if _same(track, other)]
        return found[0] if len(found) == 1 else None

    def external_live_entries(self):
        """[(id, name)] of tracks that currently have a non-SAFE audio input in use or an External device."""
        found = []
        total_budget = [MAX_WALK_DEVICES_TOTAL]
        for track_id, track in self.track_ids():
            if self._is_external_live(track, total_budget):
                found.append((track_id, getattr(track, "name", "")))
        return found

    def external_live_tracks(self):
        """Names of tracks that currently have a non-SAFE audio input in use or an External device."""
        return [name for _, name in self.external_live_entries()]

    def recording_possible(self):
        """True while a recording runs or could start with no further command: a record flag, a slot that is
        recording, or the script's own ears track in the set."""
        song = self._song()
        if getattr(song, "record_mode", False) is True or getattr(song, "session_record", False) is True:
            return True
        if self.is_ears_track_registered():
            return True
        for track in list(song.tracks):
            try:
                if any(getattr(slot, "is_recording", False) is True for slot in track.clip_slots):
                    return True
            except (AttributeError, RuntimeError):
                return True  # unreadable slots: assume the worst
        return False

    def check_external_insert(self, track, command_name):
        """An External device is about to be inserted or loaded on `track`: while a recording is possible
        the owner must confirm it first (same ask as a recording start; the ack must name this track)."""
        if self.recording_possible():
            self._ack_or_raise("external_input_live", "an External device would capture its input while recording",
                               extra=[track], command=command_name)

    def external_allowed_on(self, track):
        """False when an External device landing on `track` now would be recorded without the owner's ack."""
        return not self.recording_possible() or self.ack_covers([track])

    def _is_external_live(self, track, total_budget=None):
        if self.is_audio_track(track) and self._input_in_use(track):
            current = getattr(track, "input_routing_type", None)
            if current is None or not self.is_input_safe(track, current):
                return True
        return _contains_external_device(track, total_budget or [MAX_WALK_DEVICES_TOTAL])

    @staticmethod
    def _input_in_use(track):
        return _arm_state(track) or _monitoring_state(track) == MONITORING_IN

    # ------------------------------------------------------------ guards

    def check_arm(self, track):
        """Rule 1: call before enabling `arm`."""
        if not self.is_audio_track(track):
            if getattr(track, "can_be_armed", None) is not True:
                raise _blocked("audio_arm_blocked", "this track cannot be armed")
            return
        if self.is_ears_track(track):
            current = getattr(track, "input_routing_type", None)
            if current is not None and self.is_input_safe(track, current):
                self.check_record_start("arm")  # an owner recording must not meet an ears arm
                return
            raise _blocked("audio_arm_blocked", "the ears track has an input that is not a track or Resampling")
        if self._has_external_input(track):
            self._ack_or_raise("audio_arm_blocked", "this audio track has an external input; arming it records that input",
                               extra=[track])
            return
        raise _blocked("audio_arm_blocked", "audio tracks cannot be armed by BatutaMCP")

    def _has_external_input(self, track):
        """True only for a readable input that is not SAFE; an unreadable one keeps the plain refusal."""
        try:
            current = track.input_routing_type
        except (AttributeError, RuntimeError):
            return False
        return current is not None and not self.is_input_safe(track, current)

    def check_monitoring(self, track, new_state):
        """Rule 2: monitoring In is refused on audio tracks (an external input can be acknowledged)."""
        if self.is_audio_track(track) and new_state == MONITORING_IN:
            if self._has_external_input(track):
                self._ack_or_raise("monitor_in_blocked", "monitoring In would pass this track's external input through",
                                   extra=[track])
                return
            raise _blocked("monitor_in_blocked", "monitoring In is not allowed on audio tracks")

    def check_routing_result(self, track, new_input_type):
        """Rule 3: an audio track whose input is in use may only be routed to a SAFE input."""
        if not self.is_audio_track(track) or self.is_input_safe(track, new_input_type):
            return
        if _arm_state(track):
            raise _blocked("audio_arm_blocked", "an armed audio track may only use a track or Resampling input")
        if _monitoring_state(track) == MONITORING_IN:
            raise _blocked("monitor_in_blocked", "a monitored audio track may only use a track or Resampling input")

    def resolve_routing_type(self, available, display_name, what="routing_type"):
        """Match `display_name` against routing objects (types or channels); never pick among duplicates."""
        matches = [(position, item) for position, item in enumerate(available)
                   if getattr(item, "display_name", None) == display_name]
        if not matches:
            raise BatutaError("not_found", "routing option not found",
                              {"what": what,
                               "available": [clean(getattr(i, "display_name", ""), limits.MAX_NAME_CHARS)
                                              for i in available][:50]})
        if len(matches) > 1:
            raise BatutaError("invalid_args", "routing option name is ambiguous",
                              {"reason": "ambiguous_name",
                               "candidates": [{"index": position,
                                               "name": clean(display_name, limits.MAX_NAME_CHARS)}
                                              for position, _ in matches[:10]]})
        return matches[0][1]

    def check_record_start(self, command_name):
        """Rule 4: commands that start recording are refused while an external-live track exists."""
        if self.external_live_entries():
            self._ack_or_raise("external_input_live", "an external input is live; recording is refused",
                               command=command_name)

    def check_playback_while_recording(self, song):
        """Rule 4 tail: starting playback is refused only when record flags are already on."""
        if getattr(song, "record_mode", False) is True or getattr(song, "session_record", False) is True:
            self.check_record_start("playback")

    def check_duplicate(self, track):
        """Rule 6: duplicating an external-live track would copy its armed/monitored path."""
        live = self._is_external_live(track)
        if live:
            self._ack_or_raise("external_input_live", "an external-live track cannot be duplicated", extra=[track])
        armed = _arm_state(track) and not (live and self.acknowledged is not None)
        if self.is_audio_track(track) and (self.is_ears_track(track) or armed):
            raise _blocked("audio_arm_blocked", "the ears track and armed audio tracks cannot be duplicated")

    # ------------------------------------------------------------ ears track identity

    def check_track_name(self, name, ears_internal):
        """The reserved name is only valid together with ears_internal (spec 7.2, 5.6)."""
        lookalike = isinstance(name, str) and name.strip().casefold() == limits.EARS_TRACK_NAME
        if lookalike and not ears_internal:
            raise BatutaError("invalid_args", "the track name batuta-ears is reserved",
                              {"reason": "reserved_name"})
        if ears_internal and name != limits.EARS_TRACK_NAME:
            raise BatutaError("invalid_args", "ears_internal requires the reserved track name",
                              {"reason": "reserved_name"})

    def precheck_ears_track(self, name, ears_internal):
        """Handlers MUST call this BEFORE creating the track, so a refusal leaves nothing behind."""
        self.check_track_name(name, ears_internal)
        if ears_internal and self.is_ears_track_registered():
            raise BatutaError("invalid_args", "an ears track already exists",
                              {"reason": "ears_exists"})

    def register_ears_track(self, track, name, ears_internal):
        """Call after creation; repeats the precheck so direct use cannot bypass it."""
        self.precheck_ears_track(name, ears_internal)
        if ears_internal:
            self._state.ears_track = track

    def is_ears_track_registered(self):
        """True while the remembered ears track still exists in the set (forgets deleted ones)."""
        remembered = self._state.ears_track
        if remembered is None:
            return False
        if any(_same(remembered, candidate) for candidate in self.all_tracks()):
            return True
        self._state.ears_track = None
        return False

    def is_ears_track(self, track):
        return self.is_ears_track_registered() and _same(track, self._state.ears_track)


def _same(first, second):
    """Live hands out a new Python wrapper per access, so compare with == (identity is a shortcut)."""
    return first is second or (first is not None and second is not None and first == second)


def _arm_state(track):
    """True for an armable track that is armed or whose state cannot be read; unarmable tracks are skipped."""
    if getattr(track, "can_be_armed", None) is not True:
        return False
    try:
        return getattr(track, "arm", False) is True
    except RuntimeError:
        return True  # armable but unreadable: assume armed (fail closed)


def _monitoring_state(track):
    try:
        return getattr(track, "current_monitoring_state", None)
    except RuntimeError:
        return None


def is_external_device(device):
    """True for an External Audio Effect / External Instrument or a Proxy device, by class name
    (also any class starting with "proxy") or device name (A38)."""
    class_name = getattr(device, "class_name", "")
    if class_name in _EXTERNAL_CLASS_NAMES:
        return True
    if isinstance(class_name, str) and class_name.casefold().startswith(_PROXY_PREFIX):
        return True
    return getattr(device, "name", "") in _EXTERNAL_DEVICE_NAMES


def _contains_external_device(track, total_budget):
    """Walk devices, chains, return chains and drum pads; fail closed when the caps are hit."""
    budget = [MAX_WALK_DEVICES, total_budget]
    try:
        return _walk(getattr(track, "devices", []), 1, budget)
    except _WalkLimit:
        return True


class _WalkLimit(Exception):
    pass


def _walk(devices, depth, budget):
    if depth > MAX_WALK_DEPTH and len(devices):
        raise _WalkLimit()
    for device in devices:
        budget[0] -= 1
        budget[1][0] -= 1
        if budget[0] < 0 or budget[1][0] < 0:
            raise _WalkLimit()
        if is_external_device(device):
            return True
        for chain in list(getattr(device, "chains", [])) + list(getattr(device, "return_chains", [])):
            if _walk(getattr(chain, "devices", []), depth + 1, budget):
                return True
        # Live raises (not AttributeError) when drum_pads is read on a rack that is not a Drum Rack.
        pads = [] if getattr(device, "can_have_drum_pads", True) is False else getattr(device, "drum_pads", [])
        for pad in pads:
            for chain in getattr(pad, "chains", []):
                if _walk(getattr(chain, "devices", []), depth + 1, budget):
                    return True
    return False
