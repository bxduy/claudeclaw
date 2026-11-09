"""tg-watch core: config, persisted state and message ingest (stdlib only)."""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Source:
    name: str
    bot_id: int
    topic_id: int | None = None
    urgent: bool = False


@dataclass
class Config:
    enabled: bool
    sources: list[Source]
    deliver_chat_id: int | None = None
    poll_seconds: int = 20
    catch_up_limit: int = 100
    edit_window: int = 20
    quiet_seconds: int = 120
    urgent_quiet_seconds: int = 10
    max_wait_seconds: int = 600
    quiet_start: str = "22:00"
    quiet_end: str = "07:00"
    utc_offset_minutes: int = 420
    inject_timeout_seconds: int = 1800


_CONFIG_KEYS = {
    "deliverChatId": "deliver_chat_id",
    "pollSeconds": "poll_seconds",
    "catchUpLimit": "catch_up_limit",
    "editWindow": "edit_window",
    "quietSeconds": "quiet_seconds",
    "urgentQuietSeconds": "urgent_quiet_seconds",
    "maxWaitSeconds": "max_wait_seconds",
    "utcOffsetMinutes": "utc_offset_minutes",
    "injectTimeoutSeconds": "inject_timeout_seconds",
}


def load_config(settings_path: Path) -> Config | None:
    raw = json.loads(Path(settings_path).read_text()).get("tgWatch")
    if not isinstance(raw, dict) or raw.get("enabled") is not True:
        return None
    sources = [
        Source(name=s["name"], bot_id=s["botId"], topic_id=s.get("topicId"),
               urgent=bool(s.get("urgent", False)))
        for s in raw.get("sources", [])
    ]
    cfg = Config(enabled=True, sources=sources)
    for key, attr in _CONFIG_KEYS.items():
        if key in raw:
            setattr(cfg, attr, raw[key])
    quiet = raw.get("quietHours")
    if isinstance(quiet, dict):
        cfg.quiet_start = quiet.get("start", cfg.quiet_start)
        cfg.quiet_end = quiet.get("end", cfg.quiet_end)
    return cfg


@dataclass
class Msg:
    id: int
    date: float
    edit_date: float | None
    text: str
    buttons: list[str]
    urls: list[str]
    edited: bool = False


@dataclass
class Batch:
    messages: list[Msg]
    first_at: float
    last_at: float
    overflow: bool = False
    resent: bool = False
    attempts: int = 0
    next_attempt_at: float = 0.0


@dataclass
class SourceState:
    last_seen: int | None = None
    edit_dates: dict[int, float] = field(default_factory=dict)
    pending: Batch | None = None
    inflight: Batch | None = None


def _batch_from_dict(d: dict | None) -> Batch | None:
    if d is None:
        return None
    msgs = [Msg(**m) for m in d["messages"]]
    return Batch(**{**d, "messages": msgs})


class State:
    def __init__(self) -> None:
        self.sources: dict[int, SourceState] = {}

    @classmethod
    def load(cls, path: Path) -> "State":
        state = cls()
        path = Path(path)
        if not path.exists():
            return state
        raw = json.loads(path.read_text())
        for bot_id, s in raw.get("sources", {}).items():
            state.sources[int(bot_id)] = SourceState(
                last_seen=s.get("last_seen"),
                edit_dates={int(k): v for k, v in s.get("edit_dates", {}).items()},
                pending=_batch_from_dict(s.get("pending")),
                inflight=_batch_from_dict(s.get("inflight")),
            )
        return state

    def save(self, path: Path) -> None:
        path = Path(path)
        data = {"sources": {str(k): asdict(v) for k, v in self.sources.items()}}
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise


def ingest(st: SourceState, new: list[Msg], recent: list[Msg], now: float,
           catch_up_limit: int, edit_window: int) -> None:
    if st.last_seen is None:
        st.last_seen = max((m.id for m in new + recent), default=0)
        for m in recent:
            if m.edit_date is not None:
                st.edit_dates[m.id] = m.edit_date
        _trim_edit_dates(st, edit_window)
        return

    fresh = sorted((m for m in new if m.id > st.last_seen), key=lambda m: m.id)
    if fresh:
        batch = _ensure_pending(st, now)
        batch.messages.extend(fresh)
        batch.last_at = now
        if len(new) == catch_up_limit:
            batch.overflow = True
        st.last_seen = fresh[-1].id

    for m in recent:
        if m.edit_date is None:
            continue
        known = st.edit_dates.get(m.id)
        if known is not None and m.edit_date > known:
            _apply_edit(st, m, now)
        st.edit_dates[m.id] = m.edit_date if known is None else max(known, m.edit_date)
    _trim_edit_dates(st, edit_window)


def _ensure_pending(st: SourceState, now: float) -> Batch:
    if st.pending is None:
        st.pending = Batch(messages=[], first_at=now, last_at=now)
    return st.pending


def _apply_edit(st: SourceState, m: Msg, now: float) -> None:
    if st.pending is not None:
        for i, p in enumerate(st.pending.messages):
            if p.id == m.id:
                st.pending.messages[i] = m
                return
    batch = _ensure_pending(st, now)
    batch.messages.append(Msg(**{**asdict(m), "edited": True}))
    batch.last_at = now


def _trim_edit_dates(st: SourceState, edit_window: int) -> None:
    keep = sorted(st.edit_dates, reverse=True)[:edit_window]
    st.edit_dates = {k: st.edit_dates[k] for k in keep}
