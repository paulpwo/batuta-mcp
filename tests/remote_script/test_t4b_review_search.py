"""T4b review round 1, M-4: browsing a huge folder reads children lazily and stops at the node budget.
`iter_children` is used when Live has it, else `children` is iterated with a cap; browser_list never
builds the whole list just to report `total`."""

import unittest

from remote_script.BatutaMCP import limits

from .browser_world import BrowserCase, sample_item
from .fake_browser import FakeItem, FakeItemNoIter

HUGE = 100000


def virtual_samples(count, prefix="n"):
    return (count, lambda i: sample_item("%s%d.wav" % (prefix, i), "query:Samples#%s%d.wav" % (prefix, i)))


class LazyCase(BrowserCase):
    def setUp(self):
        super().setUp()
        FakeItem.reads = 0

    def root(self, **kwargs):
        self.browser.set_category("samples", *[])
        self.browser.samples = FakeItem("samples", "query:samples", **kwargs)


class ListCostTests(LazyCase):
    def test_a_huge_folder_is_read_up_to_the_cap_only(self):
        self.root(virtual=virtual_samples(HUGE))
        page = self.h.ok("browser_list", {"category": "samples", "limit": 5})
        self.assertEqual([i["name"] for i in page["items"]], ["n0.wav", "n1.wav", "n2.wav", "n3.wav", "n4.wav"])
        self.assertEqual((page["total"], page["total_capped"], page["next_offset"]),
                         (limits.SEARCH_NODE_CAP, True, 5))
        self.assertLessEqual(FakeItem.reads, limits.SEARCH_NODE_CAP + 1)

    def test_paging_deeper_than_the_cap_still_works(self):
        self.root(virtual=virtual_samples(HUGE))
        page = self.h.ok("browser_list", {"category": "samples", "limit": 3, "offset": 5000})
        self.assertEqual([i["name"] for i in page["items"]], ["n5000.wav", "n5001.wav", "n5002.wav"])
        self.assertEqual(page["next_offset"], 5003)
        self.assertLessEqual(FakeItem.reads, 5004)

    def test_small_folders_report_an_exact_total(self):
        self.root(children=[sample_item("a.wav", "query:Samples#a.wav"), sample_item("b.wav", "query:Samples#b.wav")])
        page = self.h.ok("browser_list", {"category": "samples", "limit": 1})
        self.assertEqual((page["total"], page["total_capped"], page["next_offset"]), (2, False, 1))
        page = self.h.ok("browser_list", {"category": "samples", "limit": 1, "offset": 1})
        self.assertEqual((page["total"], page["total_capped"], page["next_offset"]), (2, False, None))

    def test_a_live_without_iter_children_is_iterated_through_children(self):
        kids = [sample_item("k%d.wav" % i, "query:Samples#k%d.wav" % i) for i in range(5000)]
        self.browser.samples = FakeItemNoIter("samples", "query:samples", kids)
        page = self.h.ok("browser_list", {"category": "samples", "limit": 2})
        self.assertEqual((page["total"], page["total_capped"]), (limits.SEARCH_NODE_CAP, True))
        self.assertEqual([i["name"] for i in page["items"]], ["k0.wav", "k1.wav"])

    def test_path_navigation_reads_lazily_too(self):
        inner = FakeItem("inner", "query:Samples#inner", virtual=virtual_samples(HUGE))
        self.browser.samples = FakeItem("samples", "query:samples", [inner])
        FakeItem.reads = 0
        page = self.h.ok("browser_list", {"category": "samples", "path": ["inner"], "limit": 2})
        self.assertEqual(len(page["items"]), 2)
        self.assertLessEqual(FakeItem.reads, limits.SEARCH_NODE_CAP + 2)


class SearchCostTests(LazyCase):
    def test_a_huge_root_is_read_up_to_the_node_budget(self):
        self.root(virtual=virtual_samples(HUGE))
        result = self.h.ok("browser_search", {"query": "zzz", "category": "samples"})
        self.assertEqual((result["visited"], result["truncated"]), (limits.SEARCH_NODE_CAP, True))
        self.assertLessEqual(FakeItem.reads, limits.SEARCH_NODE_CAP + 1)

    def test_many_huge_folders_share_one_budget(self):
        folders = [FakeItem("f%d" % i, "query:Samples#f%d" % i, virtual=virtual_samples(HUGE, "f%d_" % i))
                   for i in range(10)]
        self.root(children=folders)
        FakeItem.reads = 0
        result = self.h.ok("browser_search", {"query": "zzz", "category": "samples"})
        self.assertEqual((result["visited"], result["truncated"]), (limits.SEARCH_NODE_CAP, True))
        self.assertLessEqual(FakeItem.reads, limits.SEARCH_NODE_CAP + 20)

    def test_the_search_without_iter_children_still_works_and_is_capped(self):
        kids = [sample_item("k%d.wav" % i, "query:Samples#k%d.wav" % i) for i in range(5000)]
        self.browser.samples = FakeItemNoIter("samples", "query:samples", kids)
        result = self.h.ok("browser_search", {"query": "zzz", "category": "samples"})
        self.assertEqual((result["visited"], result["truncated"]), (limits.SEARCH_NODE_CAP, True))
        self.assertEqual(self.h.ok("browser_search", {"query": "k4.wav", "category": "samples"})["items"][0]["name"],
                         "k4.wav")

    def test_all_categories_share_the_budget_too(self):
        for name in ("samples", "user_library", "packs", "sounds", "drums", "instruments"):
            self.browser.set_category(name, FakeItem("big", "query:%s#big" % name, virtual=virtual_samples(HUGE, name)))
        FakeItem.reads = 0
        result = self.h.ok("browser_search", {"query": "zzz"})
        self.assertEqual(result["visited"], limits.SEARCH_NODE_CAP)
        self.assertLessEqual(FakeItem.reads, limits.SEARCH_NODE_CAP + 20)

    def test_several_huge_category_roots_share_the_budget(self):
        for name in ("samples", "user_library", "packs", "drums"):
            self.browser.__dict__[name] = FakeItem(name, "query:" + name, virtual=virtual_samples(HUGE, name))
        FakeItem.reads = 0
        result = self.h.ok("browser_search", {"query": "zzz"})
        self.assertEqual((result["visited"], result["truncated"]), (limits.SEARCH_NODE_CAP, True))
        self.assertLessEqual(FakeItem.reads, limits.SEARCH_NODE_CAP + 10)

    def test_a_result_limit_stop_still_reports_unvisited_work_as_truncated(self):
        self.root(virtual=virtual_samples(HUGE))
        result = self.h.ok("browser_search", {"query": "n1", "category": "samples", "limit": 3})
        self.assertEqual(len(result["items"]), 3)
        self.assertTrue(result["truncated"])


if __name__ == "__main__":
    unittest.main()
