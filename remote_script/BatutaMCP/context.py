"""Per-execution context handed to every command handler."""

from .edition import EditionPolicy
from .recording_safety import RecordingSafety


class HandlerContext:
    """What a handler may use: the song, policy layers and a mutation marker.

    `note_mutation()` must be called by a handler right before its first LOM write so that a later
    exception is reported with details.partial = true.
    """

    def __init__(self, c_instance, state, registry, flags, log):
        self.c_instance = c_instance
        self.song = c_instance.song()
        self.state = state
        self.registry = registry
        self.flags = dict(flags)
        self.log = log
        self.edition = EditionPolicy(state.edition)
        self.recording = RecordingSafety(state, lambda: self.song,
                                         self.flags.get("external_input_ack"))
        self.mutations = 0

    @property
    def mutated(self):
        return self.mutations > 0

    def note_mutation(self):
        self.mutations += 1

    def edition_counts(self):
        song = self.song
        return {"tracks": len(song.tracks), "scenes": len(song.scenes),
                "returns": len(song.return_tracks)}

    def run_op(self, command, args):
        """Run a handler inside the caller's undo step (used by batch); no wrapper, no nesting."""
        return command.handler(self, args)
