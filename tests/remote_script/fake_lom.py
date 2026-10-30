"""A realistic fake Live Object Model for the T3 command tests.

It mimics the behaviours the commands depend on: return/master tracks raise RuntimeError when
`arm` is read (like Live), routing setters only accept objects from the available lists, parameter
setters reject out-of-range values, cue points toggle at the playhead, and every write to a fake
object is recorded in `song.log` so tests can prove that read commands never mutate.
"""

import math

from remote_script.BatutaMCP.dispatcher import Dispatcher, Job
from remote_script.BatutaMCP.errors import BatutaError
from remote_script.BatutaMCP.command_set import build_registry
from remote_script.BatutaMCP.state import ScriptState

from .fakes import FakeCInstance, FakeClock, FakeRoutingType


# Live toggles a cue within its own (wider) tolerance; the script's guard is only 1e-6 beats.
CUE_TOGGLE_TOLERANCE = 1e-3


class Logged:
    """Records every attribute write once `_log` is attached (construction writes are not logged)."""

    def __setattr__(self, name, value):
        log = self.__dict__.get("_log")
        if log is not None and not name.startswith("_"):
            log.append("%s.%s" % (type(self).__name__, name))
        object.__setattr__(self, name, value)


# ---------------------------------------------------------------- parameters and mixer

def volume_text(raw):
    """Live-like volume display: 0.85 is 0 dB, 1.0 is +6 dB, 0 is -inf."""
    if raw <= 0:
        return "-inf dB"
    db = (raw - 0.85) / 0.15 * 6.0 if raw >= 0.85 else 70.0 * (raw / 0.85 - 1.0)
    return "%.1f dB" % db


def pan_text(raw):
    if abs(raw) < 0.005:
        return "C"
    return "%d%s" % (round(abs(raw) * 50), "L" if raw < 0 else "R")


def plain_text(raw):
    return "%.2f" % raw


class FakeParameter(Logged):
    def __init__(self, name, value, minimum=0.0, maximum=1.0, text=plain_text, is_enabled=True,
                 items=None, default=None):
        self.name = name
        self._value = value
        self.min = minimum
        self.max = maximum
        self._text = text
        self.is_enabled = is_enabled
        self._items = tuple(items) if items is not None else None
        self.default_value = value if default is None else default
        self.automation_state = 0

    @property
    def is_quantized(self):
        return self._items is not None

    @property
    def value_items(self):
        if self._items is None:
            raise RuntimeError("not a quantized parameter")
        return self._items

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, new):
        if not self.min <= new <= self.max:
            raise ValueError("value out of range")
        self._value = new

    def str_for_value(self, raw):
        return self._text(raw)


class FakeMixer(Logged):
    def __init__(self, kind, send_count=0):
        self.volume = FakeParameter("Volume", 0.85, 0.0, 1.0, volume_text)
        self.panning = FakeParameter("Pan", 0.0, -1.0, 1.0, pan_text)
        self.track_activator = FakeParameter("Track Activator", 1.0, 0.0, 1.0)
        if kind != "master":
            self.sends = [FakeParameter("Send %s" % "ABCDEFGHIJKL"[i], 0.0, 0.0, 1.0, volume_text)
                          for i in range(send_count)]
            self.crossfade_assign = 1
        else:
            self.sends = []
            self.cue_volume = FakeParameter("Cue Volume", 0.85, 0.0, 1.0, volume_text)
            self.crossfader = FakeParameter("Crossfader", 0.0, -1.0, 1.0, plain_text)


# ---------------------------------------------------------------- routing

class FakeChannel:
    def __init__(self, display_name):
        self.display_name = display_name


class FakeDeviceStub:
    def __init__(self, name="Device", class_name="Generic", device_type=2, params=2):
        self.name = name
        self.class_name = class_name
        self.type = device_type
        self.is_active = True
        self.can_have_chains = False
        self.can_have_drum_pads = False
        self.parameters = [FakeParameter("p%d" % i, 0.0) for i in range(params)]


# ---------------------------------------------------------------- clips, notes, envelopes

NOTE_FIELDS = ("pitch", "start_time", "duration", "velocity", "mute", "probability",
               "velocity_deviation", "release_velocity")
GRID_STEPS = {1: 1.0, 2: 0.5, 5: 0.25, 8: 0.125}  # Clip.quantize grid enum -> beats


class NoteVector(list):
    """Marks the std::vector<TNoteInfo> Live returns; apply_note_modifications accepts only this type."""


class FakeNote:
    """An extended-API note: a snapshot; changes only reach the clip through apply_note_modifications."""

    def __init__(self, note_id, pitch, start_time, duration, velocity=100.0, mute=False,
                 probability=1.0, velocity_deviation=0.0, release_velocity=64.0):
        self.note_id = note_id
        self.pitch = pitch
        self.start_time = start_time
        self.duration = duration
        self.velocity = velocity
        self.mute = mute
        self.probability = probability
        self.velocity_deviation = velocity_deviation
        self.release_velocity = release_velocity

    def copy(self):
        return FakeNote(self.note_id, *[getattr(self, name) for name in NOTE_FIELDS])


def _note_value(spec, name, default=None):
    """Read one field from a dict or an object note specification."""
    if isinstance(spec, dict):
        return spec.get(name, default)
    return getattr(spec, name, default)


