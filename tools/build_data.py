#!/usr/bin/env python3
"""Merge the parsed glossaries into the dataset the app ships.

Sources, in order of authority:
  AAP-15  abbreviation -> full form   (NATOTerm extract)
  AAP-06  term -> definition
  AJP-*   the Lexicon of each Allied Joint Publication, which carries the
          doctrine and planning vocabulary the two glossaries omit
  COMMON  a short hand-written list of abbreviations in wide use that none
          of the official sources contain

Where an AAP-15 full form matches an AAP-06 term, the definition is attached
to the abbreviation. AJP entries that merely repeat an AAP entry are not
duplicated; the publication reference is added to the existing entry instead.
"""
import json
import re
import sys
import unicodedata

PUNCT_RE = re.compile(r'[^\w\s]', re.U)
SPACE_RE = re.compile(r'\s+')
SENSE_RE = re.compile(r'\s+\d+$')


def norm(text):
    if not text:
        return ''
    text = unicodedata.normalize('NFKD', text.lower())
    text = ''.join(c for c in text if not unicodedata.combining(c))
    return SPACE_RE.sub(' ', PUNCT_RE.sub(' ', text)).strip()


def key(text):
    return SENSE_RE.sub('', norm(text))


def stem_word(w):
    for suf in ('ational', 'isation', 'ization', 'ing', 'ed', 'es', 's'):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            return w[:-len(suf)]
    return w


def skey(text):
    """A loose key so 'air task order' and 'air tasking order' collapse."""
    return ' '.join(sorted(stem_word(w) for w in key(text).split()))


def attach(entries, spec, field, value_key):
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


