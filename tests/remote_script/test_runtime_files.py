import os
import re
import socket
import stat
import unittest
from unittest import mock

from remote_script.BatutaMCP import runtime_files
from remote_script.BatutaMCP.runtime_files import RuntimeFileError

from . import fakes


class RuntimeDirTests(unittest.TestCase):
    def setUp(self):
        self.parent = fakes.short_tmpdir()
        self.addCleanup(fakes.remove_tree, self.parent)
        self.rt = os.path.join(self.parent, "BatutaMCP")

    def test_creates_missing_dir_with_0700_even_with_permissive_umask(self):
        old = os.umask(0)
        try:
            runtime_files.ensure_runtime_dir(self.rt)
        finally:
            os.umask(old)
        self.assertEqual(fakes.mode_of(self.rt), 0o700)

    def test_existing_good_dir_is_accepted_untouched(self):
        os.mkdir(self.rt, 0o700)
        runtime_files.ensure_runtime_dir(self.rt)
        self.assertEqual(fakes.mode_of(self.rt), 0o700)

    def test_refuses_loose_permissions_and_does_not_fix_them(self):
        os.mkdir(self.rt, 0o755)
        os.chmod(self.rt, 0o755)
        with self.assertRaises(RuntimeFileError):
            runtime_files.ensure_runtime_dir(self.rt)
        self.assertEqual(fakes.mode_of(self.rt), 0o755)

    def test_refuses_group_only_bits(self):
        os.mkdir(self.rt, 0o700)
        os.chmod(self.rt, 0o710)
        with self.assertRaises(RuntimeFileError):
            runtime_files.ensure_runtime_dir(self.rt)

    def test_refuses_dir_without_owner_rwx(self):
        os.mkdir(self.rt, 0o700)
        os.chmod(self.rt, 0o500)
        try:
            with self.assertRaises(RuntimeFileError):
                runtime_files.ensure_runtime_dir(self.rt)
        finally:
            os.chmod(self.rt, 0o700)

    def test_refuses_symlink_to_dir(self):
        real = os.path.join(self.parent, "real")
        os.mkdir(real, 0o700)
        os.symlink(real, self.rt)
        with self.assertRaises(RuntimeFileError):
            runtime_files.ensure_runtime_dir(self.rt)

    def test_refuses_regular_file(self):
        with open(self.rt, "w") as handle:
            handle.write("x")
        with self.assertRaises(RuntimeFileError):
            runtime_files.ensure_runtime_dir(self.rt)

    def test_refuses_wrong_owner(self):
        os.mkdir(self.rt, 0o700)
        with mock.patch.object(runtime_files, "_current_uid",
                               return_value=os.getuid() + 1):
            with self.assertRaises(RuntimeFileError):
                runtime_files.ensure_runtime_dir(self.rt)

    def test_missing_parent_is_refused(self):
        with self.assertRaises(RuntimeFileError):
            runtime_files.ensure_runtime_dir(os.path.join(self.parent, "no", "BatutaMCP"))

    def test_socket_path_length_limit(self):
        runtime_files.check_socket_path_length("/" + "a" * 102)  # 103 bytes
        with self.assertRaises(RuntimeFileError):
            runtime_files.check_socket_path_length("/" + "a" * 103)  # 104 bytes