class FakeEnvelope:
    def __init__(self, clip, param):
        self._clip = clip
        self._param = param
        self.steps = []

    def insert_step(self, time, duration, value):
        self._clip._log_call("envelope.insert_step:%r:%r:%r" % (time, duration, value))
        if time < 0 or duration <= 0:
            raise ValueError("bad step")
        if not self._param.min <= value <= self._param.max:
            raise ValueError("value out of range")
        self.steps.append((time, duration, value))

    def value_at_time(self, time):
        if not self.steps:
            return 0.0
        prior = [step for step in self.steps if step[0] <= time]
        return (prior[-1] if prior else self.steps[0])[2]


class FakeClip(Logged):
    """Session or arrangement clip. MIDI clips own notes; audio clips own file_path and audio fields."""

    _hidden = frozenset()

    def __init__(self, name="Clip", is_midi=True, length=4.0, file_path=None):
        self.name = name
        self.color = 255
        self.is_midi_clip = is_midi
        self.is_audio_clip = not is_midi
        self.is_arrangement_clip = False
        self.muted = False
        self._looping = True
        self._loop_start = 0.0
        self._loop_end = float(length)
        self._start_marker = 0.0
        self._end_marker = float(length)
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.is_playing = False
        self.is_recording = False
        self._file_path = file_path if file_path is not None else (None if is_midi else "/Samples/x.wav")
        self._audio = {"gain": 0.4, "pitch_coarse": 0, "pitch_fine": 0.0, "warping": True,
                       "sample_rate": 44100}
        self._notes = []
        self._next_id = 1
        self._envelopes = []
        self._track = None
        self._arr_start = None
        self._arr_extent = None  # arrangement extent when stretched; None follows the loop length
        self._add_form = None

    # -- test helpers
    def hide(self, *names):
        """Make methods vanish like they do in an older Live (AttributeError on access)."""
        self.__dict__["_hidden"] = frozenset(names)

    def __getattribute__(self, name):
        if name in object.__getattribute__(self, "_hidden"):
            raise AttributeError(name)
        return object.__getattribute__(self, name)

    def _attach(self, track, log, arrangement_start=None):
        self._track = track
        self._log = log
        if arrangement_start is not None:
            self.is_arrangement_clip = True
            self._arr_start = float(arrangement_start)

    def _log_call(self, text):
        log = self.__dict__.get("_log")
        if log is not None:
            log.append("call:" + text)

    def clone(self):
        copy = FakeClip(self.name, self.is_midi_clip, self.length, self._file_path)
        copy.color, copy.muted = self.color, self.muted
        copy._looping, copy._loop_start, copy._loop_end = self._looping, self._loop_start, self._loop_end
        copy._start_marker, copy._end_marker = self._start_marker, self._end_marker
        copy._audio = dict(self._audio)
        copy._notes = [note.copy() for note in self._notes]
        copy._next_id = self._next_id
        return copy

    def seed_notes(self, *specs):
        """Add notes without logging: (pitch, start, duration[, velocity])."""
        for pitch, start, duration, *rest in specs:
            self._notes.append(FakeNote(self._next_id, pitch, start, duration, *rest))
            self._next_id += 1

    # -- loop and markers (Live refuses an empty or inverted range)
    @property
    def looping(self):
        return self._looping

    @looping.setter
    def looping(self, value):
        self._looping = bool(value)

    @property
    def loop_start(self):
        return self._loop_start

    @loop_start.setter
    def loop_start(self, value):
        if value >= self._loop_end:
            raise RuntimeError("loop_start must be smaller than loop_end")
        self._loop_start = float(value)

    @property
    def loop_end(self):
        return self._loop_end

    @loop_end.setter
    def loop_end(self, value):
        if value <= self._loop_start:
            raise RuntimeError("loop_end must be greater than loop_start")
        self._loop_end = float(value)

    @property
    def start_marker(self):
        return self._start_marker

    @start_marker.setter
    def start_marker(self, value):
        if value >= self._end_marker:
            raise RuntimeError("start_marker must be smaller than end_marker")
        self._start_marker = float(value)

    @property
    def end_marker(self):
        return self._end_marker

    @end_marker.setter
    def end_marker(self, value):
        if value <= self._start_marker:
            raise RuntimeError("end_marker must be greater than start_marker")
        self._end_marker = float(value)

    @property
    def length(self):
        return (self._loop_end - self._loop_start) if self._looping else (self._end_marker - self._start_marker)

    @property
    def start_time(self):
        if self._arr_start is not None:
            return self._arr_start
        return self._loop_start if self._looping else self._start_marker

    @property
    def end_time(self):
        if self._arr_start is not None:
            return self._arr_start + (self.length if self._arr_extent is None else self._arr_extent)
        return self._loop_end if self._looping else self._end_marker

    # -- audio-only properties (Live raises on MIDI clips; file_path is read-only)
    def _need_audio(self, what):
        if not self.is_audio_clip:
            raise RuntimeError("%s is only available on audio clips" % what)

    @property
    def file_path(self):
        self._need_audio("file_path")
        return self._file_path

    @property
    def sample_rate(self):
        self._need_audio("sample_rate")
        return self._audio["sample_rate"]

    @property
    def gain(self):
        self._need_audio("gain")
        return self._audio["gain"]

    @gain.setter
    def gain(self, value):
        self._need_audio("gain")
        self._audio["gain"] = value

    @property
    def pitch_coarse(self):
        self._need_audio("pitch_coarse")
        return self._audio["pitch_coarse"]

    @pitch_coarse.setter
    def pitch_coarse(self, value):
        self._need_audio("pitch_coarse")
        self._audio["pitch_coarse"] = value

    @property
    def pitch_fine(self):
        self._need_audio("pitch_fine")
        return self._audio["pitch_fine"]

    @pitch_fine.setter
    def pitch_fine(self, value):
        self._need_audio("pitch_fine")
        self._audio["pitch_fine"] = value

    @property
    def warping(self):
        self._need_audio("warping")
        return self._audio["warping"]

    @warping.setter
    def warping(self, value):
        self._need_audio("warping")
        self._audio["warping"] = bool(value)

    # -- notes (Live 11+ extended API)
    def _need_midi(self):
        if not self.is_midi_clip:
            raise RuntimeError("notes exist only on MIDI clips")

    def get_notes_extended(self, from_pitch, pitch_span, from_time, time_span):
        self._need_midi()
        return NoteVector(note.copy() for note in self._notes
                          if from_pitch <= note.pitch < from_pitch + pitch_span
                          and from_time <= note.start_time < from_time + time_span)

    def get_all_notes_extended(self):
        self._need_midi()
        return NoteVector(note.copy() for note in self._notes)

    def get_notes_by_id(self, ids):
        self._need_midi()
        self._log_call("clip.get_notes_by_id:%d" % len(ids))
        wanted = set(ids)
        return NoteVector(note.copy() for note in self._notes if note.note_id in wanted)

    def add_new_notes(self, specs):
        self._need_midi()
        self._add_form = "dict" if specs and isinstance(specs[0], dict) else "object"
        self._log_call("clip.add_new_notes:%d" % len(specs))
        fresh = []
        for spec in specs:
            values = [_note_value(spec, name, default) for name, default in
                      (("pitch", None), ("start_time", None), ("duration", None), ("velocity", 100.0),
                       ("mute", False), ("probability", 1.0), ("velocity_deviation", 0.0),
                       ("release_velocity", 64.0))]
            _check_note_values(*values)
            fresh.append(FakeNote(self._next_id, *values))
            self._next_id += 1
        self._notes.extend(fresh)
        return [note.note_id for note in fresh]

    def remove_notes_extended(self, from_pitch, pitch_span, from_time, time_span):
        self._need_midi()
        self._log_call("clip.remove_notes_extended:%r:%r:%r:%r" % (from_pitch, pitch_span, from_time, time_span))
        gone = {note.note_id for note in self.get_notes_extended(from_pitch, pitch_span, from_time, time_span)}
        self._notes = [note for note in self._notes if note.note_id not in gone]

    def remove_notes_by_id(self, ids):
        self._need_midi()
        self._log_call("clip.remove_notes_by_id:%d" % len(ids))
        self._notes = [note for note in self._notes if note.note_id not in set(ids)]

    def apply_note_modifications(self, notes):
        self._need_midi()
        if not isinstance(notes, NoteVector):  # Live's binding rejects a plain Python list
            raise RuntimeError("Clip.apply_note_modifications(Clip, list) did not match C++ signature: "
                               "apply_note_modifications(TPyHandle<AClip>, std::vector<NClipApi::TNoteInfo>)")
        self._log_call("clip.apply_note_modifications:%d" % len(notes))
        known = {note.note_id: note for note in self._notes}
        for changed in notes:
            if changed.note_id not in known:
                raise RuntimeError("unknown note id")
            _check_note_values(*[getattr(changed, name) for name in NOTE_FIELDS])
        for changed in notes:
            for name in NOTE_FIELDS:
                setattr(known[changed.note_id], name, getattr(changed, name))

    def _quantize_notes(self, grid, amount, pitch=None):
        step = GRID_STEPS.get(grid)  # an enum value the fake does not know quantizes nothing
        if step is None:
            return
        for note in self._notes:
            if pitch is None or note.pitch == pitch:
                snapped = round(note.start_time / step) * step
                note.start_time = note.start_time + (snapped - note.start_time) * amount

    def quantize(self, grid, amount):
        self._need_midi()
        self._log_call("clip.quantize:%r:%r" % (grid, amount))
        self._quantize_notes(grid, amount)

    def quantize_pitch(self, pitch, grid, amount):
        self._need_midi()
        self._log_call("clip.quantize_pitch:%r:%r:%r" % (pitch, grid, amount))
        self._quantize_notes(grid, amount, pitch)

    def crop(self):
        self._log_call("clip.crop")
        if self.is_midi_clip:
            self._notes = [n for n in self._notes if self._loop_start <= n.start_time < self._loop_end]

    def duplicate_loop(self):
        self._log_call("clip.duplicate_loop")
        if not self.is_midi_clip:
            raise RuntimeError("duplicate_loop needs a MIDI clip")
        span = self._loop_end - self._loop_start
        for note in list(self._notes):
            self._notes.append(FakeNote(self._next_id, note.pitch, note.start_time + span, note.duration,
                                        note.velocity, note.mute, note.probability,
                                        note.velocity_deviation, note.release_velocity))
            self._next_id += 1
        self._loop_end += span
        self._end_marker = max(self._end_marker, self._loop_end)

    # -- session clip envelopes (arrangement clips have none)
    def _param_belongs(self, param):
        track = self._track
        if track is None:
            return False
        mixer = track.mixer_device
        owned = [mixer.volume, mixer.panning] + list(mixer.sends)
        return any(param is item for item in owned) or _device_owns(track.devices, param)

    def _need_session(self):
        if self.is_arrangement_clip:
            raise RuntimeError("arrangement clips have no clip envelopes")

    def _envelope_for(self, param):
        for known, envelope in self._envelopes:
            if known is param:
                return envelope
        return None

    def automation_envelope(self, param):
        self._need_session()
        return self._envelope_for(param)

    def create_automation_envelope(self, param):
        self._need_session()
        self._log_call("clip.create_automation_envelope")
        if not self._param_belongs(param):
            raise RuntimeError("parameter does not belong to this clip's track")
        if self._envelope_for(param) is not None:
            raise RuntimeError("envelope already exists")
        envelope = FakeEnvelope(self, param)
        envelope._log = self.__dict__.get("_log")
        self._envelopes.append((param, envelope))
        return envelope

    def clear_envelope(self, param):
        self._need_session()
        self._log_call("clip.clear_envelope")
        self._envelopes = [(p, e) for p, e in self._envelopes if p is not param]

    def clear_all_envelopes(self):
        self._need_session()
        self._log_call("clip.clear_all_envelopes")
        self._envelopes = []


