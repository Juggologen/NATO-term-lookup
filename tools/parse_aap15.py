#!/usr/bin/env python3
"""Parse the NATOTerm AAP-15 extract (NATO abbreviations) into structured JSON.

The PDF is typeset by Apache FOP with a reliable visual grammar:
  bold    -> headword abbreviation (consecutive bold lines are variant forms)
  upright -> the entry's primary language
  italic  -> the entry's secondary language
The trailing status line says which language is primary:
  "NATO Agreed" -> primary English, secondary French
  "Agree OTAN"  -> primary French,  secondary English

Lines are re-flowed into logical units using Helvetica metrics: a line is a
continuation of the previous one only if the next word could not have fitted
in the column.  That distinguishes a wrapped phrase from a second synonym
sitting on its own line.
"""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helv

PAGE_RE = re.compile(r'<page number="(\d+)"')
TEXT_RE = re.compile(r'<text top="(\d+)" left="(\d+)" width="(\d+)"[^>]*>(.*?)</text>', re.S)
BOLD_RE = re.compile(r'<b>')
ITAL_RE = re.compile(r'<i>')
TAG_RE = re.compile(r'<[^>]+>')

COLUMNS = {108: 337.0, 473: 337.0}
SPACE_PX = helv.px(' ')
TOLERANCE = 0.0
FIRST_BODY_PAGE = 4

FURNITURE_RE = re.compile(r'^-\s*(\d+\s*/\s*\d+|[A-Z0-9]{1,3})\s*-$')
SOURCE_RE = re.compile(r'^\[.*\]$')
NOTE_RE = re.compile(r'^(Note\(s\)|Example\(s\)|Exemple\(s\)|Preferred abbreviation|'
                     r'Abréviation privilégiée|Preferred term|Terme privilégié)')
MARKER_RE = re.compile(r'\s*\((obsolete|admitted|deprecated)\s*-\s*[^)]*\)')
ABBR_RE = re.compile(r"^[A-Z0-9][A-Z0-9&/()\-.'À-Ý ]*$")
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
STATUS_EN = 'NATO Agreed'
STATUS_FR = 'Agréé OTAN'


def read_lines(xml_path):
    """Yield (text, width, is_bold, is_italic) for body pages, in reading order."""
    with open(xml_path, encoding='utf-8', errors='replace') as fh:
        xml_text = fh.read()
    for chunk in re.split(r'(?=<page number=")', xml_text):
        pm = PAGE_RE.match(chunk)
        if not pm or int(pm.group(1)) < FIRST_BODY_PAGE:
            continue
        for _top, left, width, body in TEXT_RE.findall(chunk):
            if int(left) not in COLUMNS:
                continue
            bold = bool(BOLD_RE.search(body))
            ital = bool(ITAL_RE.search(body))
            txt = html.unescape(TAG_RE.sub('', body)).replace(' ', ' ')
            txt = re.sub(r'\s+', ' ', txt).strip()
            if not txt or FURNITURE_RE.match(txt):
                continue
            yield txt, int(width), bold, ital


def reflow(lines):
    """Join (text, width, italic) lines into logical units using the wrap rule."""
    units, buf, buf_ital = [], [], False
    for idx, (txt, width, ital) in enumerate(lines):
        if not buf:
            buf, buf_ital = [txt], ital
        else:
            buf.append(txt)
        nxt = lines[idx + 1] if idx + 1 < len(lines) else None
        wrapped = False
        # A line that opens a recognised element is never a wrap continuation.
        if nxt is not None and nxt[2] == ital \
                and not nxt[0].startswith('[') and not NOTE_RE.match(nxt[0]):
            first_word = nxt[0].split(' ', 1)[0]
            # The reported width is rounded; recompute it from the font metrics.
            if helv.px(txt) + SPACE_PX + helv.px(first_word) > 337.0 + TOLERANCE:
                wrapped = True
        if not wrapped:
            units.append((' '.join(buf), buf_ital))
            buf = []
    if buf:
        units.append((' '.join(buf), buf_ital))
    return repair(units)


def repair(units):
    """Re-join units the wrap rule split inside a parenthesised marker."""
    out = []
    for text, ital in units:
        if out and out[-1][1] == ital and out[-1][0].count('(') > out[-1][0].count(')'):
            out[-1] = (out[-1][0] + ' ' + text, ital)
        else:
            out.append((text, ital))
    return out


