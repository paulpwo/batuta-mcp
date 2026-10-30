"""Runtime directory, token file and listener socket (docs/01-protocol.md section 2).

This is the ONLY module that touches the filesystem. The exhaustive list of operations is in
spec section 2.4: mkdir/chmod/lstat on the runtime dir; create-exclusive, link, unlink and read of
the token; connect/bind/chmod/unlink on the socket path. Nothing here ever logs or returns the
token inside an error message.
"""

import errno
import os
import re
import secrets
import socket
import stat

from . import limits

SOCKET_NAME = "live.sock"
TOKEN_NAME = "token"
TOKEN_LENGTH = 64
_TOKEN_PATTERN = re.compile(rb"^[0-9a-f]{64}$")
_STALE_PROBE_TIMEOUT_S = 0.2


class RuntimeFileError(Exception):
    """A startup check failed; the message names the path and the violated rule, never the token."""


def _current_uid():
    return os.getuid()


def default_runtime_dir():
    return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "BatutaMCP")


# ----------------------------------------------------------------- runtime dir

def ensure_runtime_dir(path):
    """Create the dir (0700) when missing, then require it to be a private, owned directory."""
    try:
        os.lstat(path)
    except FileNotFoundError:
        try:
            os.mkdir(path, 0o700)
            os.chmod(path, 0o700)  # defeat a permissive umask
        except OSError as exc:
            raise RuntimeFileError("cannot create runtime dir %s: %s" % (path, exc.strerror)) from None
    except OSError as exc:
        raise RuntimeFileError("cannot stat runtime dir %s: %s" % (path, exc.strerror)) from None
    check_runtime_dir(path)


def check_runtime_dir(path):
    """Refuse (never repair) a dir that is a symlink, foreign-owned or reachable by others."""
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise RuntimeFileError("cannot stat runtime dir %s: %s" % (path, exc.strerror)) from None
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeFileError("runtime path %s is not a real directory" % path)
    if info.st_uid != _current_uid():
        raise RuntimeFileError("runtime dir %s is not owned by the current user" % path)
    if info.st_mode & 0o077:
        raise RuntimeFileError("runtime dir %s must not be accessible to group or others" % path)
    if info.st_mode & 0o700 != 0o700:
        raise RuntimeFileError("runtime dir %s must be rwx for its owner" % path)


def check_socket_path_length(path):
    if len(os.fsencode(path)) > limits.SOCKET_PATH_MAX_BYTES:
        raise RuntimeFileError("socket path is longer than %d bytes: %s"
                               % (limits.SOCKET_PATH_MAX_BYTES, path))


# ----------------------------------------------------------------- token

def load_or_create_token(runtime_dir):
    """Return the 64 hex bytes of the token, creating the file atomically when it is missing."""
    path = os.path.join(runtime_dir, TOKEN_NAME)
    try:
        os.lstat(path)
    except FileNotFoundError:
        _create_token(runtime_dir, path)
    except OSError as exc:
        raise RuntimeFileError("cannot stat token file %s: %s" % (path, exc.strerror)) from None
    return _read_token(path)


def _create_token(runtime_dir, path):
    value = secrets.token_hex(32).encode("ascii")
    temp = os.path.join(runtime_dir, "%s.tmp.%s" % (TOKEN_NAME, secrets.token_hex(8)))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    try:
        fd = os.open(temp, flags, 0o600)
    except OSError as exc:
        raise RuntimeFileError("cannot create token file in %s: %s" % (runtime_dir, exc.strerror)) from None
    try:
        try:
            os.write(fd, value)
        finally:
            os.close(fd)
        try:
            os.link(temp, path)  # fails if another instance created it first; then we read theirs
        except FileExistsError:
            pass
        except OSError as exc:
            raise RuntimeFileError("cannot publish token file %s: %s" % (path, exc.strerror)) from None
    finally:
        try:
            os.unlink(temp)
        except OSError:
            pass


def _read_token(path):
    """Open without following links, verify the fd, and check it is still the file at `path`."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        raise RuntimeFileError("cannot open token file %s: %s" % (path, exc.strerror)) from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeFileError("token file %s is not a regular file" % path)
        if info.st_uid != _current_uid():
            raise RuntimeFileError("token file %s is not owned by the current user" % path)
        if info.st_mode & 0o077:
            raise RuntimeFileError("token file %s must be mode 0600" % path)
        if info.st_size != TOKEN_LENGTH:
            raise RuntimeFileError("token file %s must hold exactly %d bytes" % (path, TOKEN_LENGTH))
        try:
            again = os.lstat(path)
        except OSError:
            raise RuntimeFileError("token file %s changed while being read" % path) from None
        if (again.st_dev, again.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeFileError("token file %s was replaced while being read" % path)
        data = os.read(fd, TOKEN_LENGTH + 1)
    finally:
        os.close(fd)
    if not _TOKEN_PATTERN.match(data):
        raise RuntimeFileError("token file %s does not hold 64 lowercase hex characters" % path)
    return data


# ----------------------------------------------------------------- listener socket

def prepare_listener(sock_path):
    """Bind and listen on `sock_path` (0600), replacing a stale socket but never a live one."""
    check_socket_path_length(sock_path)
    try:
        info = os.lstat(sock_path)
    except FileNotFoundError:
        info = None
    except OSError as exc:
        raise RuntimeFileError("cannot stat socket %s: %s" % (sock_path, exc.strerror)) from None
    if info is not None:
        if not stat.S_ISSOCK(info.st_mode):
            raise RuntimeFileError("%s exists and is not a socket" % sock_path)
        if info.st_uid != _current_uid():
            raise RuntimeFileError("socket %s is not owned by the current user" % sock_path)
        if _socket_is_live(sock_path):
            raise RuntimeFileError("another BatutaMCP instance is already listening on %s" % sock_path)
        try:
            os.unlink(sock_path)
        except OSError as exc:
            raise RuntimeFileError("cannot remove stale socket %s: %s" % (sock_path, exc.strerror)) from None
    listener = None
    bound = False
    try:
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(sock_path)
        bound = True
        os.chmod(sock_path, 0o600)
        listener.listen(1)
    except OSError as exc:
        if listener is not None:
            listener.close()
        if bound:
            remove_socket(sock_path)  # never leave a half-configured socket file behind
        raise RuntimeFileError("cannot listen on %s: %s" % (sock_path, exc.strerror)) from None
    return listener


def _socket_is_live(sock_path):
    probe = None
    try:
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(_STALE_PROBE_TIMEOUT_S)
        probe.connect(sock_path)
    except (ConnectionRefusedError, FileNotFoundError):
        return False
    except OSError as exc:
        return exc.errno != errno.ECONNREFUSED  # timeouts and anything odd: assume it is live
    finally:
        if probe is not None:
            probe.close()
    return True


def socket_identity(sock_path):
    """(st_dev, st_ino) of the socket file we just bound, or None."""
    try:
        info = os.lstat(sock_path)
    except OSError:
        return None
    return (info.st_dev, info.st_ino)


def remove_socket(sock_path, identity=None):
    """Unlink the socket file if it is a socket and (when given) still the one we bound."""
    try:
        info = os.lstat(sock_path)
        if not stat.S_ISSOCK(info.st_mode):
            return
        if identity is not None and (info.st_dev, info.st_ino) != identity:
            return
        os.unlink(sock_path)
    except OSError:
        pass
