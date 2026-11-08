"""A killable worker for negotiated budgets, including stalled DNS/socket reads."""
import multiprocessing
import time

from . import diagnostics
from .engine import decide, decision


class _Relay:
    """The child has no log file: each record goes to the parent at once, so a child killed at the
    deadline still leaves its model_attempt in the parent's log."""
    def __init__(self, connection):
        self.connection = connection

    def write(self, event, **fields):
        try:
            self.connection.send(("diagnostic", event, fields))
        except OSError:
            pass  # As with the log file, a lost record never changes the decision.


def _run(connection, job, config):
    try:
        try:
            with diagnostics.scope(_Relay(connection)):
                result = decide(job, config)
        except Exception:
            job["timing"] = {"failure_class": "internal_error"}
            result = decision("handoff", "decision_internal_error")
        connection.send(("result", result, job.get("timing", {})))
    finally:
        connection.close()


def bounded_decide(job, config, active, stopped):
    """At most one child per occupied scheduler slot; always reap before reuse."""
    deadline = job["deadline_monotonic"]
    if time.monotonic() >= deadline or not active():
        return decision("handoff", "reply_deadline_exceeded")
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_run, args=(sender, job, config), daemon=True)
    started = False
    try:
        process.start()
        started = True
        sender.close()
        while not stopped.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not active():
                return decision("handoff", "reply_deadline_exceeded")
            if receiver.poll(min(0.05, remaining)):
                kind, first, second = receiver.recv()
                if kind == "diagnostic":
                    diagnostics.emit(first, **second)  # In the parent's scope: event_ref is added here.
                    continue
                result, timing = first, second
                if time.monotonic() >= deadline or not active():
                    return decision("handoff", "reply_deadline_exceeded")
                job["timing"] = timing
                return result
            if not process.is_alive():
                # The child can send and exit between poll() and is_alive().
                if receiver.poll(0):
                    continue
                job["timing"] = {"failure_class": "internal_error"}
                return decision("handoff", "decision_internal_error")
        return decision("handoff", "backend_stopping")
    except (EOFError, OSError):
        job["timing"] = {"failure_class": "internal_error"}
        return decision("handoff", "decision_internal_error")
    finally:
        sender.close()
        try:
            # Records the child sent before a deadline / stop return (the attempt that ran out of time).
            while receiver.poll(0):
                message = receiver.recv()
                if message[0] == "diagnostic":
                    diagnostics.emit(message[1], **message[2])
        except (EOFError, OSError):
            pass
        receiver.close()
        if started:
            if process.is_alive():
                process.terminate()
            process.join(timeout=0.5)
            if process.is_alive():
                process.kill()
                process.join()
            process.close()
