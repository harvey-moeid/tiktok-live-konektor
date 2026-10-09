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


def _gift_id(event, gift):
    extended = _value(event, "extended_gift_info", "extendedGiftInfo")
    for source in (event, gift, _value(gift, "info"), extended):
        if source is None:
            continue
        candidate = _value(source, "gift_id", "giftId", "id" if source is not event else "gift_id")
        if candidate is not None and str(candidate).isdigit() and int(candidate) > 0:
            return str(candidate)
    return None


def _gift_name(event, gift, gift_id):
    extended = _value(event, "extended_gift_info", "extendedGiftInfo")
    for source in (event, gift, _value(gift, "info"), extended):
        if source is None:
            continue
        value = _value(source, "gift_name", "giftName", "name")
        if isinstance(value, str):
            name = value.strip()
            if name and name.lower() not in {"unknown", "undefined", "null", "none", "n/a", "gift"}:
                return name[:200]
    return f"Gift #{gift_id}" if gift_id else "Gift tidak dikenal"


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
        coins = _int(_value(gift, "diamond_count", "diamondCount", default=0))
        gift_id = _gift_id(event, gift)
        return {**who, "giftId": gift_id, "giftName": _gift_name(event, gift, gift_id),
                "repeatCount": count, "repeatEnd": True,
                "giftType": _int(_value(gift, "type", default=0)),
                "streakable": streakable, "diamondCount": coins, "totalValue": coins * count}
    if event_type in ("follow", "share", "member"):
        return who
    if event_type == "viewer":
        return {"viewerCount": _int(_value(event, "total_user", "viewer_count", "viewerCount", default=0))}
    return None