def main(aap15_path, aap06_path, ajp_path, out_path,
         sv_path=None, supp_path=None, alias_path=None):
    a15 = json.load(open(aap15_path, encoding='utf-8'))
    a06 = json.load(open(aap06_path, encoding='utf-8'))
    ajp = json.load(open(ajp_path, encoding='utf-8')) if ajp_path else []
    sv = json.load(open(sv_path, encoding='utf-8')) if sv_path else {}
    supp = json.load(open(supp_path, encoding='utf-8')) if supp_path else {'entries': []}
    aliases = json.load(open(alias_path, encoding='utf-8')) if alias_path else {}

    defs = {}
    for r in a06:
        defs.setdefault(key(r['en']), []).append(r)

    redirects = [r for r in a15 if r.get('redirect') and not r['en']]
    a15 = [r for r in a15 if r['en']]

    entries, seen, used = [], set(), set()
    for r in a15:
        abbr = r['abbr']
        variants = list(r['variants'])
        # Entries sorted under the French abbreviation carry it as the headword.
        # This app ships English only, so promote the English abbreviation and
        # drop the French one.
        if r.get('status') != 'NATO Agreed' and r.get('en_abbr'):
            abbr = r['en_abbr']
            variants = [v for v in variants
                        if v != r['en_abbr'] and v != r['abbr']]
        sig = (abbr, norm(r['en']))
        if sig in seen:
            continue
        seen.add(sig)
        e = {'a': abbr, 't': r['en']}
        k = key(r['en'])
        match = defs.get(k)
        if match:
            e['d'] = match[0]['definition']
            used.add(k)
            if len(match) > 1:
                e['d2'] = [m['definition'] for m in match[1:]]
        if variants:
            e['v'] = variants
        if r['en_alts']:
            e['alt'] = r['en_alts']
        if r['en_notes']:
            notes = [re.sub(r'^Note\(s\):\s*', '', n) for n in r['en_notes']]
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
        entries.append({'a': r['abbr'],
                        't': target_terms.get(r['redirect'], r['redirect']),
                        'r': r['redirect'],
                        'g': r['flags'] or ['deprecated'],
                        's': 'AAP-15'})

    for r in a06:
        k = key(r['en'])
        if k in used:
            continue
        used.add(k)
        e = {'a': r.get('abbr'), 't': r['en'], 'd': r['definition'], 's': 'AAP-06'}
        if r['flags']:
            e['g'] = r['flags']
        if r['date']:
            e['y'] = r['date'].replace('.', '-')
        entries.append(e)

    # ---- Allied Joint Publication lexicons ----
    by_abbr = {}
    for e in entries:
        if e.get('a'):
            by_abbr.setdefault(e['a'].upper(), []).append(e)
    by_term = {}
    for e in entries:
        by_term.setdefault(skey(e['t']), []).append(e)

    ajp_abbr, ajp_term = {}, {}
    for pub in ajp:
        code = pub['code']
        for a in pub['abbreviations']:
            ajp_abbr.setdefault((a['abbr'].upper(), skey(a['full'])),
                                {'abbr': a['abbr'], 'full': a['full'], 'codes': []}
                                )['codes'].append(code)
        for t in pub['terms']:
            ajp_term.setdefault(skey(t['term']),
                                {'term': t['term'], 'definition': t['definition'],
                                 'status': t['status'], 'codes': []}
                                )['codes'].append(code)

    added_abbr = reffed_abbr = 0
    for (up, sk), rec in sorted(ajp_abbr.items()):
        hit = None
        for e in by_abbr.get(up, []):
            if skey(e['t']) == sk:
                hit = e
                break
        if hit is not None:
            hit.setdefault('p', [])
            for c in rec['codes']:
                if c not in hit['p']:
                    hit['p'].append(c)
            reffed_abbr += 1
            continue
        e = {'a': rec['abbr'], 't': rec['full'], 's': 'AJP', 'p': sorted(set(rec['codes']))}
        tmatch = by_term.get(sk)
        if tmatch and tmatch[0].get('d'):
            e['d'] = tmatch[0]['d']
        entries.append(e)
        by_abbr.setdefault(up, []).append(e)
        added_abbr += 1

    added_term = reffed_term = 0
    for sk, rec in sorted(ajp_term.items()):
        hit = next((e for e in by_term.get(sk, []) if e.get('d')), None)
        if hit is not None:
            hit.setdefault('p', [])
            for c in rec['codes']:
                if c not in hit['p']:
                    hit['p'].append(c)
            reffed_term += 1
            continue
        e = {'a': None, 't': rec['term'], 'd': rec['definition'],
             's': 'AJP', 'p': sorted(set(rec['codes']))}
        if rec['status'] and 'nato agreed' not in rec['status'].lower():
            e['g'] = ['publication-specific']
        entries.append(e)
        by_term.setdefault(sk, []).append(e)
        added_term += 1

    # The supplementary list only fills gaps; drop anything the official
    # sources now cover.
    supp_kept = supp_dropped = 0
    for r in supp.get('entries', []):
        up, sk = (r.get('a') or '').upper(), skey(r['t'])
        if any(skey(x['t']) == sk for x in by_abbr.get(up, [])):
            supp_dropped += 1
            continue
        e = dict(r)
        e['s'] = 'COMMON'
        entries.append(e)
        by_abbr.setdefault(up, []).append(e)
        supp_kept += 1

    sv_hits = attach(entries, sv, 'sv', 'sv')
    alias_hits = attach(entries, aliases, 'k', 'k')

    # Short, human titles for the publication filter, e.g.
    # "Allied Joint Doctrine for Air and Space Operations (AJP-3.3)"
    # -> "Air and Space Operations"
    pubs = {}
    for pub in ajp:
        title = re.sub(r'\s*\(AJP-[0-9.]+\)\s*$', '', pub['title']).strip()
        short = re.sub(r'^Allied Joint Doctrine for (the )?', '', title).strip()
        if not short or short.lower() == 'allied joint doctrine':
            short = title
        pubs[pub['code']] = short[:1].upper() + short[1:]

    entries.sort(key=lambda e: (norm(e['a'] or e['t']), norm(e['t'])))
    payload = {
        'generated': '2026-11-16',
        'sources': [
            {'id': 'AAP-15', 'title': 'NATO Glossary of Abbreviations used in NATO '
                                      'Documents and Publications',
             'note': 'NATOTerm extract, 15 April 2026'},
            {'id': 'AAP-06', 'title': 'NATO Glossary of Terms and Definitions',
             'note': 'Edition 2019'},
            {'id': 'AJP', 'title': 'Allied Joint Publication lexicons',
             'note': '32 publications, current editions'},
        ],
        'publications': pubs,
        'entries': entries,
    }
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(',', ':'))

    print(f'entries={len(entries)} '
          f'with_abbr={sum(1 for e in entries if e.get("a"))} '
          f'with_definition={sum(1 for e in entries if e.get("d"))}')
    print(f'  AJP: new abbreviations={added_abbr} new terms={added_term} '
          f'cross-referenced onto existing={reffed_abbr + reffed_term}')
    print(f'  supplementary: kept={supp_kept} dropped_as_covered={supp_dropped}')
    print(f'  keywords: swedish={sv_hits} aliases={alias_hits}')


if __name__ == '__main__':
    main(*sys.argv[1:])
