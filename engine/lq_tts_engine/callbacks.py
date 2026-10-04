from __future__ import annotations

import hashlib
import hmac
import json
import logging
import threading
import time
from collections.abc import Callable
from urllib.parse import urlsplit

import httpx

RETRY_DELAYS_S = (1, 5, 30, 120, 300)
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
log = logging.getLogger("lq_tts_engine.callbacks")


def sign(secret: str, timestamp: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    return hmac.compare_digest(sign(secret, timestamp, body), signature)


def callback_url_allowed(url: str, extra_hosts: frozenset[str] = frozenset()) -> bool:
    """http(s) to loopback, or to a host configured for the caller; no credentials, a valid port."""
    try:
        parts = urlsplit(url)
        parts.port  # raises ValueError when the port is not a number in range
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    return (parts.scheme in ("http", "https") and not parts.username and not parts.password
            and host != "" and (host in LOOPBACK_HOSTS or host in extra_hosts))


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
        secret = self.secrets.get(caller)
        if secret is None:
            log.warning("callback dropped: no secret for caller",
                        extra={"ctx": {"caller": caller, "url": url, "payload": payload}})
            return False
        body = json.dumps(payload, separators=(",", ":")).encode()
        last_error = None
        for delay in (0, *self.delays):
            if delay:
                self.sleep(delay)
            timestamp = str(int(time.time()))
            headers = {"Content-Type": "application/json", "X-LQ-Timestamp": timestamp,
                       "X-LQ-Signature": sign(secret, timestamp, body)}
            try:
                with self.client_factory() as client:
                    response = client.post(url, content=body, headers=headers)
                if 200 <= response.status_code < 300:
                    return True
                last_error = f"HTTP {response.status_code}"
            except Exception as exc:  # noqa: BLE001 - the sender thread must always end in delivered or "dropped"
                last_error = f"{type(exc).__name__}: {exc}"
        log.warning("callback dropped after retries",
                    extra={"ctx": {"url": url, "payload": payload, "error": last_error}})
        return False
