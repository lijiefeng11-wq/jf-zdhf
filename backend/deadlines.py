"""Validation and diagnostic timing for the negotiated reply deadline."""
import math

CAPABILITY = "reply_deadline"
TRANSFER_CAPABILITY = "reply_timeout_transfer"
TRANSFER_RESERVE = 15
REASON = "reply_deadline_exceeded"
TIMING_INTS = ("queue_wait_ms", "decision_ms", "primary_ms", "backup_ms")
TIMING_FAILURES = ("deadline_exceeded", "cancelled", "model_unavailable", "model_invalid_output", "internal_error")


def valid_budget(value, timeout_transfer=False):
    return type(value) is int and 0 <= value <= (60000 if timeout_transfer else 20000)


def finite(value):
    return type(value) is int or (type(value) is float and math.isfinite(value))


def elapsed_ms(started, ended):
    return max(0, int((ended - started) * 1000))


def sanitize_timing(value):
    """Only fixed enums and measured nonnegative integers may leave the backend."""
    if not isinstance(value, dict):
        return {}
    clean = {key: value[key] for key in TIMING_INTS
             if type(value.get(key)) is int and value[key] >= 0}
    if value.get("model_slot") in ("primary", "backup"):
        clean["model_slot"] = value["model_slot"]
    if type(value.get("fallback_used")) is bool:
        clean["fallback_used"] = value["fallback_used"]
    if value.get("failure_class") in TIMING_FAILURES:
        clean["failure_class"] = value["failure_class"]
    return clean


def failure_class_for_reason(reason):
    if reason == REASON:
        return "deadline_exceeded"
    if reason == "decision_internal_error":
        return "internal_error"
    if isinstance(reason, str) and reason.startswith("model_unavailable"):
        return "model_invalid_output" if "invalid_output" in reason else "model_unavailable"
    return None
