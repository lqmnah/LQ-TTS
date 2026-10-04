import pytest
from pydantic import ValidationError

from lq_tts_engine.config import load_config, priority_for
from lq_tts_engine.settings import JobSettings

BASE_ENV = {
    "LQTTS_DATABASE_URL": "postgresql://u:p@127.0.0.1/db",
    "LQTTS_DATA_DIR": "/tmp/lqtts-data",
    "LQTTS_TOKENS": "lq-tts:tok-a,lq-studio:tok-b",
    "LQTTS_CALLBACK_SECRETS": "lq-tts:sec-a,lq-studio:sec-b",
}


def test_tokens_map_token_to_caller():
    cfg = load_config(BASE_ENV)
    assert cfg.tokens == {"tok-a": "lq-tts", "tok-b": "lq-studio"}
    assert cfg.callback_secrets == {"lq-tts": "sec-a", "lq-studio": "sec-b"}
    assert cfg.schema == "lq_tts_engine"
    assert cfg.min_free_gb == 20.0


def test_malformed_pairs_are_rejected():
    with pytest.raises(ValueError, match="LQTTS_TOKENS"):
        load_config({**BASE_ENV, "LQTTS_TOKENS": "lq-tts-without-token"})


def test_missing_required_setting_is_named():
    env = dict(BASE_ENV)
    del env["LQTTS_DATABASE_URL"]
    with pytest.raises(ValueError, match="LQTTS_DATABASE_URL"):
        load_config(env)


def test_job_settings_defaults_match_spec():
    s = JobSettings()
    assert (s.speed, s.pause_sentence_s, s.pause_paragraph_s, s.loudness_lufs) == (0.9, 0.45, 0.80, -14.0)
    assert s.formats == ["mp3", "wav", "srt", "vtt"]


@pytest.mark.parametrize("field,value", [
    ("speed", 0.69), ("speed", 1.31), ("pause_sentence_s", -0.1), ("pause_paragraph_s", 3.01),
    ("loudness_lufs", -24.5), ("loudness_lufs", -8.5),
])
def test_job_settings_reject_out_of_range(field, value):
    with pytest.raises(ValidationError):
        JobSettings(**{field: value})


def test_job_settings_accept_range_edges():
    s = JobSettings(speed=0.7, pause_sentence_s=0, pause_paragraph_s=3, loudness_lufs=-24)
    assert s.speed == 0.7


def test_job_settings_reject_unknown_keys_and_empty_formats():
    with pytest.raises(ValidationError):
        JobSettings(volume=2)
    with pytest.raises(ValidationError):
        JobSettings(formats=[])
    with pytest.raises(ValidationError):
        JobSettings(formats=["ogg"])


def test_job_settings_dedupe_formats_keeping_order():
    assert JobSettings(formats=["wav", "mp3", "wav"]).formats == ["wav", "mp3"]




def test_every_caller_needs_a_callback_secret():
    with pytest.raises(ValueError, match="no callback secret for caller lq-studio"):
        load_config({**BASE_ENV, "LQTTS_CALLBACK_SECRETS": "lq-tts:sec-a"})


def test_callback_hosts_are_per_caller_and_optional():
    assert load_config(BASE_ENV).callback_hosts == {}
    cfg = load_config({**BASE_ENV, "LQTTS_CALLBACK_HOSTS": "lq-studio:Hooks.Example.com|10.0.0.5"})
    assert cfg.callback_hosts == {"lq-studio": frozenset({"hooks.example.com", "10.0.0.5"})}
    with pytest.raises(ValueError, match="unknown caller nobody"):
        load_config({**BASE_ENV, "LQTTS_CALLBACK_HOSTS": "nobody:x.example"})


def test_duplicate_token_or_caller_fails_at_startup():
    with pytest.raises(ValueError, match="callers lq-tts and lq-studio share one token"):
        load_config({**BASE_ENV, "LQTTS_TOKENS": "lq-tts:same,lq-studio:same"})
    with pytest.raises(ValueError, match="LQTTS_TOKENS: lq-tts is listed twice"):
        load_config({**BASE_ENV, "LQTTS_TOKENS": "lq-tts:tok-a,lq-tts:tok-b"})


@pytest.mark.parametrize("entry", ["hooks.example.com:443", "[::1]", "https://hooks.example.com",
                                   "hooks.example.com/cb", "hooks example.com", "user@hooks.example.com"])
def test_callback_hosts_that_can_never_match_are_rejected(entry):
    with pytest.raises(ValueError, match="LQTTS_CALLBACK_HOSTS: lq-studio: .*can never match"):
        load_config({**BASE_ENV, "LQTTS_CALLBACK_HOSTS": f"lq-studio:ok.example|{entry}"})


def test_callback_hosts_accept_bare_ipv6():
    cfg = load_config({**BASE_ENV, "LQTTS_CALLBACK_HOSTS": "lq-studio:FD00::5"})
    assert cfg.callback_hosts == {"lq-studio": frozenset({"fd00::5"})}


def test_priority_ranges_are_per_caller_and_optional():
    assert load_config(BASE_ENV).priority_ranges == {}
    cfg = load_config({**BASE_ENV, "LQTTS_PRIORITY_RANGES": "lq-studio:3-3"})
    assert cfg.priority_ranges == {"lq-studio": (3, 3)}
    with pytest.raises(ValueError, match="LQTTS_PRIORITY_RANGES: unknown caller nobody"):
        load_config({**BASE_ENV, "LQTTS_PRIORITY_RANGES": "nobody:1-5"})
    for bad in ("5-1", "1", "a-5", "0-10", "-1-5"):
        with pytest.raises(ValueError, match="LQTTS_PRIORITY_RANGES: lq-tts: expected"):
            load_config({**BASE_ENV, "LQTTS_PRIORITY_RANGES": f"lq-tts:{bad}"})


def test_priority_for_clamps_to_the_callers_range():
    cfg = load_config({**BASE_ENV, "LQTTS_PRIORITY_RANGES": "lq-studio:3-3"})
    assert [priority_for(cfg, "lq-tts", p) for p in (None, 0, 1, 5, 9, 10)] == [5, 1, 1, 5, 5, 5]
    assert [priority_for(cfg, "lq-studio", p) for p in (None, 1, 9)] == [3, 3, 3]
