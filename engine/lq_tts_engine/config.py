from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

ENGINE_DIR = Path(__file__).resolve().parent.parent


def _pairs(raw: str, name: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in filter(None, (p.strip() for p in raw.split(","))):
        key, sep, value = item.partition(":")
        if not sep or not key or not value:
            raise ValueError(f"{name}: expected 'name:value' pairs, got {item!r}")
        if key in out:
            raise ValueError(f"{name}: {key} is listed twice")
        out[key] = value
    return out


@dataclass(frozen=True)
class Config:
    database_url: str
    schema: str
    data_dir: Path
    tokens: dict[str, str]
    callback_secrets: dict[str, str]
    device: str
    whisper_model: str
    min_free_gb: float
    callback_hosts: dict[str, frozenset[str]] = field(default_factory=dict)


def load_config(env: Mapping[str, str] | None = None) -> Config:
    if env is None:
        env = {**{k: v for k, v in dotenv_values(ENGINE_DIR / ".env").items() if v is not None}, **os.environ}

    def get(key: str, default: str | None = None) -> str:
        value = env.get(key, default)
        if value is None or value == "":
            raise ValueError(f"missing required setting {key}")
        return value

    caller_tokens = _pairs(get("LQTTS_TOKENS"), "LQTTS_TOKENS")
    tokens: dict[str, str] = {}
    for caller, token in caller_tokens.items():
        if token in tokens:
            raise ValueError(f"LQTTS_TOKENS: callers {tokens[token]} and {caller} share one token")
        tokens[token] = caller
    callback_secrets = _pairs(get("LQTTS_CALLBACK_SECRETS"), "LQTTS_CALLBACK_SECRETS")
    for caller in sorted(caller_tokens):
        if caller not in callback_secrets:
            raise ValueError(f"LQTTS_CALLBACK_SECRETS: no callback secret for caller {caller}")
    callback_hosts: dict[str, frozenset[str]] = {}
    for caller, hosts in _pairs(env.get("LQTTS_CALLBACK_HOSTS") or "", "LQTTS_CALLBACK_HOSTS").items():
        if caller not in caller_tokens:
            raise ValueError(f"LQTTS_CALLBACK_HOSTS: unknown caller {caller}")
        callback_hosts[caller] = frozenset(h.strip().lower() for h in hosts.split("|") if h.strip())
    return Config(
        database_url=get("LQTTS_DATABASE_URL"),
        schema=get("LQTTS_SCHEMA", "lq_tts_engine"),
        data_dir=Path(get("LQTTS_DATA_DIR")).expanduser(),
        tokens=tokens,
        callback_secrets=callback_secrets,
        device=get("LQTTS_DEVICE", "mps"),
        whisper_model=get("LQTTS_WHISPER_MODEL", "small"),
        min_free_gb=float(get("LQTTS_MIN_FREE_GB", "20")),
        callback_hosts=callback_hosts,
    )
