import pytest

from lq_tts_engine.qa import PASS_SCORE, levenshtein, score
from lq_tts_engine.text.lang import guess_language
from lq_tts_engine.text.numbers import normalize_for_match


@pytest.mark.parametrize("text,expected", [
    ("Satu jam.", "1 jam"),
    ("dua puluh menit", "20 menit"),
    ("dua puluh lima ribu", "25000"),
    ("dua ratus lima puluh", "250"),
    ("seribu dua ratus", "1200"),
    ("tujuh belas", "17"),
    ("sepuluh ribu", "10000"),
    ("dua juta tiga ratus ribu", "2300000"),
    ("twenty three", "23"),
    ("one hundred twenty", "120"),
    ("Satu? Tiga?", "1 3"),
    ("satu tiga", "1 3"),
    ("twenty-three", "23"),
    ("twenty-three years", "23 years"),
    ("25 ribu", "25000"),
    ("3 juta rupiah", "3000000 rupiah"),
    ("satu-satunya", "1 satunya"),
])
def test_number_words_become_digits(text, expected):
    assert normalize_for_match(text) == expected


def test_slang_variants_normalize_to_one_spelling():
    assert normalize_for_match("Lo nggak sendirian") == normalize_for_match("lu enggak sendirian")
    assert normalize_for_match("ngecek HP") == normalize_for_match("ngecek hape")


def test_levenshtein():
    assert levenshtein("", "abc") == 3
    assert levenshtein("kitten", "sitting") == 3
    assert levenshtein("sama", "sama") == 0


def test_identical_and_empty_score_one():
    assert score("Halo semua.", "halo semua") == 1.0
    assert score("", "") == 1.0


def test_regression_spoken_numbers_written_as_digits_pass():
    # 2026-10-02: Whisper wrote "Satu? Tiga?" as "1, 3"
    assert score("Satu? Tiga? Atau udah nggak keitung?", "1, 3 atau udah gak keitung") >= PASS_SCORE


def test_real_whisper_output_from_pandji_run_passes():
    assert score(
        "Dalam sepuluh menit terakhir, berapa kali lo ngecek HP?",
        "dalam 10 menit terakhir berapa kali lo ngecek hape",
    ) >= PASS_SCORE


def test_hyphenated_number_matches_digits():
    assert score("I am twenty-three.", "I am 23.") >= PASS_SCORE


def test_digit_plus_scale_matches_number_words():
    assert score("Harganya dua puluh lima ribu.", "Harganya 25 ribu.") >= PASS_SCORE


def test_regression_mispronounced_sentence_fails():
    # 2026-10-02: "Nggak usah ekstrem." came out as "Sosa ekstrem."
    assert score("Nggak usah ekstrem.", "Sosa ekstrem.") < PASS_SCORE


def test_score_is_bounded():
    assert 0.0 <= score("a", "completely different text") <= 1.0


@pytest.mark.parametrize("text,lang", [
    ("Tiap kali lo buka notifikasi, otak lo butuh waktu buat balik lagi ke kerjaan yang tadi.", "id"),
    ("This is the part where you decide what to do with your time.", "en"),
    ("Halo!", None),
])
def test_guess_language(text, lang):
    assert guess_language(text) == lang
