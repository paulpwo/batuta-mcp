"""Mutable script state shared by the main thread and (read-only flags) the socket thread."""

import collections

from . import limits


class ScriptState:
    def __init__(self):
        self.edition = "unknown"
        self.edition_source = "none"
        self.ears_track = None  # the track OBJECT created for ears, never a name (spec 5.6)
        self._uri_map = collections.OrderedDict()
        self._conn_id = None
        self.sweeps = []      # pending post-load sweeps (survive a client disconnect, see sweep.py)
        self._recent = []     # last finished sweeps: {outcome, delivered}; survives reconnects
        self._sweep_seq = 0

    def set_edition(self, edition, source):
        self.edition = edition
        self.edition_source = source

    # -- browser URI map (LRU, per connection)

    def remember_uri(self, uri, entry):
        self._uri_map[uri] = entry
        self._uri_map.move_to_end(uri)
        while len(self._uri_map) > limits.URI_MAP_ENTRIES:
            self._uri_map.popitem(last=False)

    def lookup_uri(self, uri):
        entry = self._uri_map.get(uri)
        if entry is not None:
            self._uri_map.move_to_end(uri)
        return entry

    # -- connection scope

    def bind_connection(self, conn_id):
        """Called on the main thread before each job: new connection means a clean slate."""
        if conn_id != self._conn_id:
            self.reset_connection_state()
            self._conn_id = conn_id

    def add_sweep(self, sweep):
        self.sweeps.append(sweep)

    def record_sweep(self, outcome):
        """Keep the last 8 outcomes; when full, the oldest clean one goes first (worst are kept)."""
        self._sweep_seq += 1
        self._recent.append({"outcome": dict(outcome, seq=self._sweep_seq), "delivered": False})
        while len(self._recent) > limits.MAX_RECENT_SWEEPS:
            clean = [e for e in self._recent if e["outcome"]["state"] == "clean"]
            self._recent.remove(clean[0] if clean else self._recent[0])

    def _ranked(self, entries):
        """Worst first (anything but clean), newest first within a rank."""
        return sorted(entries, key=lambda e: (e["outcome"]["state"] == "clean", -e["outcome"]["seq"]))

    @staticmethod
    def _copy(entry):
        outcome = dict(entry["outcome"])
        outcome["removed"] = list(outcome["removed"])
        if "new_tracks" in outcome:
            outcome["new_tracks"] = [dict(t) for t in outcome["new_tracks"]]
            outcome["landed_on"] = dict(outcome["landed_on"])
        return outcome

    def recent_sweeps(self):
        return [self._copy(entry) for entry in self._ranked(self._recent)]

    def take_sweep(self):
        """The worst finished sweep not yet reported to a client, once; history is kept."""
        for entry in self._ranked([e for e in self._recent if not e["delivered"]]):
            entry["delivered"] = True
            return self._copy(entry)
        return None

    def reset_connection_state(self):
        self._uri_map.clear()
        self.ears_track = None
