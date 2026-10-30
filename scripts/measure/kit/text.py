"""How transcript text is compared: the normalisation every metric works on."""

import unicodedata


def normalize(text: str) -> str:
    """Lower case, "ё" as "е", and every punctuation mark, symbol, space or control character as one space.

    Digits are kept as they are, so "25" and "двадцать пять" differ: the engines write numbers both ways, and a
    rule that spells them out would have to know the language. "кто-то" and "don't" become two words each, on both
    sides alike.
    """
    text = text.lower().replace("ё", "е")
    kept = (" " if unicodedata.category(ch)[0] in "PSZC" else ch for ch in text)
    return " ".join("".join(kept).split())


def words(text: str) -> list[str]:
    return normalize(text).split()
