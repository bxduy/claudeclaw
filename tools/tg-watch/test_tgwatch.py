import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from tgwatch import Batch, Msg, SourceState, State, ingest, load_config


def msg(i, text="x", edit_date=None):
    return Msg(id=i, date=0.0, edit_date=edit_date, text=text, buttons=[], urls=[])


def run_ingest(st, new=(), recent=(), now=1000.0, limit=100, window=20):
    ingest(st, list(new), list(recent), now, limit, window)


class IngestTest(unittest.TestCase):
    def test_new_messages_after_last_seen(self):
        st = SourceState(last_seen=100)
        run_ingest(st, new=[msg(101), msg(102)])
        self.assertEqual([m.id for m in st.pending.messages], [101, 102])
        self.assertEqual(st.last_seen, 102)

    def test_edit_of_pending_replaces_text(self):
        st = SourceState(last_seen=101, edit_dates={101: 1.0},
                         pending=Batch(messages=[msg(101, "a")], first_at=1.0, last_at=1.0))
        run_ingest(st, recent=[msg(101, "b", edit_date=2.0)])
        self.assertEqual([(m.id, m.text) for m in st.pending.messages], [(101, "b")])

    def test_edit_of_sent_adds_labeled_copy(self):
        st = SourceState(last_seen=101, edit_dates={101: 1.0})
        run_ingest(st, recent=[msg(101, "b", edit_date=2.0)])
        self.assertEqual(len(st.pending.messages), 1)
        self.assertEqual(st.pending.messages[0].id, 101)
        self.assertTrue(st.pending.messages[0].edited)

    def test_first_run_sets_baseline_without_batch(self):
        st = SourceState()
        recent = [msg(90, edit_date=5.0)]
        run_ingest(st, recent=recent)
        self.assertIsNone(st.pending)
        self.assertEqual(st.last_seen, 90)
        run_ingest(st, recent=recent)
        self.assertIsNone(st.pending)

    def test_overflow_flag(self):
        st = SourceState(last_seen=0)
        run_ingest(st, new=[msg(1), msg(2), msg(3)], limit=3)
        self.assertTrue(st.pending.overflow)

    def test_state_roundtrip_and_catch_up(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "state.json"
            s = State()
            s.sources[7] = SourceState(
                last_seen=100,
                pending=Batch(messages=[msg(100)], first_at=1.0, last_at=1.0))
            s.save(path)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            loaded = State.load(path)
            st = loaded.sources[7]
            run_ingest(st, new=[msg(101)])
            self.assertEqual([m.id for m in st.pending.messages], [100, 101])

    def test_load_missing_state_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(State.load(Path(d) / "nope.json").sources, {})


class ConfigTest(unittest.TestCase):
    def _write(self, d, data):
        p = Path(d) / "settings.json"
        p.write_text(json.dumps(data))
        return p

    def test_load_config_disabled(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(load_config(self._write(d, {"tgWatch": {"enabled": False}})))
            self.assertIsNone(load_config(self._write(d, {"other": 1})))

    def test_load_config_values(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, {"tgWatch": {
                "enabled": True, "deliverChatId": -1004402543262,
                "sources": [{"name": "PR", "botId": 9233341253, "topicId": 6}]}})
            cfg = load_config(p)
            self.assertEqual(cfg.deliver_chat_id, -1004402543262)
            self.assertEqual(cfg.sources[0].topic_id, 6)
            self.assertEqual(cfg.sources[0].bot_id, 9233341253)
            self.assertEqual(cfg.quiet_seconds, 120)


if __name__ == "__main__":
    unittest.main()