def _check_note_values(pitch, start_time, duration, velocity, mute, probability, velocity_deviation,
                       release_velocity):
    if not (isinstance(pitch, int) and 0 <= pitch <= 127):
        raise ValueError("pitch")
    if start_time is None or duration is None or duration <= 0:
        raise ValueError("time")
    if not 0 <= velocity <= 127 or not 0 <= probability <= 1:
        raise ValueError("velocity or probability")


def _device_owns(devices, param):
    for device in devices:
        if any(param is p for p in device.parameters):
            return True
        for chain in list(getattr(device, "chains", [])) + list(getattr(device, "return_chains", [])):
            if _device_owns(chain.devices, param):
                return True
        for pad in getattr(device, "drum_pads", []):
            for chain in pad.chains:
                if _device_owns(chain.devices, param):
                    return True
    return False


class FakeChainStub:
    def __init__(self, name="Chain", devices=None):
        self.name = name
        self.devices = devices or []


class FakeDrumPadStub:
    def __init__(self, note, chains=None):
        self.note = note
        self.chains = chains or []


class FakeRackStub(FakeDeviceStub):
    def __init__(self, name="Rack", chains=None, return_chains=None, drum_pads=None):
        super().__init__(name, "AudioEffectGroupDevice")
        self.can_have_chains = True
        self.chains = chains or []
        self.return_chains = return_chains or []
        if drum_pads is not None:
            self.drum_pads = drum_pads
            self.can_have_drum_pads = True


