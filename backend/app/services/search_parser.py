"""Parse the free-text worklist search into structured Orthanc filter params.

The worklist used to stuff the whole search string into a `PatientName` wildcard,
so `CT 2024` hunted for patients whose NAME contains the letters C-T and the
digits 2-0-2-4 — basically always zero hits. This parser pulls modality and
date tokens out of the query so they map to proper Orthanc filters, and
passes the remainder through as free text across multiple name-like fields.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# DICOM modality codes that users type. The right-hand side is the canonical
# value Orthanc wants to see in ModalitiesInStudy. MRI/PET/XR are common
# colloquial aliases for MR/PT/DX respectively.
_MODALITY_ALIASES = {
    "CT": "CT", "MR": "MR", "MRI": "MR", "US": "US", "DX": "DX",
    "CR": "CR", "XR": "DX", "PT": "PT", "PET": "PT", "NM": "NM",
    "MG": "MG", "XA": "XA", "RF": "RF", "OT": "OT", "IO": "IO",
    "SC": "SC", "ES": "ES", "OP": "OP",
}

_YEAR = re.compile(r"^(19|20)\d{2}$")
_YEAR_RANGE = re.compile(r"^(19|20)\d{2}\s*[-.]+\s*(19|20)\d{2}$")
_YMD = re.compile(r"^(19|20)\d{2}[-./](0[1-9]|1[0-2])[-./](0[1-9]|[12]\d|3[01])$")
_YM = re.compile(r"^(19|20)\d{2}[-./](0[1-9]|1[0-2])$")


@dataclass
class ParsedSearch:
    text: str           # free-text remainder (empty if all tokens consumed)
    modality: str       # "" or a single modality code
    date_from: str      # "" or YYYYMMDD
    date_to: str        # "" or YYYYMMDD


def parse_search(raw: str) -> ParsedSearch:
    if not raw or not raw.strip():
        return ParsedSearch("", "", "", "")

    tokens = raw.strip().split()
    text_tokens: list[str] = []
    modality = ""
    date_from = ""
    date_to = ""

    i = 0
    while i < len(tokens):
        tok = tokens[i]
        u = tok.upper()

        if not modality and u in _MODALITY_ALIASES:
            modality = _MODALITY_ALIASES[u]
            i += 1
            continue

        if not date_from and _YMD.match(tok):
            d = re.sub(r"[-./]", "", tok)
            date_from = d
            date_to = d
            i += 1
            continue

        if not date_from and _YM.match(tok):
            parts = re.split(r"[-./]", tok)
            y, m = parts[0], parts[1]
            last_day = "31" if m in {"01", "03", "05", "07", "08", "10", "12"} \
                else "30" if m != "02" else "29"
            date_from = f"{y}{m}01"
            date_to = f"{y}{m}{last_day}"
            i += 1
            continue

        # Year range joined by a single dash can tokenize as one token ("2022-2024")
        # or three ("2022", "-", "2024") depending on user spacing. Handle both.
        if not date_from and _YEAR_RANGE.match(tok):
            y1, y2 = re.split(r"[-.]+", tok)
            date_from = f"{y1}0101"
            date_to = f"{y2}1231"
            i += 1
            continue
        if (not date_from and _YEAR.match(tok)
                and i + 2 < len(tokens)
                and tokens[i + 1] in {"-", "..", "to"}
                and _YEAR.match(tokens[i + 2])):
            date_from = f"{tokens[i]}0101"
            date_to = f"{tokens[i + 2]}1231"
            i += 3
            continue

        if not date_from and _YEAR.match(tok):
            date_from = f"{tok}0101"
            date_to = f"{tok}1231"
            i += 1
            continue

        text_tokens.append(tok)
        i += 1

    return ParsedSearch(
        text=" ".join(text_tokens),
        modality=modality,
        date_from=date_from,
        date_to=date_to,
    )
