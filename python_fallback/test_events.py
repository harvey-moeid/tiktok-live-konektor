import unittest
from types import SimpleNamespace

from python_fallback.events import normalize_event


def event(**kwargs):
    return SimpleNamespace(user=SimpleNamespace(unique_id="tester", nickname="Tester"), **kwargs)


class NormalizationTests(unittest.TestCase):
    def test_comment(self):
        self.assertEqual(normalize_event("chat", event(comment="halo"))["message"], "halo")

    def test_like(self):
        self.assertEqual(normalize_event("like", event(count=13))["likeCount"], 13)

    def test_gift_streak_dedup(self):
        gift = SimpleNamespace(name="Rose", type=1, streakable=True, diamond_count=1)
        self.assertIsNone(normalize_event("gift", event(gift=gift, repeat_count=2, streaking=True)))
        done = normalize_event("gift", event(gift=gift, repeat_count=3, streaking=False))
        self.assertEqual(done["repeatCount"], 3)
        self.assertEqual(done["totalValue"], 3)
        self.assertTrue(done["repeatEnd"])

    def test_no_gift(self):
        self.assertIsNone(normalize_event("gift", event(gift=None)))


if __name__ == "__main__":
    unittest.main()
