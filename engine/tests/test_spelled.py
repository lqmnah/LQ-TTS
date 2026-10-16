import pytest

from lq_tts_engine.text.spelled import accent_spelled


# 2026-10-16: the Abysa LoRA voice read "ka pe pe" as "kapepe" and "ka te pe" as "katepe". Of five ways to write the
# letters, lqmnah's blind ear test picked one hyphenated word with é for the e-taling; the first case is that render's text.
@pytest.mark.parametrize("text, spoken", [
    ("Surat dari ka pe pe Pajak Solo datang setelah ka te pe-nya dipakai orang lain.",
     "Surat dari ka-pé-pé Pajak Solo datang setelah ka-té-pé-nya dipakai orang lain."),
    ("Laporan pe pe a te ka soal be u em en.", "Laporan pé-pé-a-té-ka soal bé-u-ém-én."),
    ("Anggota de pe er dan be pe je es.", "Anggota dé-pé-ér dan bé-pé-jé-és."),
    ("Diperiksa o je ka dan Ka Pe Ka, lalu KA PE PE.", "Diperiksa o-jé-ka dan Ka-Pé-Ka, lalu KA-PÉ-PÉ."),
])
def test_spelled_acronyms_become_one_word_of_accented_letter_names(text, spoken):
    assert accent_spelled(text) == spoken


@pytest.mark.parametrize("text", [
    "Ha ha, e e, dia berani be a leader.",  # interjections and English are not acronyms
    "Kode te saja, ka.",  # a lone letter name is a word
    "Kapal itu membawa pepes dan es teh.",
])
def test_text_without_spelled_acronyms_stays_as_written(text):
    assert accent_spelled(text) == text
