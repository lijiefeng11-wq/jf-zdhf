"""The shop's main link and its dedicated car links, read from learned goods (pure: no I/O).

A main link (大链接) sells by note: its specs say the buyer leaves the car ("留言车型+年份"), so any car of the
vehicle table can be ordered on it. A dedicated link (专车链接) lists its cars in the title ("问界m5/m6/…专用…")
and the specs ("款式：问界m5"). When the buyer came in through a dedicated link and asks about a table car it does
not cover, the server recommends the dedicated link of that car, else the main link, with a fixed sentence.
"""
import re

from . import vehicle_match

MAIN = re.compile(r"留言车型|备注车型")
TITLE_CARS = re.compile(r"^(.+?)(?:全车定制|专车专用|专用|定制)")
SPEC_PART = re.compile(r"([^：；]+)：\"([^\"]*)\"")
BRACKET = re.compile(r"[【\[]([^】\]]*)[】\]]")
LEAD = re.compile(r"[\u4e00-\u9fff]+")
CAR_STATUSES = ("matched", "ambiguous", "needs_year", "year_mismatch")
OPEN_ORDER = re.compile(r"待发货|待收货|已发货|待付款|待成团|已签收")
LINK_SENTENCE = re.compile(r"^您进来的是(.+?)专车链接，您的车需要拍(?:「(.+?)」专车链接|店里下单留言车型的通用链接)，"
                           r"我给您记录车型，需要链接说一声我发您$")


def _title_cars(title):
    """("问界m5/m6", ["问界m5", "问界m6"]): the cars before 专用; a bare code ("m6") takes the first car's brand."""
    found = TITLE_CARS.match(title)
    if not found:
        return "", []
    label = found.group(1).strip(" /")
    tokens = [t.strip() for t in label.split("/") if t.strip()]
    lead = LEAD.match(tokens[0]) if tokens else None
    return label, [lead.group(0) + t if i and lead and t[0].isascii() and t[0].isalnum() else t
                   for i, t in enumerate(tokens)]


def _spec_cars(facts):
    """The first spec value of each combination ("款式：\"【26款】问界m7\"" -> "26款 问界m7")."""
    values = []
    for fact in facts:
        if isinstance(fact, str) and fact.startswith("规格组合："):
            parts = SPEC_PART.findall(fact[len("规格组合："):])
            if parts:
                values.append(" ".join(BRACKET.sub(r" \1 ", parts[0][1]).split()))
    return list(dict.fromkeys(values))


def describe(doc, catalog):
    """{kind: main|dedicated|None, label, units}; a unit is one car the link names and the table rows it found."""
    facts = doc.get("facts") or []
    if any(isinstance(f, str) and f.startswith("规格组合：") and MAIN.search(f) for f in facts):
        return {"kind": "main", "label": "", "units": []}
    label, tokens = _title_cars(doc.get("title") or "")
    # A title without cars ("专用汽车遮阳挡…") may still name them in its attribute "适用车型：SU7 Ultra、YU7".
    fits = next((f[len("属性：适用车型："):] for f in facts if isinstance(f, str) and f.startswith("属性：适用车型：")), "")
    label = label or fits
    tokens += [t.strip() for t in re.split(r"[、,，/]", fits) if t.strip()]
    units = []
    for token in dict.fromkeys(tokens + _spec_cars(facts)):
        result = catalog.search(token)
        if result["status"] in CAR_STATUSES and result["candidates"]:
            units.append({"query": token, "families": {c["family"] for c in result["candidates"]},
                          "models": {c["model"] for c in result["candidates"]}})
    return {"kind": "dedicated" if label and units else None, "label": label, "units": units}


def _core(catalog, text):
    word = vehicle_match._normalize(text).replace(" ", "")
    while brand := next((b for b in sorted(catalog.brands, key=len, reverse=True) if word.startswith(b)), None):
        word = word[len(brand):]
    return word


