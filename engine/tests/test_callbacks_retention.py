import json
import logging
import os
import time
from pathlib import Path

import httpx

from lq_tts_engine.callbacks import CallbackSender, sign, verify
from lq_tts_engine.retention import free_gb, purge_unreferenced_takes


def test_signature_verifies_and_detects_tampering():
    body = b'{"job_id":"x","status":"done","revision":1}'
    sig = sign("s3cret", "1700000000", body)
    assert sig.startswith("sha256=") and verify("s3cret", "1700000000", body, sig)
    assert not verify("s3cret", "1700000001", body, sig)
    assert not verify("s3cret", "1700000000", body + b" ", sig)
    assert not verify("other", "1700000000", body, sig)


def make_sender(statuses):
    seen, sleeps = [], []

    def handler(request):
        seen.append(request)
        return httpx.Response(statuses[min(len(seen) - 1, len(statuses) - 1)])

    sender = CallbackSender({"lq-tts": "s3cret"}, client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
                            sleep=sleeps.append)
    return sender, seen, sleeps


def test_delivery_retries_until_success_with_valid_signature():
    sender, seen, sleeps = make_sender([500, 502, 200])
    assert sender.deliver("lq-tts", "http://app.local/cb", {"job_id": "j1", "status": "done", "revision": 2}) is True
    assert len(seen) == 3 and sleeps == [1, 5]
    req = seen[-1]
    assert json.loads(req.content) == {"job_id": "j1", "status": "done", "revision": 2}
    assert verify("s3cret", req.headers["X-LQ-Timestamp"], req.content, req.headers["X-LQ-Signature"])


def test_delivery_gives_up_after_five_retries():
    sender, seen, sleeps = make_sender([503])
    assert sender.deliver("lq-tts", "http://app.local/cb", {"job_id": "j1"}) is False
    assert len(seen) == 6 and sleeps == [1, 5, 30, 120, 300]


def test_purge_removes_only_old_unreferenced_takes(tmp_path):
    takes = tmp_path / "jobs" / "j1" / "takes"
    takes.mkdir(parents=True)
    old_unref, old_ref, new_unref = takes / "s0000_r1_t1.wav", takes / "s0000_r1_t2.wav", takes / "s0001_r1_t1.wav"
    for p in (old_unref, old_ref, new_unref):
        p.write_bytes(b"x")
    eight_days_ago = time.time() - 8 * 86400
    for p in (old_unref, old_ref):
        os.utime(p, (eight_days_ago, eight_days_ago))
    final = tmp_path / "jobs" / "j1" / "r1" / "final.wav"
    final.parent.mkdir()
    final.write_bytes(b"x")
    os.utime(final, (eight_days_ago, eight_days_ago))
    assert purge_unreferenced_takes(tmp_path, {str(old_ref)}) == 1
    assert not old_unref.exists() and old_ref.exists() and new_unref.exists() and final.exists()


def test_free_gb_is_positive(tmp_path):
    assert free_gb(tmp_path) > 0




def test_purge_skips_takes_deleted_mid_purge(tmp_path, monkeypatch):
    takes = tmp_path / "jobs" / "j1" / "takes"
    takes.mkdir(parents=True)
    gone, kept = takes / "s0000_r1_t1.wav", takes / "s0001_r1_t1.wav"
    eight_days_ago = time.time() - 8 * 86400
    for p in (gone, kept):
        p.write_bytes(b"x")
        os.utime(p, (eight_days_ago, eight_days_ago))
    real_stat = Path.stat

    def racing_stat(self, *args, **kwargs):
        if self == gone and os.path.exists(gone):
            os.unlink(gone)  # DELETE /v1/jobs removes the folder while the purge runs
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", racing_stat)
    assert purge_unreferenced_takes(tmp_path, set()) == 1
    assert not os.path.exists(kept)




def test_unusable_url_or_unknown_caller_is_logged_as_dropped(caplog):
    sender, seen, sleeps = make_sender([200])
    with caplog.at_level(logging.WARNING, logger="lq_tts_engine.callbacks"):
        assert sender.deliver("lq-tts", "http://a\x00b/", {"job_id": "j1"}) is False  # httpx.InvalidURL
        assert sender.deliver("nobody", "http://app.local/cb", {"job_id": "j2"}) is False  # no secret
    dropped = [r.getMessage() for r in caplog.records if r.getMessage().startswith("callback dropped")]
    assert len(dropped) == 2 and seen == []
