"""Agent Viewer Python SDK.

Simple, production-grade integration client for connecting external AI agents
to Agent Viewer virtual office observability.
"""

from __future__ import annotations

import atexit
import hashlib
import hmac
import http.client
import json
import logging
import os
import random
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple, Union

logger = logging.getLogger("agent_viewer")

COST_SOURCES = ("provider-reported", "estimated", "unknown")

_UNSTATED_COST_SOURCE_WARNING = (
    'Agent Viewer: a cost was reported without cost_source, so it is sent as costSource="unknown". '
    'Pass cost_source="provider-reported" or "estimated" to state where the cost comes from.'
)

# snake_case kwarg -> camelCase query param for AgentViewer.usage_rollup() (issue #66). Mirrors the server's
# own parseUsageFilters().
_ROLLUP_FILTER_QUERY_NAMES = {
    "agent_id": "agentId",
    "model": "model",
    "provider": "provider",
    "session_id": "sessionId",
    "task_id": "taskId",
    "runtime_id": "runtimeId",
    "user_id": "userId",
    "tag": "tag",
    "status": "status",
    "cost_source": "costSource",
    "currency": "currency",
}

# -------------------------------------------------------------
# Usage correlation block (issue #64): traceId, parentId, toolCallId, meetingId, userId, tags.
#
# This SDK ships standalone and does not import the server contract, so the three limits and the
# whitespace rule are kept here as an explicit copy. tests/fixtures/usage-correlation-vectors.json is the
# shared test-vector file that keeps this copy, the server contract and the TypeScript SDK from drifting.
# -------------------------------------------------------------

CORRELATION_ID_MAX_LENGTH = 128
USAGE_TAGS_MAX = 20
USAGE_TAG_MAX_LENGTH = 64

# Same exact whitespace set as ECMAScript's String.prototype.trim (value !== value.trim()). Deliberately NOT
# str.strip(): Python's default whitespace set differs (for example it strips U+001C-U+001F and U+0085,
# which are not in this set) and does not include U+00A0 or U+FEFF, which are.
_TRIMMABLE_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d   "
    "           "
    "    　﻿"
)


def _utf16_length(value: str) -> int:
    """Counts UTF-16 code units, matching JavaScript's String.length for astral characters."""
    return len(value.encode("utf-16-le")) // 2


def _has_control_character(value: str) -> bool:
    return any(ord(ch) <= 0x1F or ord(ch) == 0x7F for ch in value)


def _has_leading_or_trailing_whitespace(value: str) -> bool:
    return bool(value) and (value[0] in _TRIMMABLE_WHITESPACE or value[-1] in _TRIMMABLE_WHITESPACE)


def _validate_correlation_id(name: str, value: Any) -> None:
    """Validates one correlation id field with the server's exact rules. Raises ``TypeError`` for a
    non-string value and ``ValueError`` naming the argument for anything else that is invalid. ``None``
    means "not reported" and is always accepted; never truncates.
    """
    if value is None:
        return
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string (got {type(value).__name__})")
    length = _utf16_length(value)
    if length < 1:
        raise ValueError(f"{name} must not be empty")
    if length > CORRELATION_ID_MAX_LENGTH:
        raise ValueError(f"{name} must be at most {CORRELATION_ID_MAX_LENGTH} characters")
    if _has_control_character(value):
        raise ValueError(f"{name} must not contain control characters")
    if _has_leading_or_trailing_whitespace(value):
        raise ValueError(f"{name} must not have leading or trailing whitespace")


def _validate_tags(tags: Any) -> None:
    """Validates ``tags`` with the server's exact rules. A ``str`` or ``bytes`` raises ``TypeError`` (a
    ``str`` is itself a ``Sequence`` and would otherwise be split into one tag per character).
    """
    if tags is None:
        return
    if isinstance(tags, (str, bytes)):
        raise TypeError("tags must be a sequence of strings, not a single str or bytes")
    if not isinstance(tags, Sequence):
        raise TypeError("tags must be a sequence of strings")
    tags_list = list(tags)
    if len(tags_list) > USAGE_TAGS_MAX:
        raise ValueError(f"At most {USAGE_TAGS_MAX} tags are allowed")
    for index, tag in enumerate(tags_list):
        if not isinstance(tag, str):
            raise TypeError(f"tags[{index}] must be a string")
        length = _utf16_length(tag)
        if length < 1:
            raise ValueError(f"tags[{index}] must not be empty")
        if length > USAGE_TAG_MAX_LENGTH:
            raise ValueError(f"tags[{index}] must be at most {USAGE_TAG_MAX_LENGTH} characters")
        if _has_control_character(tag):
            raise ValueError(f"tags[{index}] must not contain control characters")
        if _has_leading_or_trailing_whitespace(tag):
            raise ValueError(f"tags[{index}] must not have leading or trailing whitespace")


def _validate_usage_correlation(
    trace_id: Optional[str],
    parent_id: Optional[str],
    tool_call_id: Optional[str],
    meeting_id: Optional[str],
    user_id: Optional[str],
    tags: Optional[Sequence[str]],
) -> None:
    _validate_correlation_id("trace_id", trace_id)
    _validate_correlation_id("parent_id", parent_id)
    _validate_correlation_id("tool_call_id", tool_call_id)
    _validate_correlation_id("meeting_id", meeting_id)
    _validate_correlation_id("user_id", user_id)
    _validate_tags(tags)


def _correlation_payload(
    trace_id: Optional[str],
    parent_id: Optional[str],
    tool_call_id: Optional[str],
    meeting_id: Optional[str],
    user_id: Optional[str],
    tags: Optional[Sequence[str]],
) -> Dict[str, Any]:
    """Builds the payload keys for the six correlation fields, only when given (never ``None`` on the wire)."""
    payload: Dict[str, Any] = {}
    if trace_id is not None:
        payload["traceId"] = trace_id
    if parent_id is not None:
        payload["parentId"] = parent_id
    if tool_call_id is not None:
        payload["toolCallId"] = tool_call_id
    if meeting_id is not None:
        payload["meetingId"] = meeting_id
    if user_id is not None:
        payload["userId"] = user_id
    if tags is not None:
        payload["tags"] = list(tags)
    return payload


class AgentViewerError(Exception):
    """Exception raised by Agent Viewer API client.

    ``code`` is the ``error`` field of the response body when there is one. ``"conflicting_duplicate"``
    (``status_code`` 409) means an event with the same id was already stored with different content: the
    new event was not applied, and resending it will never succeed. The client never retries a 409.

    ``transient`` (issue #101) is ``True`` when every retry was exhausted on a cause that could plausibly
    succeed later: a network error, or HTTP 408/429/5xx. It is ``False`` (the default) for a 4xx the server
    answered conclusively (including 409), which raises immediately without retrying. The spool (when
    enabled) queues an event only when ``transient`` is ``True``; it never queues a conclusive rejection.
    """

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        issues: Optional[List[Dict[str, Any]]] = None,
        code: Optional[str] = None,
        transient: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.issues = issues
        self.code = code
        self.transient = transient


def _append_repeatable(
    params: List[Tuple[str, str]], key: str, value: Optional[Union[str, Sequence[str]]]
) -> None:
    """Appends one query parameter per value of a repeatable filter (issue #67's ``list_calls``): a single
    string becomes one pair, a sequence becomes one pair per item, sent as repeated query parameters."""
    if value is None:
        return
    values: Sequence[str] = [value] if isinstance(value, str) else list(value)
    for v in values:
        params.append((key, v))


def _default_event_id() -> str:
    """Full 128-bit random id. Two distinct events never share an id by chance."""
    return f"evt_{uuid.uuid4().hex}"


# -------------------------------------------------------------
# Outbound webhook signature verification (issue #86, sub-issue #323)
# -------------------------------------------------------------


