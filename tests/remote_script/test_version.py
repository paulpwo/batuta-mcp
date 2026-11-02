import json
import os
import unittest

from remote_script.BatutaMCP import limits, runtime_files

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class VersionTests(unittest.TestCase):
    def test_checkout_reads_the_version_from_server_package_json(self):
        with open(os.path.join(REPO, "server", "package.json"), encoding="utf-8") as f:
            expected = json.load(f)["version"]
        self.assertIsNone(limits.STAMPED_VERSION)
        self.assertEqual(runtime_files.SCRIPT_VERSION, expected)


if __name__ == "__main__":
    unittest.main()