class FakeSlot:
    """A session slot. Writes by the script are method calls (logged); `clip` is plain test setup."""

    def __init__(self, clip=None, track=None, log=None):
        self._track = track
        self._log = log
        self._clip = None
        self.is_playing = False
        self.is_recording = False
        self.is_triggered = False
        self.clip = clip

    @property
    def clip(self):
        return self._clip

    @clip.setter
    def clip(self, value):
        self._clip = value
        if value is not None:
            value._attach(self._track, self._log)

    @property
    def has_clip(self):
        return self._clip is not None

    def _note(self, text):
        if self._log is not None:
            self._log.append("call:slot." + text)

    def _position(self):
        return self._track.clip_slots.index(self)

    def create_clip(self, length):
        self._note("create_clip:%r" % (length,))
        if self.has_clip:
            raise RuntimeError("slot already has a clip")
        if not self._track.has_midi_input:
            raise RuntimeError("create_clip needs a MIDI track")
        self.clip = FakeClip("", True, length)

    def create_audio_clip(self, path):
        self._note("create_audio_clip:%s" % (path,))
        if self.has_clip:
            raise RuntimeError("slot already has a clip")
        if not self._track.has_audio_input:
            raise RuntimeError("create_audio_clip needs an audio track")
        self.clip = FakeClip("", False, self._track._song.sample_beats.get(path, 4.0), path)

    def delete_clip(self):
        self._note("delete_clip")
        if not self.has_clip:
            raise RuntimeError("slot has no clip")
        self._clip = None

    def duplicate_clip_to(self, target):
        self._note("duplicate_clip_to:%d" % target._position())
        if not self.has_clip:
            raise RuntimeError("slot has no clip")
        if target is self or target._track.has_midi_input != self._track.has_midi_input:
            raise RuntimeError("cannot duplicate to this slot")
        target.clip = self._clip.clone()

    def _group_children(self):
        song = self._track._song
        members, found = [self._track], []
        for other in song.tracks:
            if other.group_track is not None and any(other.group_track is m for m in members):
                members.append(other)
                found.append(other)
        return found

    def fire(self, record_length=None, launch_quantization=None):
        self._note("fire:%r:%r" % (record_length, launch_quantization))
        if self._track.is_foldable:  # a group slot launches its children's slots at the same row
            index = self._position()
            for child in self._group_children():
                slot = child.clip_slots[index]
                if slot.has_clip:
                    slot.is_playing = True
                    slot._clip.is_playing = True
                elif child.__dict__.get("_arm"):  # "Start Recording on Scene Launch"
                    slot.is_recording = True
            return
        if self.has_clip:
            self.is_playing = True
            self._clip.is_playing = True
        elif self._track.__dict__.get("_arm"):
            self.is_recording = True

    def stop(self):
        self._note("stop")
        self.is_playing = False
        self.is_recording = False
        self.is_triggered = False
        if self.has_clip:
            self._clip.is_playing = False


