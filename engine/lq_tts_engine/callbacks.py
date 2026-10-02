from __future__ import annotations

import hashlib
import hmac
import json
import logging
import threading
import time
from collections.abc import Callable

import httpx

RETRY_DELAYS_S = (1, 5, 30, 120, 300)
log = logging.getLogger("lq_tts_engine.callbacks")


def sign(secret: str, timestamp: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    return hmac.compare_digest(sign(secret, timestamp, body), signature)


class CallbackSender:
    def __init__(self, secrets: dict[str, str], *, delays: tuple[int, ...] = RETRY_DELAYS_S,
                 client_factory: Callable[[], httpx.Client] = lambda: httpx.Client(timeout=10),
                 sleep: Callable[[float], None] = time.sleep):
        self.secrets = secrets
        self.delays = delays
        self.client_factory = client_factory
        self.sleep = sleep

    def send(self, caller: str, url: str, payload: dict) -> threading.Thread:
        thread = threading.Thread(target=self.deliver, args=(caller, url, payload), daemon=True)
        thread.start()
        return thread

    def deliver(self, caller: str, url: str, payload: dict) -> bool:
        body = json.dumps(payload, separators=(",", ":")).encode()
        for delay in (0, *self.delays):
            if delay:
                self.sleep(delay)
            timestamp = str(int(time.time()))
            headers = {"Content-Type": "application/json", "X-LQ-Timestamp": timestamp,
                       "X-LQ-Signature": sign(self.secrets[caller], timestamp, body)}
            try:
                with self.client_factory() as client:
                    response = client.post(url, content=body, headers=headers)
                if 200 <= response.status_code < 300:
                    return True
            except httpx.HTTPError:
                pass
        log.warning("callback dropped after retries", extra={"ctx": {"url": url, "payload": payload}})
        return False

