"""Structural send-control selector over one sanitized fragment (stdin JSON line)."""
import json
import re
import sys

from scrapling import Selector

MAX_BYTES = 256 * 1024
SCOPE = ".reply-footer, [data-claw-send-area]"
CONTROL = "div.send-btn, button, [role=button], [data-claw-send-control=true]"
ERRORS = ("input_invalid", "input_too_large", "selector_failed", "ambig", "bad_text", "bad_candidate", "absent")


def _fail(code):
    return {"error": code if code in ERRORS else "selector_failed"}


def _emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def select(raw):
    """Return {candidate:N, engine:"scrapling"} for exactly one structural match, else {error}. Never echoes input."""
    try:
        if not isinstance(raw, (bytes, bytearray)):
            return _fail("input_invalid")
        if len(raw) > MAX_BYTES:
            return _fail("input_too_large")
        doc = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return _fail("input_invalid")
    if not isinstance(doc, dict) or set(doc) != {"html"} or not isinstance(doc["html"], str):
        return _fail("input_invalid")
    try:
        page = Selector(doc["html"], adaptive=False)
        scoped = [page]
    except Exception:
        return _fail("selector_failed")
    hits, malformed = [], False
    for scope in scoped:
        try:
            nodes = scope.css(", ".join(f"{area} {control}" for area in SCOPE.split(", ") for control in CONTROL.split(", ")))
        except Exception:
            return _fail("selector_failed")
        for node in nodes:
            tag = (node.tag or "").lower()
            cls = (node.attrib.get("class") or "").split()
            if not (tag == "button" or (tag == "div" and "send-btn" in cls) or
                    (node.attrib.get("role") or "").lower() == "button" or node.attrib.get("data-claw-send-control") == "true"):
                continue
            label = re.sub(r"\s+", "", node.get_all_text(strip=True))
            if not re.fullmatch(r"(发送|Send)(\(?((Ctrl\+)?Enter|回车)\)?|↵)?|坚持发送", label):
                continue
            cid = node.attrib.get("data-claw-candidate", "")
            if not re.fullmatch(r"[0-9]+", cid) or int(cid) > 100:
                malformed = True
                continue
            hits.append(int(cid))
    if malformed:
        return _fail("bad_candidate")
    if len(hits) > 1:
        return _fail("ambig")
    return {"candidate": hits[0], "engine": "scrapling"} if hits else _fail("absent")


def main(stream=None):
    try:
        result = select((stream or sys.stdin.buffer).readline(MAX_BYTES + 1))
    except Exception:
        result = _fail("selector_failed")
    _emit(result)
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        _emit({"ready": "scrapling"})
        while raw := sys.stdin.buffer.readline(MAX_BYTES + 1):
            try:
                _emit(select(raw))
            except Exception:
                _emit(_fail("selector_failed"))
            if len(raw) > MAX_BYTES:
                break
    else:
        sys.exit(main())