class FakeTrackBase(Logged):
    kind = "track"

    def __init__(self, song, name, send_count):
        self._song = song
        self.name = name
        self._color = 0x336699
        self._mute = False
        self._solo = False
        self._arm = False
        self._monitoring = 1
        self.devices = []
        self.mixer_device = FakeMixer(self.kind, send_count)
        self.group_track = None
        self.is_foldable = False
        self.fold_state = 0
        self.output_meter_left = 0.25
        self.output_meter_right = 0.5
        self.output_meter_level = 0.75
        self._out_types = [FakeRoutingType("Master"), FakeRoutingType("Ext. Out")]
        self._out_type = self._out_types[0]
        self._out_channels = {"Master": [FakeChannel("Track In")],
                              "Ext. Out": [FakeChannel("1/2"), FakeChannel("3/4")]}
        self._out_channel = self._out_channels["Master"][0]
        self.clip_slots = []

    # -- devices (T4b): a track owns its device list; factories come from the song
    def insert_device(self, name, index):
        from .fake_devices import insert_into
        insert_into(self.devices, self._song, name, index, "Track")

    def delete_device(self, index):
        from .fake_devices import delete_from
        delete_from(self.devices, self._song, index, "Track")

    # -- properties that Live refuses on some track kinds
    def _need(self, allowed, what):
        if self.kind not in allowed:
            raise RuntimeError("%s tracks have no %s" % (self.kind, what))

    @property
    def color(self):
        self._need(("track", "return"), "color")
        return self._color

    @color.setter
    def color(self, value):
        self._need(("track", "return"), "color")
        self._color = value

    @property
    def mute(self):
        self._need(("track", "return"), "mute")
        return self._mute

    @mute.setter
    def mute(self, value):
        self._need(("track", "return"), "mute")
        self._mute = value

    @property
    def solo(self):
        self._need(("track", "return"), "solo")
        return self._solo

    @solo.setter
    def solo(self, value):
        self._need(("track", "return"), "solo")
        self._solo = value

    @property
    def arm(self):
        self._need(("track",), "'Arm' state")
        if self.__dict__.get("_arm_raises"):
            raise RuntimeError("arm state unreadable")
        return self._arm

    @arm.setter
    def arm(self, value):
        self._need(("track",), "'Arm' state")
        self._arm = value

    @property
    def current_monitoring_state(self):
        self._need(("track",), "monitoring state")
        return self._monitoring

    @current_monitoring_state.setter
    def current_monitoring_state(self, value):
        self._need(("track",), "monitoring state")
        self._monitoring = value

    # -- output routing (all track kinds)
    @property
    def available_output_routing_types(self):
        return list(self._out_types)

    @property
    def output_routing_type(self):
        return self._out_type

    @output_routing_type.setter
    def output_routing_type(self, new):
        if not any(new is t for t in self._out_types):
            raise ValueError("routing type not available")
        self._out_type = new
        self._out_channel = self._out_channels[new.display_name][0]

    @property
    def available_output_routing_channels(self):
        return list(self._out_channels[self._out_type.display_name])

    @property
    def output_routing_channel(self):
        return self._out_channel

    @output_routing_channel.setter
    def output_routing_channel(self, new):
        if not any(new is c for c in self.available_output_routing_channels):
            raise ValueError("routing channel not available")
        self._out_channel = new


class FakeLomTrack(FakeTrackBase):
    kind = "track"

    def __init__(self, song, name, audio, send_count):
        super().__init__(song, name, send_count)
        self.can_be_armed = True
        self.has_audio_input = audio
        self.has_midi_input = not audio
        self._type_cache = {}
        self._ext = FakeRoutingType("Ext. In") if audio else FakeRoutingType("All Ins")
        self._resampling = FakeRoutingType("Resampling")
        self._no_input = FakeRoutingType("No Input")
        self._input_type = self._ext
        self._in_channels = {}
        self._input_channel = self.available_input_routing_channels[0]
        self._arrangement = []

    @property
    def available_input_routing_types(self):
        types = [self._ext]
        if self.has_audio_input:
            types.append(self._resampling)
        for other in self._song.tracks:
            if other is not self:
                cached = self._type_cache.get(id(other))
                if cached is None or cached.attached_object is not other:
                    cached = FakeRoutingType(other.name, attached_object=other)
                    self._type_cache[id(other)] = cached
                cached.display_name = other.name
                types.append(cached)
        types.append(self._no_input)
        return types

    @property
    def input_routing_type(self):
        return self._input_type

    @input_routing_type.setter
    def input_routing_type(self, new):
        if not any(new is t for t in self.available_input_routing_types):
            raise ValueError("routing type not available")
        self._input_type = new
        self._input_channel = self.available_input_routing_channels[0]

    @property
    def available_input_routing_channels(self):
        current = self._input_type
        if current.attached_object is not None:
            names = ["Post FX", "Post Mixer", "Pre FX"]
        elif current.display_name == "Ext. In":
            names = ["1/2", "3/4"]
        else:
            names = ["-"]
        key = (id(current), tuple(names))
        if key not in self._in_channels:
            self._in_channels[key] = [FakeChannel(n) for n in names]
        return list(self._in_channels[key])

    @property
    def input_routing_channel(self):
        return self._input_channel

    @input_routing_channel.setter
    def input_routing_channel(self, new):
        if not any(new is c for c in self.available_input_routing_channels):
            raise ValueError("routing channel not available")
        self._input_channel = new

    def stop_all_clips(self):
        self._song.log.append("call:track.stop_all_clips")

    # -- arrangement clips and slot duplication
    @property
    def arrangement_clips(self):
        return sorted(self._arrangement, key=lambda clip: clip.start_time)

    def _place(self, clip, position, extent=None):
        """Put `clip` on the arrangement at `position`, replacing whatever it overlaps (Live overwrites).

        `extent` is the timeline length of a stretched clip; None means it follows the clip length."""
        clip._arr_extent = extent
        end = position + (clip.length if extent is None else extent)
        self._arrangement = [other for other in self._arrangement
                             if not (other.start_time < end and other.end_time > position)]
        clip._attach(self, self._song.log, position)
        self._arrangement.append(clip)
        return clip

    def create_midi_clip(self, start, length):
        self._song.log.append("call:track.create_midi_clip:%r:%r" % (start, length))
        if not self.has_midi_input:
            raise RuntimeError("create_midi_clip needs a MIDI track")
        if any(c.start_time < start + length and c.end_time > start for c in self._arrangement):
            raise RuntimeError("the new clip would overlap an existing clip")
        return self._place(FakeClip("", True, length), start)

    def create_audio_clip(self, file_path, position):
        self._song.log.append("call:track.create_audio_clip:%s:%r" % (file_path, position))
        if not self.has_audio_input:
            raise RuntimeError("create_audio_clip needs an audio track")
        beats = self._song.sample_beats.get(file_path, 4.0)
        return self._place(FakeClip("", False, beats, file_path), position)

    def delete_clip(self, clip):
        self._song.log.append("call:track.delete_clip")
        if not any(clip is other or clip == other for other in self._arrangement):
            raise RuntimeError("clip is not on this track")
        self._arrangement = [other for other in self._arrangement if other is not clip]

    def duplicate_clip_to_arrangement(self, clip, time):
        self._song.log.append("call:track.duplicate_clip_to_arrangement:%r" % (time,))
        if clip.is_midi_clip != bool(self.has_midi_input):
            raise RuntimeError("clip type does not match the track type")
        extent = (clip.end_time - clip.start_time) if clip.is_arrangement_clip else None
        placed = self._place(clip.clone(), time, extent)
        self._song.current_song_time = time  # Live leaves the playhead at the destination
        return placed

    def duplicate_clip_slot(self, index):
        self._song.log.append("call:track.duplicate_clip_slot:%d" % index)
        source = self.clip_slots[index]
        if not source.has_clip:
            raise RuntimeError("slot has no clip")
        target = next((i for i in range(index + 1, len(self.clip_slots)) if not self.clip_slots[i].has_clip), None)
        if target is None:  # no free slot below: Live inserts a new scene right after the source
            self._song.create_scene(index + 1)
            target = index + 1
        self.clip_slots[target].clip = source.clip.clone()
        return None if self.__dict__.get('_dup_returns_none') else target


