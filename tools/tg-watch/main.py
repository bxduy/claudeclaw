"""tg-watch runtime: poll bot chats via Telethon, batch, and POST to the ClaudeClaw /api/inject."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import MessageEntityTextUrl, MessageEntityUrl

from tgwatch import (Batch, Msg, Runner, Source, State, build_prompt, inject_payload,
                     load_config, recover_inflight)

log = logging.getLogger("tg-watch")


def to_msg(m) -> Msg:
    urls: list[str] = []
    for ent, inner in m.get_entities_text():
        if isinstance(ent, MessageEntityUrl):
            urls.append(inner)
        elif isinstance(ent, MessageEntityTextUrl):
            urls.append(ent.url)
    return Msg(
        id=m.id,
        date=m.date.timestamp(),
        edit_date=m.edit_date.timestamp() if m.edit_date else None,
        text=m.message or "",
        buttons=[b.text for row in m.buttons or [] for b in row],
        urls=urls,
    )


def post_inject(url: str, token: str, payload: dict, timeout: int) -> bool:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read())
        return resp.status == 200 and body.get("ok") is True and body.get("exitCode") == 0


async def amain(args: argparse.Namespace) -> int:
    claw = Path(args.claw_dir) / ".claude" / "claudeclaw"
    cfg = load_config(claw / "settings.json")
    if cfg is None:
        log.info("tg-watch disabled")
        return 0
    tg_dir = Path(args.tg_config_dir).expanduser()
    creds = json.loads((tg_dir / "config.json").read_text())
    session = (tg_dir / "session.string").read_text().strip()
    client = TelegramClient(StringSession(session), int(creds["api_id"]), creds["api_hash"],
                            device_model="Cookie assistant MCP")
    await client.connect()
    if not await client.is_user_authorized():
        log.error("telegram session is not authorized; re-login tg-user")
        return 1

    async def fetch(src: Source, last_seen: int | None):
        new: list[Msg] = []
        if last_seen is not None:
            got = await client.get_messages(src.bot_id, limit=cfg.catch_up_limit,
                                            min_id=last_seen or 0)
            new = [to_msg(m) for m in got if not m.out]
        recent = [to_msg(m) for m in await client.get_messages(src.bot_id, limit=cfg.edit_window)
                  if not m.out]
        return new, recent

    attempts: dict[int, int] = {}

    async def inject(src: Source, batch: Batch) -> bool:
        n = attempts[src.bot_id] = attempts.get(src.bot_id, 0) + 1
        try:
            port = json.loads((claw / "state.json").read_text())["web"]["port"]
            token = (claw / "web.token").read_text().strip()
            prompt = build_prompt(src, batch, cfg)
            ok = await asyncio.to_thread(
                post_inject, f"http://127.0.0.1:{port}/api/inject", token,
                inject_payload(prompt, cfg, src), cfg.inject_timeout_seconds)
        except Exception as e:
            log.error("inject failed source=%s attempt=%d: %s", src.name, n, e)
            return False
        if ok:
            attempts[src.bot_id] = 0
            log.info("flushed source=%s ok %s", src.name, prompt[:200].replace("\n", " "))
        else:
            log.error("inject failed source=%s attempt=%d: daemon returned not ok", src.name, n)
        return ok

    state_path = claw / "tg-watch-state.json"
    state = State.load(state_path)
    recover_inflight(state)
    runner = Runner(cfg, state, state_path, fetch, inject, time.time)
    log.info("tg-watch started sources=%d poll=%ds", len(cfg.sources), cfg.poll_seconds)
    try:
        while True:
            await runner.tick()
            await asyncio.sleep(cfg.poll_seconds)
    finally:
        await client.disconnect()


def main() -> None:
    ap = argparse.ArgumentParser(description="Watch Telegram bot chats and digest them via ClaudeClaw.")
    ap.add_argument("--claw-dir", default="/home/cookie/Desktop")
    ap.add_argument("--tg-config-dir", default="~/.config/tg-user")
    args = ap.parse_args()
    logging.basicConfig(stream=sys.stdout, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(asyncio.run(amain(args)))


if __name__ == "__main__":
    main()
