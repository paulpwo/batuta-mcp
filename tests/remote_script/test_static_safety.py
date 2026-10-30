"""Static safety scan of the Remote Script package (acceptance criterion in the feature document)."""

import ast
import glob
import os
import re
import unittest

PACKAGE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "remote_script", "BatutaMCP")
TOKEN_MODULE = "runtime_files.py"  # the only module allowed to touch files

FORBIDDEN_WORDS = ("subprocess", "eval", "exec", "pickle", "urllib", "http", "requests",
                   "importlib", "marshal", "ctypes", "shutil")
FORBIDDEN_DOTTED = (r"os\.system", r"os\.popen", r"os\.exec\w*", r"os\.spawn\w*", r"os\.fork")


def package_files():
    files = sorted(glob.glob(os.path.join(PACKAGE_DIR, "*.py")))
    return files


class StaticSafetyTests(unittest.TestCase):
    def test_package_has_files(self):
        names = [os.path.basename(p) for p in package_files()]
        self.assertIn("__init__.py", names)
        self.assertIn(TOKEN_MODULE, names)

    def test_no_forbidden_words_anywhere_including_comments(self):
        for path in package_files():
            with open(path, encoding="utf-8") as handle:
                for number, line in enumerate(handle, 1):
                    for word in FORBIDDEN_WORDS:
                        self.assertIsNone(re.search(r"\b%s\b" % word, line),
                                          "%s:%d uses %r" % (os.path.basename(path), number, word))
                    for pattern in FORBIDDEN_DOTTED:
                        self.assertIsNone(re.search(pattern, line),
                                          "%s:%d matches %s" % (os.path.basename(path), number, pattern))

    def test_file_opens_only_in_the_token_module(self):
        for path in package_files():
            if os.path.basename(path) == TOKEN_MODULE:
                continue
            with open(path, encoding="utf-8") as handle:
                for number, line in enumerate(handle, 1):
                    self.assertIsNone(re.search(r"\bopen\s*\(", line),
                                      "%s:%d opens a file" % (os.path.basename(path), number))
                    self.assertIsNone(re.search(r"\bos\.(fdopen|open|remove|rename|replace|unlink|link|mkdir|chmod)\b", line),
                                      "%s:%d touches the filesystem" % (os.path.basename(path), number))

    def test_no_dynamic_attribute_access_or_code_execution_calls(self):
        banned_calls = {"eval", "exec", "compile", "__import__", "setattr", "delattr", "globals",
                        "locals", "vars", "input"}
        for path in package_files():
            with open(path, encoding="utf-8") as handle:
                tree = ast.parse(handle.read(), path)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                if isinstance(node.func, ast.Name):
                    name = node.func.id
                    self.assertNotIn(name, banned_calls, "%s:%d" % (path, node.lineno))
                    if name == "getattr":
                        ok = (len(node.args) >= 2 and isinstance(node.args[1], ast.Constant)
                              and isinstance(node.args[1].value, str))
                        self.assertTrue(ok, "%s:%d getattr with a non-literal name" % (path, node.lineno))

    def test_only_stdlib_and_live_are_imported(self):
        stdlib = {"__future__", "collections", "dataclasses", "errno", "hmac", "json", "os", "queue",
                  "re", "secrets", "selectors", "socket", "stat", "struct", "threading", "time",
                  "typing", "unicodedata", "copy", "math"}
        allowed = stdlib | {"Live"}
        for path in package_files():
            with open(path, encoding="utf-8") as handle:
                tree = ast.parse(handle.read(), path)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        self.assertIn(alias.name.split(".")[0], allowed, "%s:%d" % (path, node.lineno))
                elif isinstance(node, ast.ImportFrom):
                    if node.level:  # relative import inside the package
                        continue
                    self.assertIn((node.module or "").split(".")[0], allowed,
                                  "%s:%d" % (path, node.lineno))

    def test_never_references_framework_modules_or_network_families(self):
        for path in package_files():
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            self.assertNotIn("_Framework", text)
            self.assertNotIn("ableton.v3", text)
            self.assertNotIn("AF_INET", text)
            self.assertNotIn("0.0.0.0", text)

    def test_syntax_is_python_311_compatible(self):
        for path in package_files():
            with open(path, encoding="utf-8") as handle:
                ast.parse(handle.read(), path, feature_version=(3, 11))


if __name__ == "__main__":
    unittest.main()
