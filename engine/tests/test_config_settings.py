import pytest
from pydantic import ValidationError

from lq_tts_engine.config import load_config
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
