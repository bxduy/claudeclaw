# tg-watch

Polls Telegram bot chats with the tg-user account (Telethon), batches new messages, and POSTs a
digest prompt to the ClaudeClaw daemon `/api/inject`. The summary is delivered to a report group,
one topic per bot.

## 1. Prepare the report group

1. Create a supergroup, enable **Topics** (group settings).
2. Add the ClaudeClaw bot as admin (with `can_manage_topics`).
3. Create one topic per bot and note each topic id.

## 2. Configure `tgWatch`

Add to `<claw-dir>/.claude/claudeclaw/settings.json` (ids below are for the "Zenie digest" group;
`botId` is the numeric id of the watched bot):

```json
"tgWatch": {
  "enabled": true,
  "deliverChatId": -1004402543262,
  "sources": [
    { "name": "Zenie",  "botId": 8954232159, "topicId": 4 },
    { "name": "Task",   "botId": 8836615187, "topicId": 5 },
    { "name": "PR",     "botId": 9233341253, "topicId": 6 },
    { "name": "Sự cố",  "botId": 9263592476, "topicId": 7, "urgent": true }
  ]
}
```

Optional keys: `pollSeconds` (20), `catchUpLimit` (100), `editWindow` (20), `quietSeconds` (120),
`urgentQuietSeconds` (10), `maxWaitSeconds` (600), `quietHours` `{start, end}` ("22:00"/"07:00"),
`utcOffsetMinutes` (420), `injectTimeoutSeconds` (1800). Source names "Sự cố", "PR", "Task",
"Zenie" select the read-only lookup hint in the prompt.

## 3. Install

```bash
~/.local/share/tg-user/venv/bin/pip install -r tools/tg-watch/requirements.txt
systemctl --user link ~/Desktop/repos/claudeclaw/tools/tg-watch/tg-watch.service
systemctl --user enable --now tg-watch
```

Reads tg-user credentials from `~/.config/tg-user/` (`--tg-config-dir`); state is kept in
`<claw-dir>/.claude/claudeclaw/tg-watch-state.json`. `--claw-dir` defaults to `/home/cookie/Desktop`.

## 4. Logs

```bash
journalctl --user -u tg-watch -f
```

## 5. Uninstall

```bash
systemctl --user disable --now tg-watch
rm ~/.config/systemd/user/tg-watch.service   # the link created by `link`
systemctl --user daemon-reload
```

Setting `tgWatch.enabled` to `false` makes the process log `tg-watch disabled` and exit 0.
