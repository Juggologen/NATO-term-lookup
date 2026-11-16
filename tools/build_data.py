#!/usr/bin/env python3
"""Merge the parsed AAP-15 and AAP-06 records into the dataset the app ships.

AAP-15 supplies abbreviation -> full form; AAP-06 supplies term -> definition.
Where an AAP-15 full form matches an AAP-06 term, the definition is attached to
the abbreviation.  AAP-06 terms with no matching abbreviation are kept as
term-only entries so the free-text search can still reach them.
"""
import json
import re
import sys
import unicodedata

PUNCT_RE = re.compile(r"[^\w\s]", re.U)
SPACE_RE = re.compile(r"\s+")
SENSE_RE = re.compile(r"\s+\d+$")        # "budget 1" -> "budget"


def norm(text):
    if not text:
        return ''
    text = unicodedata.normalize('NFKD', text.lower())
    text = ''.join(c for c in text if not unicodedata.combining(c))
    text = PUNCT_RE.sub(' ', text)
    return SPACE_RE.sub(' ', text).strip()


def key(text):
    return SENSE_RE.sub('', norm(text))


def attach(entries, spec, field, value_key):
    """Attach a keyword layer: per-abbreviation (optionally narrowed to one
    sense with 'en') or per-term."""
    abbr_map = spec.get('abbr', {})
    term_map = spec.get('term', {})
    hits = 0
    for e in entries:
        words = None
        for one in abbr_map.get(e.get('a') or '', []):
            if 'en' not in one or key(one['en']) == key(e['t']):
                words = one[value_key]
                break
        if words is None:
            words = term_map.get(key(e['t']))
        if words:
            e[field] = words
            hits += 1
    return hits


def main(aap15_path, aap06_path, out_path, sv_path=None, supp_path=None, alias_path=None):
    a15 = json.load(open(aap15_path, encoding='utf-8'))
    a06 = json.load(open(aap06_path, encoding='utf-8'))
    sv = json.load(open(sv_path, encoding='utf-8')) if sv_path else {}
    supp = json.load(open(supp_path, encoding='utf-8')) if supp_path else {'entries': []}
    aliases = json.load(open(alias_path, encoding='utf-8')) if alias_path else {}

    defs = {}
    for r in a06:
        defs.setdefault(key(r['en']), []).append(r)

    # Cross-reference stubs are emitted after the real entries so their target
    # can be resolved to a readable term.
    redirects = [r for r in a15 if r.get('redirect') and not r['en']]
    a15 = [r for r in a15 if r['en']]

    entries, seen, used = [], set(), set()
    for r in a15:
        sig = (r['abbr'], norm(r['en']))
        if sig in seen:
            continue
        seen.add(sig)
        e = {'a': r['abbr'], 't': r['en']}
        k = key(r['en'])
        match = defs.get(k)
        if match:
            e['d'] = match[0]['definition']
            used.add(k)
            if len(match) > 1:
                e['d2'] = [m['definition'] for m in match[1:]]
        if r['fr']:
            e['f'] = r['fr']
        if r['variants']:
            e['v'] = r['variants']
        if r['en_alts']:
            e['alt'] = r['en_alts']
        if r['en_notes']:
            notes = [re.sub(r'^Note\(s\):\s*', '', n) for n in r['en_notes']]
            # AAP-06 definitions often already carry the same note inline.
            body = norm(e.get('d', ''))
            notes = [n for n in notes if norm(n) not in body]
            if notes:
                e['n'] = notes
        if r['flags']:
            e['g'] = r['flags']
        if r['date']:
            e['y'] = r['date']
        e['s'] = 'AAP-15'
        entries.append(e)

    target_terms = {}
    for e in entries:
        if e.get('a'):
            target_terms.setdefault(e['a'], e['t'])
    for r in redirects:
        entries.append({
            'a': r['abbr'],
            't': target_terms.get(r['redirect'], r['redirect']),
            'r': r['redirect'],
            'g': r['flags'] or ['deprecated'],
            's': 'AAP-15',
        })

    for r in a06:
        k = key(r['en'])
        if k in used:
            continue
        used.add(k)
        e = {'a': None, 't': r['en'], 'd': r['definition'], 's': 'AAP-06'}
        if r['fr']:
            e['f'] = r['fr']
        if r['abbr']:
            e['a'] = r['abbr']
        if r['flags']:
            e['g'] = r['flags']
        if r['date']:
            e['y'] = r['date'].replace('.', '-')
        entries.append(e)

    for r in supp.get('entries', []):
        e = dict(r)
        e['s'] = 'COMMON'
        entries.append(e)

    sv_hits = attach(entries, sv, 'sv', 'sv')
    alias_hits = attach(entries, aliases, 'k', 'k')

    entries.sort(key=lambda e: (norm(e['a'] or e['t']), norm(e['t'])))
    payload = {
        'generated': '2026-11-16',
        'sources': [
            {'id': 'AAP-15',
             'title': 'NATO Glossary of Abbreviations used in NATO Documents and Publications',
             'note': 'NATOTerm extract, 15 April 2026'},
            {'id': 'AAP-06',
             'title': 'NATO Glossary of Terms and Definitions',
             'note': 'Edition 2019'},
        ],
        'entries': entries,
    }
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(',', ':'))

    with_def = sum(1 for e in entries if e.get('d'))
    with_abbr = sum(1 for e in entries if e.get('a'))
    print(f'entries={len(entries)} with_abbr={with_abbr} with_definition={with_def} '
          f'swedish={sv_hits} aliases={alias_hits}')


if __name__ == '__main__':
    main(*sys.argv[1:])
