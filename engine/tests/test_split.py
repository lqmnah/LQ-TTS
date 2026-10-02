import pytest

from lq_tts_engine.text.split import Unit, is_single_sentence, split_script

PANDJI_P1 = (
    "Coba jujur deh. Dalam sepuluh menit terakhir, berapa kali lo ngecek HP? Satu? Tiga? "
    "Atau udah nggak keitung? Tenang, lo nggak sendirian. Kita semua hidup di zaman di mana "
    "setiap getaran, setiap bunyi ting, rasanya kayak panggilan darurat."
)


def texts(units):
    return [u.text for u in units]


def test_pandji_paragraph_merges_short_fragments_into_next_sentence():
    assert texts(split_script(PANDJI_P1)) == [
        "Coba jujur deh.",
        "Dalam sepuluh menit terakhir, berapa kali lo ngecek HP?",
        "Satu? Tiga? Atau udah nggak keitung?",
        "Tenang, lo nggak sendirian.",
        "Kita semua hidup di zaman di mana setiap getaran, setiap bunyi ting, rasanya kayak panggilan darurat.",
    ]


def test_paragraphs_set_index_and_end_flag():
    units = split_script("Kalimat pertama di sini. Kalimat kedua di sini.\n\nParagraf baru mulai sekarang.")
    assert [(u.idx, u.paragraph_idx, u.paragraph_end) for u in units] == [(0, 0, False), (1, 0, True), (2, 1, True)]


def test_abbreviations_do_not_end_sentences():
    assert texts(split_script("Kata dr. Budi ini penting sekali. Harganya Rp. 5000 saja hari ini.")) == [
        "Kata dr. Budi ini penting sekali.",
        "Harganya Rp. 5000 saja hari ini.",
    ]


def test_decimals_do_not_end_sentences():
    assert texts(split_script("Harganya naik 2.5 persen tahun ini. Itu cukup besar sekali.")) == [
        "Harganya naik 2.5 persen tahun ini.",
        "Itu cukup besar sekali.",
    ]


def test_trailing_fragment_merges_into_previous_sentence():
    assert texts(split_script("Kita mulai sekarang juga. Oke.")) == ["Kita mulai sekarang juga. Oke."]


def test_text_without_final_punctuation_is_one_unit():
    assert texts(split_script("Halo semua apa kabar")) == ["Halo semua apa kabar"]


def test_style_markup_applies_to_next_sentence_only_and_is_removed():
    units = split_script("{{style: cheerful, slightly faster}} Halo semua, apa kabar? Kita mulai sekarang ya.")
    assert units == [
        Unit(0, 0, "Halo semua, apa kabar?", "cheerful, slightly faster", False),
        Unit(1, 0, "Kita mulai sekarang ya.", None, True),
    ]


def test_style_markup_forces_a_sentence_break():
    units = split_script("Ini kalimat pembuka yang panjang {{style: whisper}} lalu bagian rahasia di sini.")
    assert [(u.text, u.style) for u in units] == [
        ("Ini kalimat pembuka yang panjang", None),
        ("lalu bagian rahasia di sini.", "whisper"),
    ]


def test_whitespace_is_collapsed_and_blank_input_gives_nothing():
    assert texts(split_script("  Satu   dua\n tiga empat.  ")) == ["Satu dua tiga empat."]
    assert split_script("   \n\n  ") == []


def test_is_single_sentence():
    assert is_single_sentence("Nggak usah ekstrem.")
    assert is_single_sentence("Satu? Tiga? Atau udah nggak keitung?")
    assert not is_single_sentence("Ini kalimat pertama ya. Ini kalimat kedua juga.")
    assert not is_single_sentence("Baris satu ini panjang.\n\nBaris dua.")
    assert not is_single_sentence("   ")


@pytest.mark.parametrize(
    ("script", "expected"),
    [
        (
            "Kita mulai sekarang juga. {{style: shout}} Oke!",
            [("Kita mulai sekarang juga.", None), ("Oke!", "shout")],
        ),
        (
            "Oke. {{style: whisper}} Ini rahasia besar kita.",
            [("Oke.", None), ("Ini rahasia besar kita.", "whisper")],
        ),
        (
            "{{style: a}} Ya. {{style: b}} Ini kalimat panjang sekali.",
            [("Ya.", "a"), ("Ini kalimat panjang sekali.", "b")],
        ),
    ],
)
def test_style_never_spreads_to_other_sentences(script, expected):
    assert [(u.text, u.style) for u in split_script(script)] == expected
