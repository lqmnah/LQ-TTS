"""End-to-end check against the running pm2 service.

Usage: uv run python scripts/e2e_smoke.py --audio <file> --script <file> --out <dir>
Reads the lq-tts token from engine/.env.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx

from lq_tts_engine.config import load_config

BASE = "http://127.0.0.1:8740"


def wait(client: httpx.Client, url: str, done: set[str], timeout_s: float) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        body = client.get(url).raise_for_status().json()
        if body["status"] in done:
            return body
        time.sleep(2)
    raise TimeoutError(url)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", type=Path, required=True)
    ap.add_argument("--script", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    token = next(t for t, caller in load_config().tokens.items() if caller == "lq-tts")
    args.out.mkdir(parents=True, exist_ok=True)

    with httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}"}, timeout=120) as c:
        print("health:", c.get("/v1/health").json())
        with args.audio.open("rb") as fh:
            voice = c.post("/v1/voices", data={"name": "Pandji", "owner_ref": "e2e", "language": "id"},
                           files={"audio": (args.audio.name, fh, "audio/mpeg")}).raise_for_status().json()
        voice = wait(c, f"/v1/voices/{voice['id']}", {"ready", "failed"}, 900)
        print("voice:", json.dumps({k: voice[k] for k in ("status", "clip_start_s", "clip_end_s", "ref_transcript")},
                                   ensure_ascii=False))
        assert voice["status"] == "ready"

        job = c.post("/v1/jobs", json={"voice_id": voice["id"], "text": args.script.read_text()}).raise_for_status().json()
        print("job:", job)
        t0 = time.monotonic()
        final = wait(c, f"/v1/jobs/{job['id']}", {"done", "failed", "canceled"}, 1800)
        print(f"job done in {time.monotonic() - t0:.0f}s:", {k: final[k] for k in ("status", "revision", "audio_seconds", "needs_review")})
        assert final["status"] == "done"
        for name, url in final["files"].items():
            (args.out / f"r1-{name}").write_bytes(c.get(url).raise_for_status().content)

        regen = c.post(f"/v1/jobs/{job['id']}/sentences/9/regenerate", json={}).raise_for_status().json()
        assert regen == {"revision": 2}, regen
        final2 = wait(c, f"/v1/jobs/{job['id']}", {"done", "failed"}, 600)
        assert final2["status"] == "done" and final2["revision"] == 2
        (args.out / "r2-final.mp3").write_bytes(c.get(final2["files"]["final.mp3"]).raise_for_status().content)
        print("files:", sorted(p.name for p in args.out.iterdir()))


if __name__ == "__main__":
    main()
