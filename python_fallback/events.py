"""Convert TikTokLive Python events to the Node bridge's stable event schema."""


def _value(obj, *names, default=None):
    for name in names:
        value = getattr(obj, name, None)
        if value is not None:
            return value
    return default


def _int(value, default=0):
    try:
        return max(int(value), 0)
    except (ValueError, TypeError, OverflowError):
        return default


def _identity(event):
    user = getattr(event, "user", None)
    return {
        "username": str(_value(user, "unique_id", "uniqueId", default="unknown")),
        "nickname": str(_value(user, "nickname", default="")),
    }


def normalize_event(event_type, event):
    who = _identity(event)
    if event_type == "chat":
        return {**who, "message": str(_value(event, "comment", default=""))[:10000]}
    if event_type == "like":
        return {**who, "likeCount": _int(_value(event, "count", "like_count", default=1), 1),
                "totalLikeCount": _int(_value(event, "total", "total_like_count"))}
    if event_type == "gift":
        gift = getattr(event, "gift", None)
        if gift is None:
            return None
        streakable = bool(_value(gift, "streakable", default=False))
        if streakable and bool(_value(event, "streaking", default=False)):
            return None  # One final event per streak; do not double-count.
        count = max(_int(_value(event, "repeat_count", default=1), 1), 1)
        coins = _int(_value(gift, "diamond_count", default=0))
        return {**who, "giftName": str(_value(gift, "name", default="Unknown")),
                "repeatCount": count, "repeatEnd": True,
                "giftType": _int(_value(gift, "type", default=0)),
                "streakable": streakable, "diamondCount": coins, "totalValue": coins * count}
    if event_type in ("follow", "share", "member"):
        return who
    if event_type == "viewer":
        return {"viewerCount": _int(_value(event, "total_user", "viewer_count", "viewerCount", default=0))}
    return None
