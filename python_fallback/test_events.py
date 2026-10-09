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

    def test_gift_name_and_id(self):
        gift = SimpleNamespace(name="Rose", id=5655, type=0, streakable=False, diamond_count=1)
        result = normalize_event("gift", event(gift=gift))
        self.assertEqual(result["giftName"], "Rose")
        self.assertEqual(result["giftId"], "5655")
        self.assertEqual(result["totalValue"], 1)

    def test_gift_uses_extended_name_when_missing(self):
        gift = SimpleNamespace(name="Unknown", gift_id=5953, type=0, streakable=False, diamond_count=25)
        extended = SimpleNamespace(name="Nevalyashka doll")
        result = normalize_event("gift", event(gift=gift, extended_gift_info=extended))
        self.assertEqual(result["giftName"], "Nevalyashka doll")
        self.assertEqual(result["giftId"], "5953")

    def test_gift_falls_back_to_stable_id_not_unknown(self):
        gift = SimpleNamespace(name="", gift_id=5953, type=0, streakable=False, diamond_count=0)
        result = normalize_event("gift", event(gift=gift))
        self.assertEqual(result["giftName"], "Gift #5953")
        self.assertEqual(result["giftId"], "5953")
        without_id = normalize_event("gift", event(gift=SimpleNamespace(name="Unknown")))
        self.assertEqual(without_id["giftName"], "Gift tidak dikenal")
        self.assertIsNone(without_id["giftId"])

    def test_no_gift(self):
        self.assertIsNone(normalize_event("gift", event(gift=None)))


if __name__ == "__main__":
    unittest.main()