class FakeLomReturn(FakeTrackBase):
    kind = "return"

    def __init__(self, song, name, send_count):
        super().__init__(song, name, send_count)
        self.can_be_armed = False
        self.has_audio_input = False
        self.has_midi_input = False

    @property
    def input_routing_type(self):
        raise RuntimeError("Main and Return Tracks have no input")


class FakeLomMaster(FakeTrackBase):
    kind = "master"

    def __init__(self, song):
        super().__init__(song, "Master", 0)
        self.can_be_armed = False
        self.has_audio_input = False
        self.has_midi_input = False
        del self._out_types[1:]

    @property
    def input_routing_type(self):
        raise RuntimeError("Main track has no input")


# ---------------------------------------------------------------- scenes, cues, song

class FakeScene(Logged):
    def __init__(self, song, name="", color=0x222222):
        self._song = song
        self.name = name
        self.color = color
        self.tempo = -1.0
        self.tempo_enabled = False
        self.time_signature_numerator = -1
        self.time_signature_denominator = -1
        self.time_signature_enabled = False
        self.is_triggered = False

    def fire(self, force_legato=False, can_select_scene_on_launch=True):
        self._song.log.append("call:scene.fire:%r:%r" % (force_legato, can_select_scene_on_launch))

    def fire_as_selected(self, force_legato=False):
        self._song.log.append("call:scene.fire_as_selected:%r" % (force_legato,))


class FakeCue(Logged):
    def __init__(self, song, time, name=""):
        self._song = song
        self._time = time
        self._dead = False
        self.name = name

    @property
    def time(self):
        if self._dead:  # Live's wrapper of a deleted cue point is invalid
            raise RuntimeError("None.None(CuePoint) did not match C++ signature")
        return self._time

    def jump(self):
        self._song.log.append("call:cue.jump")
        self._song.current_song_time = self._time


class FakeView(Logged):
    def __init__(self, song):
        self.selected_track = None
        self.selected_scene = None