def verify_webhook_signature(
    secret: str,
    timestamp: Union[int, str],
    raw_body: Union[str, bytes],
    signature: str,
    tolerance_ms: int = 300_000,
    now_ms: Optional[Union[int, float]] = None,
) -> bool:
    """Verifies an outbound Agent Viewer webhook (for example a ``budget.alert`` delivery, issue #86's
    sub-issue #321), the receiver-side counterpart of the inbound HMAC check ``server/index.ts`` already
    does for ``POST /api/v1/webhooks/generic``. Same scheme: HMAC-SHA256 hex digest of
    ``f"{timestamp}.{raw_body}"``. This function never sends anything and never builds or emits a
    ``budget.alert`` event itself; that type is reserved to the server (issue #319). It is header-agnostic:
    the caller extracts ``X-Agent-Viewer-Signature``/``X-Agent-Viewer-Timestamp`` (or whatever headers its
    own transport uses) and passes their values in.

    Returns ``False``, never raises, for every failure: a ``timestamp`` more than ``tolerance_ms``
    milliseconds away from ``now_ms`` in either direction (older *or* newer, replay and clock-skew
    protection alike), or a signature mismatch. ``now_ms`` defaults to ``time.time() * 1000`` when not
    given. The comparison is constant-time (:func:`hmac.compare_digest`, never ``==`` on the hex strings),
    so neither a wrong signature nor its length leaks through timing.

    ``raw_body`` must be the exact bytes (or the exact string, encoded as UTF-8) the sender signed, before
    any JSON re-serialization: re-encoding a parsed body can reorder keys or change whitespace and would
    make a genuine signature fail to verify.
    """
    effective_now = now_ms if now_ms is not None else time.time() * 1000
    try:
        parsed_timestamp = float(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(effective_now - parsed_timestamp) > tolerance_ms:
        return False

    body_bytes = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    message = f"{timestamp}.".encode("utf-8") + body_bytes
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


# -------------------------------------------------------------
# Durable local queue / spool (issue #101). Shared contract with the TypeScript SDK (#102) is
# docs/sdk-queue.md; cross-language vectors live in tests/fixtures/sdk-queue-scenarios.json.
# -------------------------------------------------------------

_SPOOL_SCHEMA_VERSION = 1
_SPOOL_OVERFLOW_POLICIES = ("drop_oldest", "drop_newest")
_SPOOL_DEAD_LETTER_CAP = 100
_SPOOL_USAGE_TYPES = frozenset({"llm.usage", "llm.failed"})

_SPOOL_COUNTER_NAMES = (
    "enqueued_total",
    "replayed_total",
    "duplicates_acked_total",
    "dropped_overflow_total",
    "dropped_overflow_usage_total",
    "dropped_spool_error_total",
    "dropped_spool_error_usage_total",
    "rejected_total",
    "rejected_usage_total",
    "rejected_evicted_total",
    "corrupt_spool_total",
)


class _SpoolState:
    IDLE = "idle"
    DRAINING = "draining"
    SERVER_DOWN = "server_down"
    AUTH_FAILED = "auth_failed"
    DISABLED = "disabled"


@dataclass
class FlushResult:
    """Return value of :meth:`AgentViewer.flush`. With the spool disabled, every count is ``0``,
    ``timed_out`` is ``False`` and ``state`` is ``"disabled"``."""

    delivered: int
    remaining: int
    rejected: int
    timed_out: bool
    state: str


@dataclass
class SpoolStats:
    """Snapshot returned by :meth:`AgentViewer.spool_stats`. Every counter is an event count: the SDK
    never sums, prices or defaults tokens or cost here. ``state`` is one of ``"idle"``, ``"draining"``,
    ``"server_down"``, ``"auth_failed"`` or ``"disabled"``. With the spool disabled every counter is ``0``
    and ``oldest_pending_age_s``/``last_error``/``last_success_at`` are ``None``.
    """

    state: str
    pending_events: int = 0
    pending_bytes: int = 0
    oldest_pending_age_s: Optional[float] = None
    enqueued_total: int = 0
    replayed_total: int = 0
    duplicates_acked_total: int = 0
    dropped_overflow_total: int = 0
    dropped_overflow_usage_total: int = 0
    dropped_spool_error_total: int = 0
    dropped_spool_error_usage_total: int = 0
    rejected_total: int = 0
    rejected_usage_total: int = 0
    rejected_evicted_total: int = 0
    corrupt_spool_total: int = 0
    last_error: Optional[str] = None
    last_success_at: Optional[int] = None


class _TransientNetworkError(Exception):
    """Raised internally by a single, no-retry drain request on any network-level failure."""


def _is_transient_http_status(status_code: int) -> bool:
    return status_code == 408 or status_code == 429 or 500 <= status_code < 600


def _spool_file_name(url: str, runtime_id: Optional[str]) -> str:
    digest = hashlib.sha256(f"{url}|{runtime_id or ''}".encode("utf-8")).hexdigest()[:12]
    return f"spool-{digest}.sqlite3"


def _parse_retry_after_seconds(headers: Optional[Dict[str, str]]) -> Optional[float]:
    if not headers:
        return None
    value = headers.get("Retry-After")
    if value is None:
        for key, val in headers.items():
            if key.lower() == "retry-after":
                value = val
                break
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _format_validation_issue_text(errors: List[Dict[str, Any]], index: int) -> str:
    for entry in errors:
        if entry.get("index") == index:
            issues = entry.get("issues") or []
            parts = []
            for issue in issues:
                path = issue.get("path") if isinstance(issue, dict) else None
                message = issue.get("message", "") if isinstance(issue, dict) else str(issue)
                parts.append(f"{path}: {message}" if path else message)
            return "; ".join(p for p in parts if p) or "validation_failed"
    return "validation_failed"


class _Spool:
    """SQLite-backed, stdlib-only durable spool for one ``(url, runtime_id)`` destination. Pure storage and
    counters; all network I/O lives on :class:`AgentViewer`. Every public method takes ``self._lock``, so
    all storage operations are serialized within one process; SQLite's own WAL mode and ``busy_timeout``
    cover cooperating processes sharing the same spool directory.
    """

    def __init__(
        self,
        spool_dir: str,
        url: str,
        runtime_id: Optional[str],
        max_events: int,
        max_bytes: int,
        overflow: str,
    ) -> None:
        self.max_events = max_events
        self.max_bytes = max_bytes
        self.overflow = overflow
        self.disabled = False
        self._lock = threading.Lock()
        self._state = _SpoolState.IDLE
        self._local = threading.local()

        os.makedirs(spool_dir, exist_ok=True)
        try:
            os.chmod(spool_dir, 0o700)
        except OSError:
            pass
        self.path = os.path.join(spool_dir, _spool_file_name(url, runtime_id))
        self._init_db()

    # -- connection management (per thread, re-created after a fork) --------------------------------

    def _connect_raw(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=5.0, isolation_level=None, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
        return conn

    def _conn(self) -> sqlite3.Connection:
        pid = os.getpid()
        if getattr(self._local, "pid", None) != pid:
            self._local.conn = self._connect_raw()
            self._local.pid = pid
        return self._local.conn

    # -- schema / bootstrap ---------------------------------------------------------------------------

    def _create_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS spool (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                event_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                enqueued_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                event_json TEXT NOT NULL
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS rejected (
                seq INTEGER PRIMARY KEY,
                event_id TEXT,
                event_type TEXT,
                rejected_at INTEGER,
                status_code INTEGER,
                reason TEXT,
                event_json TEXT
            )"""
        )
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    def _init_db(self) -> None:
        try:
            conn = self._conn()
            self._create_schema(conn)
            row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
            if row is None:
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
                    (str(_SPOOL_SCHEMA_VERSION),),
                )
            elif int(row[0]) > _SPOOL_SCHEMA_VERSION:
                logger.error(
                    "Agent Viewer: spool file %s has schema_version %s, newer than this SDK's %s. "
                    "Leaving it untouched and disabling the spool for this run.",
                    self.path, row[0], _SPOOL_SCHEMA_VERSION,
                )
                self.disabled = True
        except sqlite3.DatabaseError as err:
            self._quarantine_and_recreate(err)

    def _quarantine_and_recreate(self, err: Exception) -> None:
        try:
            conn = getattr(self._local, "conn", None)
            if conn is not None:
                conn.close()
        except Exception:
            pass
        self._local.conn = None
        quarantine_path = f"{self.path}.corrupt-{int(time.time() * 1000)}"
        try:
            os.replace(self.path, quarantine_path)
        except OSError:
            pass
        logger.error(
            "Agent Viewer: spool file %s was corrupt (%s). Quarantined to %s and starting a fresh spool.",
            self.path, err, quarantine_path,
        )
        conn = self._conn()
        self._create_schema(conn)
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", (str(_SPOOL_SCHEMA_VERSION),))
        self._incr_counters_in_txn(conn, {"corrupt_spool_total": 1})

    # -- meta / counters --------------------------------------------------------------------------

    def _get_meta(self, conn: sqlite3.Connection, key: str) -> Optional[str]:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def _set_meta(self, conn: sqlite3.Connection, key: str, value: str) -> None:
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))

    def _incr_counters_in_txn(self, conn: sqlite3.Connection, deltas: Dict[str, int]) -> None:
        for name, delta in deltas.items():
            if not delta:
                continue
            key = f"counter:{name}"
            current = int(self._get_meta(conn, key) or "0")
            self._set_meta(conn, key, str(current + delta))

    def incr_counter(self, name: str, delta: int) -> None:
        with self._lock:
            conn = self._conn()
            self._incr_counters_in_txn(conn, {name: delta})

    def set_last_error(self, message: str) -> None:
        with self._lock:
            conn = self._conn()
            self._set_meta(conn, "last_error", message[:500])

    def set_meta_last_success(self) -> None:
        with self._lock:
            conn = self._conn()
            self._set_meta(conn, "last_success_at", str(int(time.time() * 1000)))

    def mark_auth_failed_now(self) -> None:
        with self._lock:
            conn = self._conn()
            self._set_meta(conn, "auth_failed_since", str(int(time.time() * 1000)))

    def auth_retry_due(self, max_probe_interval: float, force: bool = False) -> bool:
        if force:
            return True
        with self._lock:
            conn = self._conn()
            since = self._get_meta(conn, "auth_failed_since")
        if since is None:
            return True
        elapsed_s = (time.time() * 1000 - int(since)) / 1000.0
        return elapsed_s >= max_probe_interval

    # -- state ------------------------------------------------------------------------------------

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    def set_state(self, value: str) -> None:
        with self._lock:
            self._state = value

    def pending_count(self) -> int:
        with self._lock:
            conn = self._conn()
            row = conn.execute("SELECT COUNT(*) FROM spool").fetchone()
            return row[0] if row else 0

    def is_backlogged(self) -> bool:
        return self.state != _SpoolState.IDLE or self.pending_count() > 0

    def _current_totals(self, conn: sqlite3.Connection) -> Tuple[int, int]:
        row = conn.execute("SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM spool").fetchone()
        return (row[0] or 0, row[1] or 0)

    # -- enqueue / overflow -------------------------------------------------------------------------

    def _make_room(self, conn: sqlite3.Connection, incoming_size: int) -> None:
        if self.overflow == "drop_newest":
            return
        while True:
            count, total_bytes = self._current_totals(conn)
            if count + 1 <= self.max_events and total_bytes + incoming_size <= self.max_bytes:
                return
            victim = conn.execute(
                "SELECT seq, event_type FROM spool WHERE event_type NOT IN ('llm.usage', 'llm.failed') "
                "ORDER BY seq ASC LIMIT 1"
            ).fetchone()
            if victim is None:
                victim = conn.execute("SELECT seq, event_type FROM spool ORDER BY seq ASC LIMIT 1").fetchone()
            if victim is None:
                return
            seq, evicted_type = victim
            conn.execute("DELETE FROM spool WHERE seq = ?", (seq,))
            deltas = {"dropped_overflow_total": 1}
            if evicted_type in _SPOOL_USAGE_TYPES:
                deltas["dropped_overflow_usage_total"] = 1
            self._incr_counters_in_txn(conn, deltas)

    def enqueue(self, event: Dict[str, Any], serialized: str) -> str:
        """Returns ``"queued"``, ``"duplicate_noop"``, ``"refused_oversized"`` or ``"write_error"``. Never
        raises."""
        event_id = event["id"]
        event_type = event["type"]
        size_bytes = len(serialized.encode("utf-8"))
        with self._lock:
            conn = self._conn()
            try:
                existing = conn.execute("SELECT 1 FROM spool WHERE event_id = ?", (event_id,)).fetchone()
                if existing:
                    return "duplicate_noop"

                conn.execute("BEGIN IMMEDIATE")
                try:
                    if size_bytes > self.max_bytes:
                        deltas = {"dropped_overflow_total": 1}
                        if event_type in _SPOOL_USAGE_TYPES:
                            deltas["dropped_overflow_usage_total"] = 1
                        self._incr_counters_in_txn(conn, deltas)
                        conn.execute("COMMIT")
                        return "refused_oversized"

                    self._make_room(conn, size_bytes)
                    count, total_bytes = self._current_totals(conn)
                    if count + 1 > self.max_events or total_bytes + size_bytes > self.max_bytes:
                        deltas = {"dropped_overflow_total": 1}
                        if event_type in _SPOOL_USAGE_TYPES:
                            deltas["dropped_overflow_usage_total"] = 1
                        self._incr_counters_in_txn(conn, deltas)
                        conn.execute("COMMIT")
                        return "refused_oversized"

                    now_ms = int(time.time() * 1000)
                    conn.execute(
                        "INSERT INTO spool(event_id, event_type, size_bytes, enqueued_at, attempts, event_json) "
                        "VALUES (?, ?, ?, ?, 0, ?)",
                        (event_id, event_type, size_bytes, now_ms, serialized),
                    )
                    self._incr_counters_in_txn(conn, {"enqueued_total": 1})
                    conn.execute("COMMIT")
                except Exception:
                    try:
                        conn.execute("ROLLBACK")
                    except Exception:
                        pass
                    raise
            except sqlite3.DatabaseError as err:
                logger.error("Agent Viewer: spool write failed (%s); event dropped and counted.", err)
                try:
                    deltas = {"dropped_spool_error_total": 1}
                    if event_type in _SPOOL_USAGE_TYPES:
                        deltas["dropped_spool_error_usage_total"] = 1
                    self._incr_counters_in_txn(conn, deltas)
                except Exception:
                    pass
                return "write_error"
        self.set_state(_SpoolState.SERVER_DOWN)
        return "queued"

    # -- drain support --------------------------------------------------------------------------------

    def peek_batch(self, limit: int) -> List[Tuple[int, str, str, str]]:
        with self._lock:
            conn = self._conn()
            rows = conn.execute(
                "SELECT seq, event_id, event_type, event_json FROM spool ORDER BY seq ASC LIMIT ?",
                (limit,),
            ).fetchall()
            return list(rows)

    def delete_seqs(self, seqs: Sequence[int]) -> None:
        if not seqs:
            return
        with self._lock:
            conn = self._conn()
            conn.executemany("DELETE FROM spool WHERE seq = ?", [(s,) for s in seqs])

    def move_to_rejected(self, row: Tuple[int, str, str, str], status_code: Optional[int], reason: str) -> None:
        seq, event_id, event_type, event_json = row
        with self._lock:
            conn = self._conn()
            conn.execute("BEGIN")
            try:
                conn.execute("DELETE FROM spool WHERE seq = ?", (seq,))
                conn.execute(
                    "INSERT OR REPLACE INTO rejected(seq, event_id, event_type, rejected_at, status_code, reason, event_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (seq, event_id, event_type, int(time.time() * 1000), status_code, reason, event_json),
                )
                deltas = {"rejected_total": 1}
                if event_type in _SPOOL_USAGE_TYPES:
                    deltas["rejected_usage_total"] = 1
                self._incr_counters_in_txn(conn, deltas)
                total = conn.execute("SELECT COUNT(*) FROM rejected").fetchone()[0]
                overflow = total - _SPOOL_DEAD_LETTER_CAP
                if overflow > 0:
                    victims = conn.execute(
                        "SELECT seq FROM rejected ORDER BY seq ASC LIMIT ?", (overflow,)
                    ).fetchall()
                    for (vseq,) in victims:
                        conn.execute("DELETE FROM rejected WHERE seq = ?", (vseq,))
                    self._incr_counters_in_txn(conn, {"rejected_evicted_total": overflow})
                conn.execute("COMMIT")
            except Exception:
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    pass
                raise

    def rejected(self, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._conn()
            rows = conn.execute(
                "SELECT seq, event_id, event_type, rejected_at, status_code, reason, event_json "
                "FROM rejected ORDER BY seq DESC LIMIT ?",
                (limit,),
            ).fetchall()
        result = []
        for seq, event_id, event_type, rejected_at, status_code, reason, event_json in rows:
            try:
                parsed = json.loads(event_json)
            except Exception:
                parsed = None
            result.append(
                {
                    "seq": seq,
                    "event_id": event_id,
                    "event_type": event_type,
                    "rejected_at": rejected_at,
                    "status_code": status_code,
                    "reason": reason,
                    "event_json": parsed,
                }
            )
        return result

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            conn = self._conn()
            count, total_bytes = self._current_totals(conn)
            oldest_row = conn.execute("SELECT enqueued_at FROM spool ORDER BY seq ASC LIMIT 1").fetchone()
            oldest_age = None if oldest_row is None else max(0.0, (time.time() * 1000 - oldest_row[0]) / 1000.0)
            counters = {name: int(self._get_meta(conn, f"counter:{name}") or "0") for name in _SPOOL_COUNTER_NAMES}
            last_error = self._get_meta(conn, "last_error")
            last_success_at = self._get_meta(conn, "last_success_at")
            state = self._state
        return {
            "state": state,
            "pending_events": count,
            "pending_bytes": total_bytes,
            "oldest_pending_age_s": oldest_age,
            "last_error": last_error,
            "last_success_at": int(last_success_at) if last_success_at is not None else None,
            **counters,
        }


class AgentHandle:
    """Convenience handle for interacting with an individual agent in Agent Viewer."""

    def __init__(
        self,
        viewer: "AgentViewer",
        agent_id: str,
        name: Optional[str] = None,
        role_title: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        workspace: Optional[str] = None,
    ) -> None:
        self.viewer = viewer
        self.id = agent_id
        self.name = name or agent_id
        self.role_title = role_title or "AI Agent"
        self.provider = provider or "Custom"
        self.model = model or "Custom"
        self.workspace = workspace or "development"
        self._registered = False

    def _ensure_registered(self) -> None:
        if not self._registered and self.viewer.auto_register:
            try:
                self.viewer.emit(
                    "agent.registered",
                    f"Registered {self.name}",
                    {
                        "id": self.id,
                        "name": self.name,
                        "roleTitle": self.role_title,
                        "provider": self.provider,
                        "model": self.model,
                        "workspace": self.workspace,
                    },
                    agent_id=self.id,
                    source=f"agent:{self.id}",
                )
                self._registered = True
            except Exception as err:
                if self.viewer.debug:
                    logger.warning("Auto-registration warning for agent %s: %s", self.id, err)

    def status(self, status: str, status_text: Optional[str] = None, workspace: Optional[str] = None) -> None:
        """Update agent status."""
        self._ensure_registered()
        payload: Dict[str, Any] = {"status": status.upper()}
        if status_text:
            payload["statusText"] = status_text
        if workspace or self.workspace:
            payload["workspace"] = workspace or self.workspace

        self.viewer.emit(
            "agent.status.changed",
            status_text or f"{self.id} -> {status}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def idle(self, summary: str = "Idle and awaiting tasks") -> None:
        """Set agent to idle state."""
        self.status("IDLE", status_text=summary)

    def thinking(self, summary: str = "Thinking and processing") -> None:
        """Set agent to thinking state."""
        self.status("THINKING", status_text=summary)

    def researching(self, summary: str = "Researching information") -> None:
        """Set agent to researching state."""
        self.status("RESEARCHING", status_text=summary, workspace="research_area")

    def coding(self, summary: str = "Writing code") -> None:
        """Set agent to coding state."""
        self.status("CODING", status_text=summary, workspace="development")

    def testing(self, summary: str = "Running test suite") -> None:
        """Set agent to testing state."""
        self.status("TESTING", status_text=summary, workspace="qa_lab")

    def waiting(self, summary: str = "Waiting for dependencies") -> None:
        """Set agent to waiting state."""
        self.status("WAITING", status_text=summary)

    def blocked(self, reason: str = "Execution blocked") -> None:
        """Set agent to blocked state."""
        self.status("BLOCKED", status_text=reason)

    def done(self, summary: str = "Task completed successfully") -> None:
        """Set agent to done state."""
        self.status("DONE", status_text=summary)

    def message(self, text: str, target_agent_name: Optional[str] = None) -> None:
        """Display an observable speech bubble for the agent."""
        self._ensure_registered()
        payload = {"text": text}
        if target_agent_name is not None:
            payload["targetAgentName"] = target_agent_name
        self.viewer.emit(
            "agent.message.sent",
            f"{self.name}: {text[:60]}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def tool_started(
        self, tool: str, input_summary: Optional[str] = None, *, tool_call_id: Optional[str] = None
    ) -> None:
        """Report tool call start."""
        self._ensure_registered()
        payload = {"tool": tool}
        if input_summary is not None:
            payload["inputSummary"] = input_summary
        if tool_call_id is not None:
            payload["toolCallId"] = tool_call_id
        self.viewer.emit(
            "tool.started",
            f"Started {tool}: {input_summary}" if input_summary else f"Started tool {tool}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def tool_completed(
        self,
        tool: str,
        output_summary: Optional[str] = None,
        *,
        tool_call_id: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        """Report tool call completion.

        ``duration_ms`` is accepted here and on ``tool_failed`` (the contract's
        ``ToolCompletedPayloadSchema``/``ToolFailedPayloadSchema``), not on ``tool_started``, which has no
        end time yet. The caller measures it with a monotonic clock; the SDK never times a call itself.
        """
        self._ensure_registered()
        payload = {"tool": tool}
        if output_summary is not None:
            payload["outputSummary"] = output_summary
        if tool_call_id is not None:
            payload["toolCallId"] = tool_call_id
        if duration_ms is not None:
            payload["durationMs"] = duration_ms
        self.viewer.emit(
            "tool.completed",
            f"Completed {tool}: {output_summary}" if output_summary else f"Completed tool {tool}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def tool_failed(
        self,
        tool: str,
        error_summary: Optional[str] = None,
        *,
        tool_call_id: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        """Report tool call failure. See ``tool_completed`` for ``duration_ms``."""
        self._ensure_registered()
        payload = {"tool": tool, "error": error_summary}
        if tool_call_id is not None:
            payload["toolCallId"] = tool_call_id
        if duration_ms is not None:
            payload["durationMs"] = duration_ms
        self.viewer.emit(
            "tool.failed",
            f"Failed {tool}: {error_summary}" if error_summary else f"Failed tool {tool}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def usage(
        self,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: Optional[int] = None,
        reasoning_tokens: Optional[int] = None,
        cost: Optional[float] = None,
        cost_source: Optional[str] = None,
        latency_ms: Optional[int] = None,
        request_id: Optional[str] = None,
        *,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        currency: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        meeting_id: Optional[str] = None,
        user_id: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> None:
        """Report the token and cost usage of one model call, exactly as the caller knows it.

        A figure that is not given stays unknown: it is left out of the payload, never sent as 0.
        ``cost_source`` is never inferred. A cost given without it is sent as ``"unknown"`` and
        the client logs one warning. ``task_id`` goes to the envelope ``taskId``. ``trace_id``,
        ``parent_id``, ``tool_call_id``, ``meeting_id``, ``user_id`` and ``tags`` (issue #64) are validated
        locally with the same limits as the server and raise ``ValueError`` (or ``TypeError`` for a wrong
        type) naming the argument before anything is sent.
        """
        if cost_source is not None and cost_source not in COST_SOURCES:
            raise ValueError(
                f'costSource must be one of {", ".join(COST_SOURCES)} (got "{cost_source}")'
            )
        _validate_usage_correlation(trace_id, parent_id, tool_call_id, meeting_id, user_id, tags)
        if cost is not None and cost_source is None:
            self.viewer._warn_unstated_cost_source()
        self._ensure_registered()
        payload = {
            "provider": provider,
            "model": model,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "cachedTokens": cached_tokens,
            "cacheReadTokens": cache_read_tokens,
            "cacheWriteTokens": cache_write_tokens,
            "reasoningTokens": reasoning_tokens,
            "cost": cost,
            "costSource": cost_source if cost_source is not None else "unknown",
            "currency": currency,
            "latencyMs": latency_ms,
            "requestId": request_id,
        }
        payload.update(_correlation_payload(trace_id, parent_id, tool_call_id, meeting_id, user_id, tags))
        self.viewer.emit(
            "llm.usage",
            f"{provider}/{model} tokens ({input_tokens}+{output_tokens})",
            {k: v for k, v in payload.items() if v is not None},
            agent_id=self.id,
            source=f"agent:{self.id}",
            task_id=task_id,
        )

    def llm_failed(
        self,
        provider: str,
        model: Optional[str] = None,
        error_kind: Optional[str] = None,
        *,
        http_status: Optional[int] = None,
        retryable: Optional[bool] = None,
        request_id: Optional[str] = None,
        provider_error_code: Optional[str] = None,
        attempts: Optional[int] = None,
        latency_ms: Optional[int] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        reasoning_tokens: Optional[int] = None,
        cost: Optional[float] = None,
        cost_source: Optional[str] = None,
        currency: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        meeting_id: Optional[str] = None,
        user_id: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> None:
        """Report one failed model call attempt (issue #64). A figure that is not given stays unknown and
        is left out, never sent as 0. There is no free-text error field on purpose: provider messages can
        echo prompts or credentials. A retry that succeeds is reported as a separate ``usage()`` call.
        """
        if cost_source is not None and cost_source not in COST_SOURCES:
            raise ValueError(
                f'costSource must be one of {", ".join(COST_SOURCES)} (got "{cost_source}")'
            )
        _validate_usage_correlation(trace_id, parent_id, tool_call_id, meeting_id, user_id, tags)
        if cost is not None and cost_source is None:
            self.viewer._warn_unstated_cost_source()
        self._ensure_registered()
        payload = {
            "provider": provider,
            "model": model,
            "errorKind": error_kind,
            "httpStatus": http_status,
            "retryable": retryable,
            "requestId": request_id,
            "providerErrorCode": provider_error_code,
            "attempts": attempts,
            "latencyMs": latency_ms,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "cacheReadTokens": cache_read_tokens,
            "cacheWriteTokens": cache_write_tokens,
            "reasoningTokens": reasoning_tokens,
            "cost": cost,
            "costSource": cost_source if cost_source is not None else "unknown",
            "currency": currency,
        }
        payload.update(_correlation_payload(trace_id, parent_id, tool_call_id, meeting_id, user_id, tags))
        summary = f"{provider}/{model} call failed" if model else f"{provider} call failed"
        self.viewer.emit(
            "llm.failed",
            summary,
            {k: v for k, v in payload.items() if v is not None},
            agent_id=self.id,
            source=f"agent:{self.id}",
            task_id=task_id,
            severity="high",
        )


class AgentViewer:
    """Client for connecting any agent framework to Agent Viewer."""

    def __init__(
        self,
        url: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        token: Optional[str] = None,
        runtime_id: Optional[str] = None,
        session_id: Optional[str] = None,
        source: Optional[str] = None,
        timeout: float = 10.0,
        max_retries: int = 3,
        auto_register: bool = True,
        debug: bool = False,
        spool_dir: Optional[str] = None,
        spool_max_events: int = 10_000,
        spool_max_bytes: int = 50 * 1024 * 1024,
        spool_overflow: str = "drop_oldest",
        spool_batch_size: int = 50,
        spool_background: bool = True,
        spool_probe_interval: float = 2.0,
        spool_max_probe_interval: float = 60.0,
    ) -> None:
        target_url = url or base_url or "http://localhost:8787"
        self.url = target_url.rstrip("/")
        self.token = api_key or token
        self.runtime_id = runtime_id
        self.session_id = session_id
        self.source = source or (f"runtime:{runtime_id}" if runtime_id else "external-runtime")
        self.timeout = timeout
        self.max_retries = max_retries
        self.auto_register = auto_register
        self.debug = debug
        self._agents: Dict[str, AgentHandle] = {}
        self._warned_unstated_cost_source = False

        # Durable local queue / spool (issue #101). See docs/sdk-queue.md for the full contract.
        if spool_max_events < 1:
            raise ValueError("spool_max_events must be >= 1")
        if spool_max_bytes < 1:
            raise ValueError("spool_max_bytes must be >= 1")
        if spool_overflow not in _SPOOL_OVERFLOW_POLICIES:
            raise ValueError(
                f'spool_overflow must be one of {", ".join(_SPOOL_OVERFLOW_POLICIES)} (got "{spool_overflow}")'
            )
        if not (1 <= spool_batch_size <= 100):
            raise ValueError("spool_batch_size must be between 1 and 100")

        self.spool_background = spool_background
        self.spool_batch_size = spool_batch_size
        self.spool_probe_interval = spool_probe_interval
        self.spool_max_probe_interval = spool_max_probe_interval
        self._spool_chunk_size = spool_batch_size
        self._spool_backoff = spool_probe_interval
        self._drain_lock = threading.Lock()
        self._drain_thread: Optional[threading.Thread] = None
        self._drain_thread_pid: Optional[int] = None
        self._drain_stop_event = threading.Event()
        self._closed = False

        effective_spool_dir = spool_dir if spool_dir is not None else (os.environ.get("AGENT_VIEWER_SPOOL_DIR") or None)
        self._spool: Optional[_Spool] = None
        if effective_spool_dir:
            try:
                candidate = _Spool(
                    effective_spool_dir, self.url, self.runtime_id, spool_max_events, spool_max_bytes, spool_overflow
                )
                self._spool = None if candidate.disabled else candidate
            except Exception as err:  # noqa: BLE001 - the spool must never fail construction of the client
                logger.error(
                    "Agent Viewer: failed to initialize spool at %s (%s). Spool disabled for this run.",
                    effective_spool_dir, err,
                )
                self._spool = None
            if self._spool is not None:
                atexit.register(self._atexit_close)
                if hasattr(os, "register_at_fork"):
                    try:
                        os.register_at_fork(after_in_child=self._after_fork)
                    except Exception:  # noqa: BLE001 - best effort only
                        pass

    def _warn_unstated_cost_source(self) -> None:
        """Log, once per client, that a cost was sent without a stated source."""
        if not self._warned_unstated_cost_source:
            self._warned_unstated_cost_source = True
            logger.warning(_UNSTATED_COST_SOURCE_WARNING)

    def agent(
        self,
        id: str,
        name: Optional[str] = None,
        role_title: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        workspace: Optional[str] = None,
    ) -> AgentHandle:
        """Get or initialize an agent handle."""
        if id in self._agents:
            return self._agents[id]
        handle = AgentHandle(
            viewer=self,
            agent_id=id,
            name=name,
            role_title=role_title,
            provider=provider,
            model=model,
            workspace=workspace,
        )
        self._agents[id] = handle
        return handle

    def emit(
        self,
        event_type: str,
        summary: str,
        payload: Dict[str, Any],
        *,
        agent_id: Optional[str] = None,
        source: Optional[str] = None,
        target: Optional[str] = None,
        task_id: Optional[str] = None,
        session_id: Optional[str] = None,
        timestamp_ms: Optional[int] = None,
        severity: str = "normal",
        event_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Emit a single canonical event to the Agent Viewer API.

        ``session_id`` overrides the client's own ``session_id`` for this one event, and
        ``timestamp_ms`` overrides the wall-clock send time. Both exist for a long-lived process that
        serves many sessions through one client (for example a LangGraph app with one handler per
        ``thread_id``, issue #99) and that must record the time a callback fired, not the time it was
        sent through a background queue. ``emit_batch()`` already accepts both per event; this brings
        ``emit()`` to parity.
        """
        raw_event = {
            "schemaVersion": "1.0",
            "id": event_id or _default_event_id(),
            "type": event_type,
            "timestamp": timestamp_ms if timestamp_ms is not None else int(time.time() * 1000),
            "runtimeId": self.runtime_id,
            "sessionId": session_id if session_id is not None else self.session_id,
            "source": source or self.source,
            "target": target,
            "taskId": task_id,
            "agentId": agent_id,
            "severity": severity,
            "summary": summary,
            "payload": {k: v for k, v in payload.items() if v is not None} if isinstance(payload, dict) else payload,
        }
        event = {k: v for k, v in raw_event.items() if v is not None}
        if self._spool is not None:
            if self._spool.is_backlogged():
                return self._spool_queue_single(event)
            try:
                return self._post_with_retry("/api/v1/events", event, idempotency_key=event["id"])
            except AgentViewerError as err:
                if err.transient:
                    return self._spool_queue_single(event)
                raise
        return self._post_with_retry("/api/v1/events", event, idempotency_key=event["id"])

    def emit_batch(self, events: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Emit a batch of canonical events.

        Returns the server response. The server answers 202 even when some items were not applied, so
        read ``conflicts`` and each item's ``status`` in ``results``: ``"conflict"`` means the id was
        already stored with different content (``error == "conflicting_duplicate"``) and the item was dropped.

        With a spool enabled (issue #101) and the server unreachable, each normalized event is queued
        individually (keeping its own id, in list order) and the return value is
        ``{"accepted": False, "queued": True, "total": N, "ids": [...]}`` instead.
        """
        normalized_events = []
        for raw in events:
            evt = {
                "schemaVersion": "1.0",
                "id": raw.get("id") or _default_event_id(),
                "type": raw["type"],
                "timestamp": raw.get("timestamp") or int(time.time() * 1000),
                "runtimeId": raw.get("runtimeId") or self.runtime_id,
                "sessionId": raw.get("sessionId") or self.session_id,
                "source": raw.get("source") or self.source,
                "agentId": raw.get("agentId"),
                "taskId": raw.get("taskId"),
                "severity": raw.get("severity", "normal"),
                "summary": raw.get("summary", f"{raw['type']} event"),
                "payload": raw.get("payload", {}),
            }
            normalized_events.append(evt)
        if self._spool is not None:
            if self._spool.is_backlogged():
                return self._spool_queue_batch(normalized_events)
            try:
                return self._post_with_retry("/api/v1/events/batch", {"events": normalized_events})
            except AgentViewerError as err:
                if err.transient:
                    return self._spool_queue_batch(normalized_events)
                raise
        return self._post_with_retry("/api/v1/events/batch", {"events": normalized_events})

    # -- spool: queueing, draining, flush/close/stats (issue #101) -------------------------------------

    def _spool_queue_single(self, event: Dict[str, Any]) -> Dict[str, Any]:
        serialized = json.dumps(event)
        outcome = self._spool.enqueue(event, serialized)
        self._ensure_drain_thread()
        if outcome in ("refused_oversized", "write_error"):
            return {"accepted": False, "queued": False, "dropped": True, "id": event["id"]}
        return {"accepted": False, "queued": True, "duplicate": False, "id": event["id"]}

    def _spool_queue_batch(self, events: List[Dict[str, Any]]) -> Dict[str, Any]:
        ids = []
        for event in events:
            result = self._spool_queue_single(event)
            if result.get("queued"):
                ids.append(result["id"])
        return {"accepted": False, "queued": True, "total": len(events), "ids": ids}

    def _ensure_drain_thread(self) -> None:
        if self._spool is None or not self.spool_background:
            return
        pid = os.getpid()
        if self._drain_thread is not None and self._drain_thread.is_alive() and self._drain_thread_pid == pid:
            return
        self._drain_thread_pid = pid
        self._drain_stop_event = threading.Event()
        thread = threading.Thread(target=self._drain_background_loop, daemon=True, name="agent-viewer-spool-drain")
        self._drain_thread = thread
        thread.start()

    def _after_fork(self) -> None:
        self._drain_thread = None
        self._drain_thread_pid = None
        self._drain_stop_event = threading.Event()

    def _atexit_close(self) -> None:
        try:
            self.close(timeout=5.0)
        except Exception:  # noqa: BLE001 - atexit handlers must never raise
            pass

    def close(self, timeout: float = 5.0) -> None:
        """Final bounded flush attempt, then stop the background drainer. Safe to call more than once and
        usable as a context manager (``with AgentViewer(...) as viewer:``). With the spool disabled this is
        a no-op."""
        if self._spool is None:
            self._closed = True
            return
        if self._closed:
            return
        self._closed = True
        try:
            self.flush(timeout=timeout)
        except Exception:  # noqa: BLE001 - close() never raises
            pass
        self._drain_stop_event.set()
        if self._drain_thread is not None:
            self._drain_thread.join(timeout=min(1.0, timeout))

    def __enter__(self) -> "AgentViewer":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self.close()
        return False

    def flush(self, timeout: float = 30.0) -> FlushResult:
        """Drains the spool now, blocking up to ``timeout`` seconds. Never raises on a transient error.
        With the spool disabled, returns all zeros with ``state="disabled"``."""
        if self._spool is None:
            return FlushResult(delivered=0, remaining=0, rejected=0, timed_out=False, state=_SpoolState.DISABLED)
        self._ensure_drain_thread()
        deadline = time.monotonic() + max(0.0, timeout)
        result = self._drain_session(deadline, force_auth_retry=True)
        return FlushResult(
            delivered=result["delivered"],
            remaining=self._spool.pending_count(),
            rejected=result["rejected"],
            timed_out=result["timed_out"],
            state=self._spool.state,
        )

    def spool_stats(self) -> SpoolStats:
        """Snapshot of the spool's counters and backlog (issue #101). With the spool disabled, every
        counter is ``0`` and ``state`` is ``"disabled"``."""
        if self._spool is None:
            return SpoolStats(state=_SpoolState.DISABLED)
        return SpoolStats(**self._spool.stats())

    def spool_rejected(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Dead-letter rows (newest first): events the server rejected outright during replay (issue
        #101). Each row's ``event_json`` is parsed back into a ``dict``. Empty when the spool is disabled."""
        if self._spool is None:
            return []
        return self._spool.rejected(limit)

    def _drain_background_loop(self) -> None:
        while not self._drain_stop_event.is_set():
            if self._spool is None or self._spool.disabled:
                return
            if self._spool.state == _SpoolState.IDLE and self._spool.pending_count() == 0:
                self._drain_stop_event.wait(timeout=5.0)
                continue
            self._drain_session(deadline=None, force_auth_retry=False)
            self._drain_stop_event.wait(timeout=0.05)

    def _reset_backoff(self) -> None:
        self._spool_backoff = self.spool_probe_interval

    def _next_backoff(self) -> float:
        current = self._spool_backoff
        sleep_for = current + current * random.uniform(0, 0.2)
        self._spool_backoff = min(current * 2, self.spool_max_probe_interval)
        return sleep_for

    def _drain_session(self, deadline: Optional[float], force_auth_retry: bool) -> Dict[str, Any]:
        """Runs drain passes until the spool is empty, a stop condition is reached (auth failure, or a
        backoff wait that would exceed ``deadline``), or ``deadline`` elapses. ``deadline`` is a
        ``time.monotonic()`` timestamp, or ``None`` to run until idle/stopped with no time bound (the
        background thread's own call). Never raises. Only one drain session runs at a time per process
        (``self._drain_lock``): a concurrent call (for example ``flush()`` while the background drainer is
        already mid-pass) blocks for the acquisition too, bounded by ``deadline`` when one is given, so
        ``flush()`` genuinely waits for and contributes to the in-flight work instead of silently no-op'ing."""
        if deadline is None:
            acquired = self._drain_lock.acquire()
        else:
            acquired = self._drain_lock.acquire(timeout=max(0.0, deadline - time.monotonic()))
        if not acquired:
            return {"delivered": 0, "rejected": 0, "timed_out": True}
        try:
            delivered_total = 0
            rejected_total = 0
            while True:
                if deadline is not None and time.monotonic() >= deadline:
                    return {"delivered": delivered_total, "rejected": rejected_total, "timed_out": True}
                if self._spool.state == _SpoolState.AUTH_FAILED and not self._spool.auth_retry_due(
                    self.spool_max_probe_interval, force=force_auth_retry
                ):
                    return {"delivered": delivered_total, "rejected": rejected_total, "timed_out": False}

                batch = self._spool.peek_batch(self._spool_chunk_size)
                if not batch:
                    self._spool.set_state(_SpoolState.IDLE)
                    return {"delivered": delivered_total, "rejected": rejected_total, "timed_out": False}

                self._spool.set_state(_SpoolState.DRAINING)
                outcome = self._send_and_resolve(batch)

                if outcome["duplicates"]:
                    self._spool.incr_counter("duplicates_acked_total", outcome["duplicates"])
                if outcome["delivered"]:
                    self._spool.incr_counter("replayed_total", outcome["delivered"])
                if outcome["delivered"] or outcome["duplicates"]:
                    self._spool.set_meta_last_success()
                    self._reset_backoff()
                delivered_total += outcome["delivered"] + outcome["duplicates"]
                rejected_total += outcome["rejected"]

                if outcome["stop"] == "auth_failed":
                    self._spool.set_state(_SpoolState.AUTH_FAILED)
                    self._spool.mark_auth_failed_now()
                    logger.warning(
                        "Agent Viewer: spool drain stopped, the server rejected the token (401/403). "
                        "Every queued event is kept; call flush() after fixing the token."
                    )
                    return {"delivered": delivered_total, "rejected": rejected_total, "timed_out": False}

                if outcome["stop"] == "backoff":
                    self._spool.set_state(_SpoolState.SERVER_DOWN)
                    if outcome.get("error"):
                        self._spool.set_last_error(outcome["error"])
                    if outcome["backoff_seconds"] is not None:
                        sleep_for = min(outcome["backoff_seconds"], self.spool_max_probe_interval)
                        self._reset_backoff()
                    else:
                        sleep_for = self._next_backoff()
                    if deadline is not None:
                        remaining = max(0.0, deadline - time.monotonic())
                        sleep_for = min(sleep_for, remaining)
                        if sleep_for <= 0:
                            return {"delivered": delivered_total, "rejected": rejected_total, "timed_out": True}
                    self._drain_stop_event.wait(sleep_for)
                    continue

                # Delivered (fully or partially) with the rest rejected: loop immediately for the next chunk.
                continue
        finally:
            self._drain_lock.release()

    def _raw_batch_request(self, body_str: str) -> Tuple[int, Dict[str, Any], Dict[str, str]]:
        """One no-retry drain request (issue #101): a probe after an outage never blocks the host for the
        full retry budget, only for ``min(timeout, 2.0)`` seconds. Raises :class:`_TransientNetworkError`
        on any network-level failure; never raises for an HTTP error response."""
        data = body_str.encode("utf-8")
        headers = self._build_headers()
        req = urllib.request.Request(f"{self.url}/api/v1/events/batch", data=data, headers=headers, method="POST")
        request_timeout = min(self.timeout, 2.0)
        try:
            with urllib.request.urlopen(req, timeout=request_timeout) as resp:
                resp_bytes = resp.read()
                parsed = json.loads(resp_bytes.decode("utf-8")) if resp_bytes else {}
                return resp.status, parsed, dict(resp.headers.items())
        except urllib.error.HTTPError as err:
            body_bytes = err.read()
            try:
                parsed = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            except Exception:
                parsed = {}
            response_headers = dict(err.headers.items()) if err.headers else {}
            return err.code, parsed, response_headers
        except (urllib.error.URLError, http.client.HTTPException, OSError) as err:
            raise _TransientNetworkError(str(err)) from err

    def _send_and_resolve(self, rows: List[Tuple[int, str, str, str]]) -> Dict[str, Any]:
        """Sends ``rows`` (``(seq, event_id, event_type, event_json)``) as one batch request and resolves
        the outcome against ``docs/sdk-queue.md``'s drain response table. Never raises. Returns
        ``{"delivered", "duplicates", "rejected", "stop": None|"backoff"|"auth_failed", "backoff_seconds",
        "error"}``.

        A ``413`` or an index-less ``400`` only shrinks ``self._spool_chunk_size`` and returns with nothing
        resolved yet (``stop: None``): bisection is lazy, driven by :meth:`_drain_session`'s own loop
        re-``peek_batch``-ing a smaller chunk off the same, untouched backlog on its very next iteration,
        rather than this method eagerly resending sub-chunks itself. An indexed ``400`` resolves the listed
        rows immediately (an unambiguous, final rejection) and leaves the rest of the chunk in the spool for
        that same next iteration.
        """
        empty = {"delivered": 0, "duplicates": 0, "rejected": 0, "stop": None, "backoff_seconds": None}
        if not rows:
            return dict(empty)

        body = '{"events":[' + ",".join(r[3] for r in rows) + "]}"
        try:
            status, parsed, headers = self._raw_batch_request(body)
        except _TransientNetworkError as err:
            return {**empty, "stop": "backoff", "error": str(err)}

        if status in (200, 202):
            results = parsed.get("results") or []
            delivered = 0
            duplicates = 0
            acked_seqs = []
            for row, result in zip(rows, results):
                acked_seqs.append(row[0])
                if isinstance(result, dict) and result.get("duplicate"):
                    duplicates += 1
                else:
                    delivered += 1
            self._spool.delete_seqs(acked_seqs)
            return {**empty, "delivered": delivered, "duplicates": duplicates}

        if status == 413:
            if len(rows) == 1:
                self._spool.move_to_rejected(rows[0], status, "HTTP 413: event exceeds the server's body size limit")
                return {**empty, "rejected": 1}
            self._spool_chunk_size = max(1, len(rows) // 2)
            return dict(empty)

        if status == 400:
            errors = parsed.get("errors") if isinstance(parsed, dict) else None
            if isinstance(errors, list) and errors and all(
                isinstance(e, dict) and isinstance(e.get("index"), int) for e in errors
            ):
                bad_indexes = {e["index"] for e in errors}
                rejected = 0
                for idx, row in enumerate(rows):
                    if idx in bad_indexes:
                        self._spool.move_to_rejected(row, 400, _format_validation_issue_text(errors, idx))
                        rejected += 1
                return {**empty, "rejected": rejected}

            message = parsed.get("message") if isinstance(parsed, dict) else None
            if len(rows) == 1:
                self._spool.move_to_rejected(rows[0], 400, message or "validation_failed")
                return {**empty, "rejected": 1}
            self._spool_chunk_size = max(1, len(rows) // 2)
            return dict(empty)

        if status in (401, 403):
            return {**empty, "stop": "auth_failed"}

        if status == 429:
            retry_after = _parse_retry_after_seconds(headers)
            return {**empty, "stop": "backoff", "backoff_seconds": retry_after}

        if status == 408 or 500 <= status < 600:
            return {**empty, "stop": "backoff"}

        logger.warning("Agent Viewer: spool drain got an unexpected status %s; keeping the backlog and backing off.", status)
        return {**empty, "stop": "backoff"}

    def heartbeat(self, active_agents_count: Optional[int] = None) -> None:
        """Send a runtime heartbeat event."""
        self.emit(
            "runtime.heartbeat",
            f"Heartbeat from {self.runtime_id or 'runtime'}",
            {
                "runtimeId": self.runtime_id,
                "status": "healthy",
                "activeAgentsCount": active_agents_count or len(self._agents),
            },
        )

    def health(self) -> Dict[str, Any]:
        """Check server health."""
        req = urllib.request.Request(f"{self.url}/health", headers=self._build_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def snapshot(self) -> Dict[str, Any]:
        """Fetch current snapshot from the server."""
        req = urllib.request.Request(f"{self.url}/api/v1/snapshot", headers=self._build_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def budgets(self, state: Optional[str] = None) -> Dict[str, Any]:
        """Fetch budgets from ``GET /api/v1/budgets`` (issue #85).

        Each budget comes back with a ``status`` evaluated fresh against the usage ledger: ``ok``,
        ``warning``, ``exceeded`` or ``unknown`` (never a guess when the figure is incomplete). A disabled
        budget's ``status`` is ``None``. Pass ``state`` to filter to one of the four states server side; the
        server answers ``400`` for anything else. Read only: there is no helper here to create, update or
        delete a budget, since that is an operator action, not something an agent should be able to do to
        itself.
        """
        endpoint = f"{self.url}/api/v1/budgets"
        if state is not None:
            endpoint += f"?{urllib.parse.urlencode({'state': state})}"
        req = urllib.request.Request(endpoint, headers=self._build_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def whoami(self) -> Dict[str, Any]:
        """Fetch the authenticated identity from ``GET /api/v1/whoami`` (issue #107).

        Returns ``{"kind": "key" | "bootstrap" | "webhook" | "anonymous", "id": str, "name"?: str}``, ``name``
        present only for ``kind == "key"``. Handy as a startup check that a configured named key is still
        accepted: uses ``_get_with_retry``, which already raises immediately (never retries) on a 401, with
        ``AgentViewerError.code`` set to the server's ``key_revoked``/``key_expired`` when that is why.
        """
        return self._get_with_retry("/api/v1/whoami")

    def usage_summary(self) -> Dict[str, Any]:
        """Fetch the usage aggregates from ``GET /api/v1/usage``.

        The summary groups every ``llm.usage`` call by agent and by ``(provider, model)``, with failed calls
        (``llm.failed``) kept under ``failed``. A token ``sum`` may be ``None``: it means no call reported that
        kind, never zero; ``unreportedCount`` says how many calls left it out. Amounts are listed per currency
        and cost source in ``byCurrency`` and are never summed across them.
        """
        req = urllib.request.Request(f"{self.url}/api/v1/usage", headers=self._build_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def list_calls(
        self,
        *,
        start: Optional[Union[int, str]] = None,
        end: Optional[Union[int, str]] = None,
        time_basis: Optional[str] = None,
        agent_id: Optional[Union[str, Sequence[str]]] = None,
        session_id: Optional[Union[str, Sequence[str]]] = None,
        runtime_id: Optional[Union[str, Sequence[str]]] = None,
        task_id: Optional[Union[str, Sequence[str]]] = None,
        provider: Optional[Union[str, Sequence[str]]] = None,
        model: Optional[Union[str, Sequence[str]]] = None,
        status: Optional[Union[str, Sequence[str]]] = None,
        cost_source: Optional[Union[str, Sequence[str]]] = None,
        currency: Optional[Union[str, Sequence[str]]] = None,
        request_id: Optional[Union[str, Sequence[str]]] = None,
        trace_id: Optional[str] = None,
        order: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Fetch one page of ``GET /api/v1/usage/calls`` (issue #67): read-only, metadata-only ledger rows
        (never prompt, completion, message or error text), with a stable, opaque cursor.

        ``start``/``end`` map to the server's ``from``/``to`` query parameters (``from`` is a reserved word in
        Python); both accept epoch milliseconds or an ISO 8601 date-time with an explicit offset, sent through
        unmodified, never reformatted. Every repeatable filter accepts one value or a sequence of values, sent
        as repeated query parameters (OR within the key, AND across keys). ``cursor`` is the opaque
        ``page["nextCursor"]`` of a previous page; use :meth:`iter_calls` to follow it automatically.

        Returns the raw response body (``schemaVersion``, ``asOf``, ``storage``, ``data``, ``page``). ``None``
        values in ``data`` are never defaulted to ``0``; nothing is summed or priced here.
        """
        params: List[Tuple[str, str]] = []
        if start is not None:
            params.append(("from", str(start)))
        if end is not None:
            params.append(("to", str(end)))
        if time_basis is not None:
            params.append(("timeBasis", time_basis))
        _append_repeatable(params, "agentId", agent_id)
        _append_repeatable(params, "sessionId", session_id)
        _append_repeatable(params, "runtimeId", runtime_id)
        _append_repeatable(params, "taskId", task_id)
        _append_repeatable(params, "provider", provider)
        _append_repeatable(params, "model", model)
        _append_repeatable(params, "status", status)
        _append_repeatable(params, "costSource", cost_source)
        _append_repeatable(params, "currency", currency)
        _append_repeatable(params, "requestId", request_id)
        if trace_id is not None:
            params.append(("traceId", trace_id))
        if order is not None:
            params.append(("order", order))
        if limit is not None:
            params.append(("limit", str(limit)))
        if cursor is not None:
            params.append(("cursor", cursor))

        query = urllib.parse.urlencode(params)
        endpoint = "/api/v1/usage/calls" + (f"?{query}" if query else "")
        return self._get_with_retry(endpoint)

    def iter_calls(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        """Walks every page of :meth:`list_calls` by following ``page["nextCursor"]`` until ``hasMore`` is
        false, yielding one call record (a ``dict``) at a time. Accepts the same keyword arguments as
        :meth:`list_calls` except ``cursor``, which this method manages itself (an initial ``cursor`` may still
        be passed to resume a previous walk). Raises :class:`AgentViewerError` if the server ever returns the
        same cursor twice in a row, instead of looping forever.
        """
        cursor = kwargs.pop("cursor", None)
        while True:
            page = self.list_calls(cursor=cursor, **kwargs)
            for call in page.get("data", []):
                yield call
            page_info = page.get("page") or {}
            if not page_info.get("hasMore"):
                return
            next_cursor = page_info.get("nextCursor")
            if not next_cursor or next_cursor == cursor:
                raise AgentViewerError(
                    "Agent Viewer usage calls walk did not advance: the server returned the same cursor twice in a row."
                )
            cursor = next_cursor

    def usage_rollup(
        self,
        group_by: Union[str, Sequence[str]],
        *,
        from_: Optional[Union[int, str]] = None,
        to: Optional[Union[int, str]] = None,
        time_basis: str = "received",
        utc_offset_minutes: int = 0,
        sort: str = "key",
        limit: int = 1000,
        as_of_seq: Optional[int] = None,
        **filters: Union[str, Sequence[str]],
    ) -> Dict[str, Any]:
        """Fetch grouped sums over the usage ledger from ``GET /api/v1/usage/rollup`` (issue #66).

        ``group_by`` is a dimension name or a sequence of 1 to 3 (``agent``, ``model``, ``provider``,
        ``session``, ``task``, ``day``, ``user``, ``tag``). Filter kwargs use snake_case (``agent_id``,
        ``session_id``, ``task_id``, ``runtime_id``, ``user_id``, ``cost_source``, and ``model``, ``provider``,
        ``tag``, ``status``, ``currency``); each accepts a single string or a sequence for a repeated filter
        (same param repeated means OR). An unknown keyword argument raises ``TypeError`` instead of being sent.
        The token is always sent in the ``Authorization`` header, never in the query string. Uses the same
        ``_get_with_retry`` as :meth:`list_calls` (issue #67): raises :class:`AgentViewerError` (with
        ``status_code`` and ``issues``) immediately on 400/401/410, retries 429 and 5xx with backoff.
        """
        unknown = sorted(set(filters) - set(_ROLLUP_FILTER_QUERY_NAMES))
        if unknown:
            raise TypeError(f"usage_rollup() got unexpected keyword argument(s): {', '.join(unknown)}")

        group_by_list = [group_by] if isinstance(group_by, str) else list(group_by)
        params: List[tuple] = [("groupBy", ",".join(group_by_list))]
        if from_ is not None:
            params.append(("from", str(from_)))
        if to is not None:
            params.append(("to", str(to)))
        params.append(("timeBasis", time_basis))
        params.append(("utcOffsetMinutes", str(utc_offset_minutes)))
        params.append(("sort", sort))
        params.append(("limit", str(limit)))
        if as_of_seq is not None:
            params.append(("asOfSeq", str(as_of_seq)))
        for key, value in filters.items():
            query_name = _ROLLUP_FILTER_QUERY_NAMES[key]
            values = [value] if isinstance(value, str) else list(value)
            for item in values:
                params.append((query_name, item))

        query_string = urllib.parse.urlencode(params)
        return self._get_with_retry(f"/api/v1/usage/rollup?{query_string}")

    # Legacy method compatibility
    def register_agent(
        self,
        agent_id: str,
        name: str,
        role_title: str = "External Agent",
        provider: str = "Unknown",
        model: str = "Unknown",
    ) -> None:
        """Register an agent (legacy helper)."""
        handle = self.agent(agent_id, name=name, role_title=role_title, provider=provider, model=model)
        handle._ensure_registered()

    def agent_status(self, agent_id: str, status: str, workspace: Optional[str] = None) -> None:
        """Set agent status (legacy helper)."""
        self.agent(agent_id).status(status, workspace=workspace)

    def message(self, agent_id: str, text: str, target_agent_name: Optional[str] = None) -> None:
        """Send message (legacy helper)."""
        self.agent(agent_id).message(text, target_agent_name=target_agent_name)

    def llm_usage(
        self,
        agent_id: str,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: Optional[int] = None,
        cost: Optional[float] = None,
        cost_source: Optional[str] = None,
        latency_ms: Optional[int] = None,
        *,
        reasoning_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        request_id: Optional[str] = None,
        currency: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        meeting_id: Optional[str] = None,
        user_id: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> None:
        """Report LLM usage (legacy helper). Same rules as ``AgentHandle.usage()``."""
        self.agent(agent_id).usage(
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            reasoning_tokens=reasoning_tokens,
            cost=cost,
            cost_source=cost_source,
            latency_ms=latency_ms,
            request_id=request_id,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
            currency=currency,
            task_id=task_id,
            trace_id=trace_id,
            parent_id=parent_id,
            tool_call_id=tool_call_id,
            meeting_id=meeting_id,
            user_id=user_id,
            tags=tags,
        )

    def _build_headers(self, idempotency_key: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def _post_with_retry(
        self,
        endpoint: str,
        body: Dict[str, Any],
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        data = json.dumps(body).encode("utf-8")
        headers = self._build_headers(idempotency_key)
        url = f"{self.url}{endpoint}"

        attempt = 0
        delay = 0.3

        while attempt <= self.max_retries:
            try:
                req = urllib.request.Request(url, data=data, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    resp_bytes = resp.read()
                    return json.loads(resp_bytes.decode("utf-8")) if resp_bytes else {"ok": True}
            except urllib.error.HTTPError as err:
                error_body = err.read().decode("utf-8")
                issues = None
                code = None
                try:
                    parsed = json.loads(error_body)
                    issues = parsed.get("issues") or parsed.get("errors")
                    if isinstance(parsed.get("error"), str):
                        code = parsed["error"]
                except Exception:
                    pass

                # Client errors (4xx except 408/429) fail immediately. A 409 conflicting_duplicate is final.
                # 408 Request Timeout is retried (issue #101): the server never received or finished reading
                # the request, so it is exactly as safe to retry as a network timeout.
                if 400 <= err.code < 500 and err.code not in (408, 429):
                    raise AgentViewerError(f"Agent Viewer rejected event: {err.code} {error_body}", err.code, issues, code)

                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(
                        f"Agent Viewer request failed: {err.code} {error_body}", err.code, issues, code, transient=True
                    )

                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except urllib.error.URLError as err:
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err.reason}", transient=True)
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except http.client.HTTPException as err:
                # A connection reset or closed early while reading the response (issue #101): not wrapped
                # by urllib.error.URLError, and previously escaped as a raw exception with no retry at all.
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err}", transient=True) from err
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except OSError as err:
                # Raw socket errors (ConnectionResetError, TimeoutError, ...) raised while reading the
                # response body, outside urlopen()'s own URLError wrapping (issue #101).
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err}", transient=True) from err
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)

        raise AgentViewerError(f"Agent Viewer request failed after {self.max_retries} retries", transient=True)

    def _get_with_retry(self, endpoint: str) -> Dict[str, Any]:
        """Shared GET helper (issue #67). ``snapshot()`` and ``usage_summary()`` predate it and keep their own
        direct ``urlopen`` call with no error mapping; a failed call to either raises a raw ``urllib.error``
        instead of :class:`AgentViewerError`. Sends the token only in the ``Authorization`` header, never in the
        URL. 400, 401 and 410 fail immediately; 429 and 5xx are retried with the same backoff as
        ``_post_with_retry``, since a GET is always safe to repeat.
        """
        url = f"{self.url}{endpoint}"
        headers = self._build_headers()

        attempt = 0
        delay = 0.3

        while attempt <= self.max_retries:
            try:
                req = urllib.request.Request(url, headers=headers, method="GET")
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    resp_bytes = resp.read()
                    return json.loads(resp_bytes.decode("utf-8")) if resp_bytes else {}
            except urllib.error.HTTPError as err:
                error_body = err.read().decode("utf-8")
                issues = None
                code = None
                try:
                    parsed = json.loads(error_body)
                    issues = parsed.get("issues") or parsed.get("errors")
                    if isinstance(parsed.get("error"), str):
                        code = parsed["error"]
                except Exception:
                    pass

                # Client errors (4xx except 408/429) fail immediately: 400 invalid_filter/invalid_cursor/cursor_mismatch,
                # 401 unauthorized and 410 cursor_expired are all final, never retried. 408 is retried (issue #101).
                if 400 <= err.code < 500 and err.code not in (408, 429):
                    raise AgentViewerError(f"Agent Viewer rejected request: {err.code} {error_body}", err.code, issues, code)

                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(
                        f"Agent Viewer request failed: {err.code} {error_body}", err.code, issues, code, transient=True
                    )

                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except urllib.error.URLError as err:
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err.reason}", transient=True)
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except http.client.HTTPException as err:
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err}", transient=True) from err
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except OSError as err:
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err}", transient=True) from err
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)

        raise AgentViewerError(f"Agent Viewer request failed after {self.max_retries} retries", transient=True)


# Backward compatibility alias
AgentViewerClient = AgentViewer