def split_entries(stream):
    """A bold line opens a new entry, unless it is another headword variant.

    Variants follow the previous bold line directly, or are separated from it
    only by that headword's own source reference, as in:
        CBRN / [JCBRNDCDG DTP] / NBC (obsolete) / [NASG] / chemical, ...
    """
    entries, cur = [], None
    only_sources_since_bold = False
    prev_bold = False
    for txt, width, bold, ital in stream:
        if bold and not (prev_bold or only_sources_since_bold):
            if cur:
                entries.append(cur)
            cur = []
        if cur is not None:
            cur.append((txt, width, bold, ital))
        if bold:
            only_sources_since_bold = True
        elif not SOURCE_RE.match(txt):
            only_sources_since_bold = False
        prev_bold = bold
    if cur:
        entries.append(cur)
    return entries


def strip_markers(text):
    flags = [m.group(1) for m in MARKER_RE.finditer(text)]
    return MARKER_RE.sub('', text).strip(), flags


def parse_block(units, allow_leading_abbr):
    """Classify a language block's units into abbr / forms / notes / sources."""
    abbr, forms, notes, sources = None, [], [], []
    i = 0
    if allow_leading_abbr and len(units) >= 2:
        head, _ = strip_markers(units[0])
        if head and len(head) <= 14 and ABBR_RE.match(head) and not SOURCE_RE.match(head):
            abbr, i = head, 1
    in_note = False
    for unit in units[i:]:
        if SOURCE_RE.match(unit):
            sources.append(unit.strip('[]'))
        elif NOTE_RE.match(unit):
            notes.append(unit)
            in_note = True
        elif in_note:
            # Within a language block the forms always precede the notes, so
            # anything after a note that is not a source continues that note.
            notes[-1] += ' ' + unit
        else:
            text, flags = strip_markers(unit)
            if text:
                forms.append({'text': text, 'flags': flags} if flags else {'text': text})
    return abbr, forms, notes, sources


def pick(forms):
    """Preferred form first, deprecated/obsolete ones demoted."""
    if not forms:
        return None, []
    ok = [f for f in forms if not f.get('flags')]
    rest = [f for f in forms if f.get('flags')]
    ordered = ok + rest
    primary = ordered[0]['text']
    alts = [f['text'] for f in ordered[1:]]
    return primary, alts


def parse_entry(entry):
    heads = [t for t, _w, b, _i in entry if b]
    body = [(t, w, i) for t, w, b, i in entry if not b]
    if not heads:
        return None

    abbrs, head_flags = [], []
    for h in heads:
        a, f = strip_markers(h)
        if a:
            abbrs.append(a)
            head_flags.extend(f)
    if not abbrs:
        return None

    units = reflow(body)
    status, date, content = None, None, []
    for text, ital in units:
        if text in (STATUS_EN, STATUS_FR):
            status = text
        elif DATE_RE.match(text):
            date = text
        else:
            content.append((text, ital))

    primary = [t for t, i in content if not i]
    secondary = [t for t, i in content if i]
    _pa, p_forms, p_notes, p_src = parse_block(primary, allow_leading_abbr=False)
    s_abbr, s_forms, s_notes, s_src = parse_block(secondary, allow_leading_abbr=True)

    if status == STATUS_FR:
        en_forms, en_notes, en_src, en_abbr = s_forms, s_notes, s_src, s_abbr
        fr_forms, fr_notes, fr_abbr = p_forms, p_notes, None
    else:
        en_forms, en_notes, en_src, en_abbr = p_forms, p_notes, p_src, None
        fr_forms, fr_notes, fr_abbr = s_forms, s_notes, s_abbr

    en, en_alts = pick(en_forms)
    fr, fr_alts = pick(fr_forms)

    # Cross-reference stubs: "ABFAC (obsolete) -> Preferred abbreviation: FAC(A)."
    redirect = None
    if not en:
        for n in en_notes + fr_notes + [t for t, _i in content]:
            m = re.match(r'Preferred abbreviation:\s*(.+?)\.?$', n)
            if m:
                redirect = m.group(1).strip()
                break

    variants = list(abbrs[1:])
    if en_abbr and en_abbr not in abbrs and en_abbr not in variants:
        variants.append(en_abbr)

    return {
        'abbr': abbrs[0],
        'variants': variants,
        'fr_abbr': fr_abbr,
        'en_abbr': en_abbr,
        'en': en,
        'en_alts': en_alts,
        'fr': fr,
        'fr_alts': fr_alts,
        'en_notes': en_notes,
        'fr_notes': fr_notes,
        'sources': sorted(set(en_src)),
        'status': status,
        'date': date,
        'flags': sorted(set(head_flags)),
        'redirect': redirect,
    }


def main(xml_path, out_path):
    entries = split_entries(read_lines(xml_path))
    records, skipped = [], []
    for e in entries:
        r = parse_entry(e)
        if r and (r['en'] or r.get('redirect')):
            records.append(r)
        else:
            skipped.append(e)
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(records, fh, ensure_ascii=False, indent=1)
    print(f'entries={len(entries)} parsed={len(records)} skipped={len(skipped)}')
    return skipped


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