class FakeLomSong(Logged):
    def __init__(self):
        self.log = []
        self.events = []  # "begin" / "end" undo markers only
        self.tracks = []
        self.return_tracks = []
        self.scenes = []
        self.master_track = None
        self._cues = []
        self.view = FakeView(self)
        self.tempo = 120.0
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.is_playing = False
        self._time = 0.0
        # Live applies playhead and play-state writes on its next tick. With `lag` on, those writes wait
        # in `_pending` until `tick()`, and `set_or_delete_cue` acts at the position in force right now.
        self.lag = False
        self.seek_blocked = False  # with lag on: playhead writes never land
        self._pending = []
        self.loop = False
        self.loop_start = 0.0
        self.loop_length = 4.0
        self.metronome = False
        self.record_mode = False
        self.arrangement_overdub = False
        self.session_record = False
        self.root_note = 0
        self.scale_name = "Major"
        self.clip_trigger_quantization = 4  # Live.Song.Quantization.q_bar
        self.back_to_arranger = 0
        self.undo_stack = []
        self.redo_stack = []
        self.valid_scales = ["Major", "Minor", "Dorian"]
        self.sample_beats = {}  # audio file path -> length in beats of the clip Live would create
        self.limits = None  # e.g. {"tracks": 8, "scenes": 16, "returns": 2}: Live Lite refuses beyond
        self.device_factories = {}  # device name -> callable returning a fresh device (T4b)
        self._log = self.log
        self.view._log = self.log

    # -- undo
    def begin_undo_step(self):
        self.events.append("begin")

    def end_undo_step(self):
        self.events.append("end")
        self.undo_stack.append("step")

    @property
    def can_undo(self):
        return bool(self.undo_stack)

    @property
    def can_redo(self):
        return bool(self.redo_stack)

    def undo(self):
        self.log.append("call:undo")
        if self.undo_stack:
            self.redo_stack.append(self.undo_stack.pop())

    def redo(self):
        self.log.append("call:redo")
        if self.redo_stack:
            self.undo_stack.append(self.redo_stack.pop())

    # -- transport
    @property
    def current_song_time(self):
        return self._time

    @current_song_time.setter
    def current_song_time(self, value):
        if not self.lag:
            self._time = value
        elif not self.seek_blocked:
            self._pending.append(("_time", value))

    def _set_playing(self, value):
        if self.lag:
            self._pending.append(("is_playing", value))
        else:
            self.is_playing = value

    def tick(self):
        """One Live tick: pending writes take effect."""
        pending, self._pending = self._pending, []
        for name, value in pending:
            setattr(self, name, value)

    def start_playing(self):
        self.log.append("call:start_playing")
        self._set_playing(True)

    def continue_playing(self):
        self.log.append("call:continue_playing")
        self._set_playing(True)

    def stop_playing(self):
        self.log.append("call:stop_playing")
        self._set_playing(False)

    def stop_all_clips(self, quantized=True):
        self.log.append("call:stop_all_clips:%r" % (quantized,))

    def capture_midi(self):
        self.log.append("call:capture_midi")

    def trigger_session_record(self, record_length=None):
        self.log.append("call:trigger_session_record:%r" % (record_length,))

    def re_enable_automation(self):
        self.log.append("call:re_enable_automation")

    # -- scale validation like Live (unknown scale raises)
    def __setattr__(self, name, value):
        if name == "scale_name" and "valid_scales" in self.__dict__ and value not in self.valid_scales:
            raise RuntimeError("Unknown scale name")
        super().__setattr__(name, value)

    # -- tracks
    def _make_slot(self, track):
        return FakeSlot(track=track, log=self.log)

    def _new_slots(self, track):
        track.clip_slots = [self._make_slot(track) for _ in self.scenes]

    def _insert_track(self, track, index):
        track._log = self.log
        track.mixer_device._log = self.log
        self._new_slots(track)
        if index == -1:
            self.tracks.append(track)
        else:
            self.tracks.insert(index, track)
        return track

    def _check_limit(self, resource, count):
        if self.limits is not None and count >= self.limits[resource]:
            raise RuntimeError("Maximum number of %s reached (Live Lite limit)" % resource)

    def make_group(self, group_index, child_indexes):
        """Turn tracks[group_index] into a group track holding the given child tracks."""
        group = self.tracks[group_index]
        group.is_foldable = True
        for child in child_indexes:
            self.tracks[child].group_track = group
        return group

    def _check_index(self, index, count):
        if index < -1 or index > count:
            raise IndexError("index out of range")

    def create_midi_track(self, index=-1):
        self.log.append("call:create_midi_track:%d" % index)
        self._check_limit("tracks", len(self.tracks))
        self._check_index(index, len(self.tracks))
        self._insert_track(FakeLomTrack(self, "%d-MIDI" % (len(self.tracks) + 1), False,
                                        len(self.return_tracks)), index)

    def create_audio_track(self, index=-1):
        self.log.append("call:create_audio_track:%d" % index)
        self._check_limit("tracks", len(self.tracks))
        self._check_index(index, len(self.tracks))
        self._insert_track(FakeLomTrack(self, "%d-Audio" % (len(self.tracks) + 1), True,
                                        len(self.return_tracks)), index)

    def create_return_track(self):
        self.log.append("call:create_return_track")
        self._check_limit("returns", len(self.return_tracks))
        ret = FakeLomReturn(self, "%s-Return" % "ABCDEFGHIJKL"[len(self.return_tracks)], 0)
        ret._log = self.log
        ret.mixer_device._log = self.log
        self.return_tracks.append(ret)
        for track in self.tracks:
            track.mixer_device.sends.append(FakeParameter("Send", 0.0, 0.0, 1.0, volume_text))
        return ret

    def delete_track(self, index):
        self.log.append("call:delete_track:%d" % index)
        del self.tracks[index]

    def delete_return_track(self, index):
        self.log.append("call:delete_return_track:%d" % index)
        del self.return_tracks[index]

    def duplicate_track(self, index):
        self.log.append("call:duplicate_track:%d" % index)
        source = self.tracks[index]
        self._check_limit("tracks", len(self.tracks))
        copy = FakeLomTrack(self, source.name + " Copy", source.has_audio_input, len(self.return_tracks))
        copy.devices = list(source.devices)
        copy.arm = source.arm
        copy.current_monitoring_state = source.current_monitoring_state
        self._insert_track(copy, index + 1)
        # A group track copies its children too.
        children = [t for t in self.tracks if t.group_track is source]
        for offset, child in enumerate(children):
            child_copy = FakeLomTrack(self, child.name + " Copy", child.has_audio_input, 0)
            child_copy.group_track = copy
            self._insert_track(child_copy, index + 2 + offset)

    # -- scenes
    def create_scene(self, index=-1):
        self.log.append("call:create_scene:%d" % index)
        self._check_limit("scenes", len(self.scenes))
        self._check_index(index, len(self.scenes))
        scene = FakeScene(self)
        scene._log = self.log
        position = len(self.scenes) if index == -1 else index
        self.scenes.insert(position, scene)
        for track in self.tracks:
            track.clip_slots.insert(position, self._make_slot(track))
        return scene

    def delete_scene(self, index):
        self.log.append("call:delete_scene:%d" % index)
        del self.scenes[index]
        for track in self.tracks:
            del track.clip_slots[index]

    def duplicate_scene(self, index):
        self.log.append("call:duplicate_scene:%d" % index)
        self._check_limit("scenes", len(self.scenes))
        source = self.scenes[index]
        scene = FakeScene(self, source.name, source.color)
        scene._log = self.log
        self.scenes.insert(index + 1, scene)
        for track in self.tracks:
            track.clip_slots.insert(index + 1, self._make_slot(track))

    def capture_and_insert_scene(self):
        self.log.append("call:capture_and_insert_scene")
        self.create_scene(len(self.scenes))

    # -- cue points
    @property
    def cue_points(self):
        return sorted(self._cues, key=lambda cue: cue.time)

    def set_or_delete_cue(self):
        self.log.append("call:set_or_delete_cue")
        for cue in self._cues:
            if abs(cue.time - self._time) < CUE_TOGGLE_TOLERANCE:
                self._cues.remove(cue)
                cue._dead = True
                return
        cue = FakeCue(self, self._time)
        cue._log = self.log
        self._cues.append(cue)

    def add_cue(self, time, name=""):
        cue = FakeCue(self, time, name)
        cue._log = self.log
        self._cues.append(cue)
        return cue

    def jump_to_next_cue(self):
        self.log.append("call:jump_to_next_cue")
        later = [c for c in self.cue_points if c.time > self._time]
        if later:
            self.current_song_time = later[0].time

    def jump_to_prev_cue(self):
        self.log.append("call:jump_to_prev_cue")
        earlier = [c for c in self.cue_points if c.time < self._time]
        if earlier:
            self.current_song_time = earlier[-1].time


