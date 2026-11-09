"""Evidence-backed buyer facts; delivery acknowledgements remain separate."""
import copy

FIELDS = ("vehicle", "year", "product", "purchase_stage", "current_request", "open_issue")


def sources(context, memory):
    result = {fact["source"]["id"]: fact["source"] for fact in memory.values()}
    result.update({m["id"]: m for m in context["messages"] if m["role"] == "buyer" and m["kind"] == "text"})
    return result


def public(memory):
    return {field: {"quote": fact["quote"], "source_id": fact["source"]["id"],
                    "created_at": fact["source"]["created_at"], "authority": "buyer_statement", "cleared": fact.get("cleared", False)}
            for field, fact in memory.items()}


def _older(source, reference, positions):
    if source["created_at"] != reference["created_at"]:
        return source["created_at"] < reference["created_at"]
    if source["id"] == reference["id"]:
        return False
    # Equal timestamps are valid. Only visible message order can establish
    # that different evidence is newer; a history gap cannot prove it.
    if source["id"] not in positions or reference["id"] not in positions:
        return True
    return positions[source["id"]] < positions[reference["id"]]


def update(memory, changes, context):
    """Accept only bounded verbatim quotes from this event, never generated claims.

    A correction to the vehicle clears its old year unless supplied again. Old
    history cannot overwrite a newer fact. A clear also needs current evidence.
    """
    if not isinstance(changes, list) or len(changes) > len(FIELDS):
        raise ValueError("invalid_memory")
    result = copy.deepcopy(memory)
    visible = {m["id"]: m for m in context["messages"] if m["role"] == "buyer" and m["kind"] == "text"}
    positions = {m["id"]: index for index, m in enumerate(context["messages"])}
    seen = set()
    for change in changes:
        if not isinstance(change, dict) or set(change) - {"field", "source_id", "quote", "clear"}:
            raise ValueError("invalid_memory")
        field, quote, source_id = change.get("field"), change.get("quote"), change.get("source_id")
        if not isinstance(field, str) or field not in FIELDS or field in seen or not isinstance(source_id, str):
            raise ValueError("invalid_memory")
        seen.add(field)
        source = visible.get(source_id)
        if (not source or not isinstance(quote, str) or not 0 < len(quote.strip()) <= 400
                or quote not in source["content"] or type(change.get("clear", False)) is not bool):
            raise ValueError("invalid_memory")
        old = result.get(field)
        if old and _older(source, old["source"], positions):
            raise ValueError("stale_memory")
        result[field] = {"quote": quote, "source": {k: source[k] for k in ("id", "role", "kind", "content", "created_at")},
                         "cleared": change.get("clear", False)}
    changed_vehicle = "vehicle" in seen and (memory.get("vehicle", {}).get("quote") != result["vehicle"]["quote"] or result["vehicle"]["cleared"])
    if changed_vehicle and "year" in result:
        if "year" in seen:
            if _older(result["year"]["source"], result["vehicle"]["source"], positions):
                raise ValueError("old_vehicle_year")
        else:
            # Keep a tombstone: replaying the old year from history must not restore it.
            result["year"] = {**copy.deepcopy(result["vehicle"]), "cleared": True}
    return result
