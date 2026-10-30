"""Token bucket, auth lockout and rejection-window helpers (spec sections 3.4 and 3.5)."""

import collections


class TokenBucket:
    """Refills `rate` tokens per second up to `capacity`; time comes from an injected clock."""

    def __init__(self, rate, capacity, clock):
        self._rate = float(rate)
        self._capacity = float(capacity)
        self._clock = clock
        self._tokens = float(capacity)
        self._stamp = clock()

    def try_take(self):
        """Return (True, 0) when a token was taken, else (False, retry_after_ms)."""
        now = self._clock()
        self._tokens = min(self._capacity, self._tokens + (now - self._stamp) * self._rate)
        self._stamp = now
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True, 0
        wait_s = (1.0 - self._tokens) / self._rate if self._rate > 0 else 60.0
        return False, max(1, int(wait_s * 1000) + 1)


class EventWindow:
    """Counts events inside a sliding window of `window_s` seconds."""

    def __init__(self, window_s, clock):
        self._window = window_s
        self._clock = clock
        self._events = collections.deque()

    def add(self):
        now = self._clock()
        self._events.append(now)
        self._trim(now)
        return len(self._events)

    def count(self):
        self._trim(self._clock())
        return len(self._events)

    def clear(self):
        self._events.clear()

    def _trim(self, now):
        while self._events and now - self._events[0] > self._window:
            self._events.popleft()


class AuthLockout:
    """After `limit` failures inside `window_s`, new connections are refused for `lockout_s`."""

    def __init__(self, limit, window_s, lockout_s, clock):
        self._limit = limit
        self._lockout_s = lockout_s
        self._clock = clock
        self._failures = EventWindow(window_s, clock)
        self._locked_until = 0.0

    def record_failure(self):
        if self._failures.add() >= self._limit:
            self._locked_until = self._clock() + self._lockout_s
            self._failures.clear()

    def is_locked(self):
        return self._clock() < self._locked_until