# ---------------------------------------------------------------- world builder and harness

def build_song(kinds=("midi", "audio"), returns=1, scenes=2):
    """kinds: sequence of "midi"/"audio"/(name, kind). Returns a ready FakeLomSong."""
    song = FakeLomSong()
    song.master_track = FakeLomMaster(song)
    song.master_track._log = song.log
    song.master_track.mixer_device._log = song.log
    for i in range(returns):
        ret = FakeLomReturn(song, "%s-Return" % "ABCDEFGHIJKL"[i], 0)
        ret._log = song.log
        ret.mixer_device._log = song.log
        song.return_tracks.append(ret)
    for i in range(scenes):
        scene = FakeScene(song, "Scene %d" % (i + 1))
        scene._log = song.log
        song.scenes.append(scene)
    for index, entry in enumerate(kinds):
        name, kind = entry if isinstance(entry, tuple) else (None, entry)
        track = FakeLomTrack(song, name or ("%d-%s" % (index + 1, kind.upper())),
                             kind == "audio", returns)
        song._insert_track(track, -1)
    song.view.selected_track = song.tracks[0] if song.tracks else None
    for track in song.tracks:
        track.mixer_device.sends = [FakeParameter("Send %s" % "ABCDEFGHIJKL"[i], 0.0, 0.0, 1.0, volume_text)
                                    for i in range(returns)]
        for param in track.mixer_device.sends:
            param._log = song.log
    del song.log[:]
    return song


class LomHarness:
    """Real registry + dispatcher over the fake LOM; `run` mimics socket thread + main thread."""

    def __init__(self, edition=None, kinds=("midi", "audio"), returns=1, scenes=2,
                 flags=None, song=None):
        self.clock = FakeClock()
        self.song = song or build_song(kinds, returns, scenes)
        self.cinstance = FakeCInstance(self.song)
        self.state = ScriptState()
        if edition:
            self.state.set_edition(edition, "detected")
        self.registry = build_registry()
        self.dispatcher = Dispatcher(self.registry, self.cinstance, self.state,
                                     clock=self.clock, log=self.cinstance.log_message,
                                     between_ticks=self.song.tick)
        self.flags = flags or {}
        self._request_id = 0

    def run(self, name, args=None):
        self._request_id += 1
        try:
            command, normalized = self.registry.prepare_call(name, args if args is not None else {})
        except BatutaError as exc:
            return {"id": self._request_id, "ok": False, "error": exc.to_wire()}
        job = Job(conn_id=1, request_id=self._request_id, command=command, args=normalized,
                  deadline=self.clock() + 5, flags=dict(self.flags))
        response = self.dispatcher.execute(job)
        self.song.tick()  # time passes between two commands
        return response

    def ok(self, name, args=None):
        response = self.run(name, args)
        assert response["ok"], "expected success for %s %r, got %r" % (name, args, response)
        return response["result"]

    def error(self, name, args=None):
        response = self.run(name, args)
        assert not response["ok"], "expected an error for %s %r, got %r" % (name, args, response)
        return response["error"]

    # -- bookkeeping helpers
    def undo_steps(self):
        return self.song.events.count("begin")

    def writes(self):
        return list(self.song.log)

    def reset_log(self):
        del self.song.log[:]
        del self.song.events[:]

    def arm_ears(self):
        """Create the ears track through the script, as the server would."""
        return self.ok("track_create", {"type": "audio", "name": "batuta-ears", "ears_internal": True})


def finite(value):
    return isinstance(value, float) and math.isfinite(value)
