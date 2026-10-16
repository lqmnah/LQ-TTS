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


@pytest.mark.parametrize("text,expected", [
    ("25.000", "25000"),
    ("1.500.000 rupiah", "1500000 rupiah"),
    ("25,000", "25000"),
    ("naik 2.5 persen", "naik 2 5 persen"),
])
def test_thousand_separators_collapse(text, expected):
    assert normalize_for_match(text) == expected


def test_regression_whisper_thousand_separators_pass():
    assert score("Cuma dua puluh lima ribu.", "Cuma 25.000.") >= PASS_SCORE
    assert score("Gajinya satu juta lima ratus ribu.", "Gajinya 1.500.000.") >= PASS_SCORE


# 2026-10-16: LQ Journal and LQ-Studio send acronyms spelled out ("ka te pe" for KTP) while Whisper writes them as letters.
# Every take of such a sentence failed QA, so the engine spent 4 takes and kept the one whose transcript looked most like
# the spelling — a mispronounced take ("Kata Ted, P"). Transcripts below are from those PROD jobs.
SPELLED = "ka te pe-nya dipakai tanpa izin, lalu kasus itu diperiksa o je ka dan Ka Pe Ka."
RIGHT = "KTP -nya dipakai tanpa izin, lalu kasus itu diperiksa OJK dan KPK."


def test_acronym_heard_as_letters_matches_its_spelling():
    assert score(SPELLED, RIGHT) >= PASS_SCORE


@pytest.mark.parametrize("heard", [
    "Kata Ted, P -nya dipakai tanpa izin. Lalu kasus itu diperiksa OJK dan KPK.",
    "Buka TP -nya dipakai tanpa izin, lalu kasus itu diperiksa OJK dan KPK.",
    "KATP -nya dipakai tanpa izin, lalu kasus itu diperiksa OJK dan KPK.",
])
def test_mispronounced_acronym_fails_and_ranks_below_the_right_take(heard):
    assert score(SPELLED, heard) < PASS_SCORE
    assert score(SPELLED, heard) < score(SPELLED, RIGHT)


@pytest.mark.parametrize("heard", ["Laporan PPATK.", "Laporan P.P.A.T.K.", "laporan ppatk"])
def test_short_sentence_with_a_correct_acronym_passes(heard):
    assert score("Laporan pe pe a te ka.", heard) >= PASS_SCORE


def test_acronym_with_its_suffix_glued_on_passes():
    assert score("ka te pe-nya dipakai tanpa izin.", "KTPnya dipakai tanpa izin.") >= PASS_SCORE


def test_takes_that_all_lose_the_acronym_still_rank_by_similarity():
    near = score("Laporan pe pe a te ka menyebut dana itu.", "Laporan pepe atika menyebut dana itu.")
    far = score("Laporan pe pe a te ka menyebut dana itu.", "Laporan papa menyebut sesuatu.")
    assert far < near < PASS_SCORE


@pytest.mark.parametrize("expected,heard", [
    ("Ha ha, tentu saja.", "Haha, tentu saja."),
    ("E e, tunggu dulu.", "Eh, tunggu dulu."),
    ("This is going to be a long night.", "This is going to be a long night."),
])
def test_interjections_and_plain_words_are_not_acronyms(expected, heard):
    assert score(expected, heard) >= PASS_SCORE