def covers(link, cars, catalog, strict=False):
    """Whether the link names one of the buyer's cars: a table row it found, or (unless strict) a car word of
    the same brand inside the row's name ("卡罗拉" in "卡罗拉/雷凌 19-25款")."""
    for unit in link["units"]:
        for car in cars:
            if car["model"] in unit["models"]:
                return True
            core = _core(catalog, unit["query"])
            if (not strict and car["family"] in unit["families"] and len(core) >= 2
                    and core in vehicle_match._normalize(car["model"]).replace(" ", "")):
                return True
    return False


def _families(link):
    return set().union(*(unit["families"] for unit in link["units"])) if link["units"] else set()


def _pick(docs, titles):
    """The first doc whose title is a goods card of this event, else the first."""
    return next((d for d in docs if d["title"] in titles), docs[0]) if docs else None


def _option(title, options):
    return next((o["option_id"] for o in options if o.get("goods_title") == title), None)


def reply(link):
    target = f"「{link['target']}」专车链接" if link["target"] else "店里下单留言车型的通用链接"
    text = f"您进来的是{link['entry']}专车链接，您的车需要拍{target}，我给您记录车型"
    return text + ("，需要链接说一声我发您" if link["option_id"] else "")


def recommend(context, vehicle, docs, describe_doc, catalog):
    """The link to recommend for a matched car the entry dedicated link does not name, or None.

    Only before an order, only when the buyer's latest goods (the platform's source card or a goods card they
    sent) is a dedicated link. A car of another brand gets the dedicated link that names it, else the main link;
    a car of the entry link's own brand only a dedicated link that found its exact table row, since the entry
    link may name it in a way the table does not.
    """
    if (vehicle or {}).get("status") not in vehicle_match.MATCH_STATUSES or not vehicle.get("candidates"):
        return None
    if any(isinstance(o, dict) and OPEN_ORDER.search(str(o.get("status") or "")) for o in context.get("orders") or ()):
        return None
    goods = [g for g in context.get("goods") or () if isinstance(g, dict) and g.get("product_key")]
    latest = goods[0] if goods else None
    if not latest or not any(e.get("source") == "goods_card" for e in latest.get("evidence") or ()):
        return None
    by_key = {d["product_key"]: d for d in docs}
    entry_doc = by_key.get(latest["product_key"])
    if entry_doc is None:
        return None
    entry = describe_doc(entry_doc)
    cars = vehicle["candidates"]
    if entry["kind"] != "dedicated" or covers(entry, cars, catalog):
        return None
    same_brand = bool({c["family"] for c in cars} & _families(entry))
    options = (context.get("send_options") or {}).get("goods") or []
    titles = {o.get("goods_title") for o in options}
    described = [(d, describe_doc(d)) for d in sorted(docs, key=lambda d: (d["title"], d["product_key"]))]
    dedicated = [d for d, link in described if link["kind"] == "dedicated" and d is not entry_doc
                 and covers(link, cars, catalog, strict=same_brand)]
    target = _pick(dedicated, titles)
    if target is None and not same_brand:
        target = _pick([d for d, link in described if link["kind"] == "main"], titles)
    if target is None:
        return None
    link = {"entry": entry["label"], "target": describe_doc(target)["label"] or None, "goods_title": target["title"],
            "option_id": _option(target["title"], options)}
    return {**link, "reply": reply(link)}


def card_after_recommendation(context, docs, describe_doc):
    """The goods card of the link just recommended, when the buyer answers that sentence and it is sendable now."""
    messages = context.get("messages") or []
    before = [m for m in messages[:-1] if isinstance(m, dict) and m.get("role") in ("buyer", "agent")]
    if not before or before[-1].get("role") != "agent":
        return None
    said = LINK_SENTENCE.match((before[-1].get("content") or "").strip())
    if not said:
        return None
    described = [(d, describe_doc(d)) for d in sorted(docs, key=lambda d: (d["title"], d["product_key"]))]
    target = said.group(2)
    wanted = {d["title"] for d, link in described
              if (link["kind"] == "dedicated" and link["label"] == target if target else link["kind"] == "main")}
    options = (context.get("send_options") or {}).get("goods") or []
    option = next((o["option_id"] for o in options if o.get("goods_title") in wanted), None)
    return {"type": "goods_card", "option_id": option} if option else None
