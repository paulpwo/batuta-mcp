"""Shared setup for the T4b browser tests."""

from .device_world import DeviceCase
from .fake_browser import FakeItem, devices_loader, install_browser
from .fake_devices import FakeDevice
from .fakes import uninstall_fake_live

USER_PRESETS = {"allow_user_presets": True}
PLUGINS = {"allow_plugins": True}


class BrowserCase(DeviceCase):
    """A `world()` harness with the standard hostile fake browser installed as `Live`'s browser."""

    def setUp(self):
        super().setUp()
        self.browser = install_browser(self.h)
        self.addCleanup(uninstall_fake_live)

    def listing(self, category, path=None, flags=None):
        """All items of a category (or sub-folder) by name, read through browser_list pages."""
        if flags is not None:
            self.h.flags = flags
        items, offset = {}, 0
        while offset is not None:
            args = {"category": category, "offset": offset, "limit": 200}
            if path:
                args["path"] = path
            page = self.h.ok("browser_list", args)
            items.update({item["name"]: item for item in page["items"]})
            offset = page["next_offset"]
        return items

    def refusal(self, error):
        """(code, reason) of a typed refusal."""
        return error["code"], error["details"]["reason"]

    def load(self, uri, track=None):
        return self.h.run("browser_load", {"track": track or {"kind": "track", "index": 0}, "uri": uri})

    def listed_uri(self, category, name, path=None, flags=None):
        return self.listing(category, path, flags)[name]["uri"]

    def selected(self):
        return self.h.song.view.selected_track


def custom_category(browser, name, *items):
    browser.set_category(name, *items)


def sample_item(name, uri):
    return FakeItem(name, uri, loadable=True,
                    loader=devices_loader(lambda: FakeDevice("Simpler", "OriginalSimpler", 1)))