class TokenTests(unittest.TestCase):
    def setUp(self):
        self.rt = fakes.short_tmpdir()
        self.addCleanup(fakes.remove_tree, self.rt)
        self.token_path = os.path.join(self.rt, "token")

    def test_creates_token_0600_64_hex_no_newline_and_no_leftovers(self):
        token = runtime_files.load_or_create_token(self.rt)
        self.assertRegex(token.decode("ascii"), r"^[0-9a-f]{64}$")
        self.assertEqual(fakes.mode_of(self.token_path), 0o600)
        with open(self.token_path, "rb") as handle:
            self.assertEqual(handle.read(), token)
        self.assertEqual(os.listdir(self.rt), ["token"])

    def test_second_call_returns_same_token(self):
        first = runtime_files.load_or_create_token(self.rt)
        self.assertEqual(first, runtime_files.load_or_create_token(self.rt))

    def test_uses_random_exclusive_nofollow_tmp_name(self):
        seen = []
        real_open = os.open

        def spy(path, flags, *args, **kwargs):
            seen.append((path, flags))
            return real_open(path, flags, *args, **kwargs)

        with mock.patch.object(runtime_files.os, "open", side_effect=spy):
            runtime_files.load_or_create_token(self.rt)
        creates = [(p, f) for p, f in seen if f & os.O_CREAT]
        self.assertEqual(len(creates), 1)
        path, flags = creates[0]
        self.assertRegex(os.path.basename(path), r"^token\.tmp\.[0-9a-f]{16}$")
        self.assertNotIn(str(os.getpid()), os.path.basename(path))
        self.assertTrue(flags & os.O_EXCL)
        self.assertTrue(flags & os.O_NOFOLLOW)
        reads = [f for p, f in seen if p == self.token_path]
        self.assertTrue(reads and all(f & os.O_NOFOLLOW for f in reads))

    def _write(self, data, mode=0o600):
        fd = os.open(self.token_path, os.O_WRONLY | os.O_CREAT, mode)
        os.write(fd, data)
        os.close(fd)
        os.chmod(self.token_path, mode)

    def test_refuses_loose_permissions(self):
        self._write(b"a" * 64, 0o644)
        with self.assertRaises(RuntimeFileError):
            runtime_files.load_or_create_token(self.rt)

    def test_refuses_wrong_size(self):
        self._write(b"a" * 63)
        with self.assertRaises(RuntimeFileError):
            runtime_files.load_or_create_token(self.rt)
        self._write(b"a" * 64 + b"\n")
        with self.assertRaises(RuntimeFileError):
            runtime_files.load_or_create_token(self.rt)

    def test_refuses_non_hex_and_uppercase(self):
        self._write(b"g" * 64)
        with self.assertRaises(RuntimeFileError):
            runtime_files.load_or_create_token(self.rt)
        self._write(b"A" * 64)
        with self.assertRaises(RuntimeFileError):
            runtime_files.load_or_create_token(self.rt)

    def test_refuses_symlink_token(self):
        real = os.path.join(self.rt, "elsewhere")
        fd = os.open(real, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, b"a" * 64)
        os.close(fd)
        os.symlink(real, self.token_path)
        with self.assertRaises(RuntimeFileError):
            runtime_files.load_or_create_token(self.rt)

    def test_refuses_directory_token(self):
        os.mkdir(self.token_path, 0o700)
        with self.assertRaises(RuntimeFileError):
            runtime_files.load_or_create_token(self.rt)

    def test_refuses_wrong_owner(self):
        self._write(b"a" * 64)
        with mock.patch.object(runtime_files, "_current_uid",
                               return_value=os.getuid() + 1):
            with self.assertRaises(RuntimeFileError):
                runtime_files.load_or_create_token(self.rt)

    def test_refuses_when_inode_changes_between_lstat_and_fstat(self):
        self._write(b"a" * 64)
        real_lstat = os.lstat

        def swapped(path, *args, **kwargs):
            result = real_lstat(path, *args, **kwargs)
            if path == self.token_path:
                values = list(result)
                values[stat.ST_INO] += 1
                return os.stat_result(values)
            return result

        with mock.patch.object(runtime_files.os, "lstat", side_effect=swapped):
            with self.assertRaises(RuntimeFileError):
                runtime_files.load_or_create_token(self.rt)

    def test_error_text_never_contains_the_token(self):
        self._write(b"a" * 64, 0o644)
        try:
            runtime_files.load_or_create_token(self.rt)
        except RuntimeFileError as exc:
            self.assertNotIn("a" * 64, str(exc))


class ListenerTests(unittest.TestCase):
    def setUp(self):
        self.rt = fakes.short_tmpdir()
        self.addCleanup(fakes.remove_tree, self.rt)
        self.path = os.path.join(self.rt, "live.sock")

    def test_binds_with_0600_and_listens(self):
        listener = runtime_files.prepare_listener(self.path)
        self.addCleanup(listener.close)
        self.assertEqual(fakes.mode_of(self.path), 0o600)
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(client.close)
        client.connect(self.path)

    def test_replaces_a_stale_socket_file(self):
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(self.path)
        stale.close()  # leaves the file behind with nobody listening
        listener = runtime_files.prepare_listener(self.path)
        listener.close()

    def test_refuses_when_another_instance_is_live(self):
        live = runtime_files.prepare_listener(self.path)
        self.addCleanup(live.close)
        with self.assertRaises(RuntimeFileError):
            runtime_files.prepare_listener(self.path)
        self.assertTrue(os.path.exists(self.path))  # the live listener's socket file is untouched
        self.assertEqual(fakes.mode_of(self.path), 0o600)

    def test_refuses_non_socket_file(self):
        with open(self.path, "w") as handle:
            handle.write("x")
        with self.assertRaises(RuntimeFileError):
            runtime_files.prepare_listener(self.path)
        self.assertTrue(os.path.exists(self.path))

    def test_refuses_foreign_owned_socket(self):
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(self.path)
        stale.close()
        with mock.patch.object(runtime_files, "_current_uid",
                               return_value=os.getuid() + 1):
            with self.assertRaises(RuntimeFileError):
                runtime_files.prepare_listener(self.path)

    def test_refuses_overlong_path(self):
        with self.assertRaises(RuntimeFileError):
            runtime_files.prepare_listener("/" + "a" * 120 + ".sock")

    def test_remove_socket_only_removes_sockets(self):
        listener = runtime_files.prepare_listener(self.path)
        listener.close()
        runtime_files.remove_socket(self.path)
        self.assertFalse(os.path.exists(self.path))
        with open(self.path, "w") as handle:
            handle.write("x")
        runtime_files.remove_socket(self.path)
        self.assertTrue(os.path.exists(self.path))


if __name__ == "__main__":
    unittest.main()
