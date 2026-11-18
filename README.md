# NATO Term Lookup

A quick-reference for NATO abbreviations and terms, built to answer two questions fast:

- **What does this abbreviation mean?** Type `OPORD`, get *operation order*.
- **What is this thing called?** Type *order telling units what to do*, get `OPORD`.

It is a single static page. Once loaded it makes **no network requests at all** —
every search runs against a terminology file held in the browser. Install it on a
phone and it works with no signal.

## Using it

| Field | What to type | What you get |
| --- | --- | --- |
| **Abbreviation** | `CIMIC`, `rOE`, partial forms like `MEDE` | Every sense of that abbreviation, exact matches first |
| **Term or description** | The proper term, or plain words | Ranked candidate entries, abbreviations first |

A description search returns two kinds of entry, and keeps them apart under
their own headings: **Abbreviations** first, then **Terms** — glossary entries
that carry no abbreviation. Each heading shows how many that group holds. Part
of the on-screen limit is reserved for the terms, so a long run of
abbreviations cannot push them off the page.

Fill in both fields to narrow results to entries matching both. `/` jumps to the
abbreviation field, `Esc` clears the focused field. The theme follows the
operating system and the toggle overrides it.

### Filtering by source

The **Source** field, the third control next to the two search boxes, opens a
checkbox list of all 35 sources — the three glossaries plus each of the 32 Allied Joint Publications.
Tick as many as you like; results are limited to entries that come from, or are
referenced by, those sources.

The list has its own search box, which matches both the code and the subject, so
typing `air` finds AJP-3.3 (Air and Space Operations), AJP-3.3.5 (Airspace
Control) and AJP-10.3, and typing `targeting` finds AJP-3.9. Each row shows how
many entries that source contributes. **Any Allied Joint Publication** matches
anything with a doctrine reference.

With a source ticked and both search fields empty, the app lists that source's
vocabulary instead of the empty state, so you can browse a publication's lexicon
end to end. The filter resets when you reload the page — it is deliberately not
remembered, so you never search a narrowed set without noticing.

### Installing on a phone

Open the page, then *Add to Home Screen* (iOS Safari) or *Install app*
(Android Chrome). A service worker caches the whole app, so it opens and
searches offline.

## What is in the data

`data/terms.json` holds **8,005 entries** from three published NATO sources.

| Source | Content | Entries |
| --- | --- | --- |
| **AAP-15** — NATO Glossary of Abbreviations used in NATO Documents and Publications | Abbreviation → full form | 4,517 |
| **AAP-06** — NATO Glossary of Terms and Definitions (2019) | Term → definition | 2,507 |
| **AJP lexicons** — the Lexicon of 32 Allied Joint Publications, current editions | Doctrine abbreviations and terms | 971 |

5,250 entries carry an abbreviation and 3,188 carry a definition.

The two AAP glossaries are published by the NATO Standardization Office. The
AAP-15 content is a NATOTerm extract dated 15 April 2026; AAP-06 ceased
publication as a bilingual Allied publication in 2022, so the 2019 edition is
the last full one and some definitions are older than the abbreviation list.

**The AJP lexicons matter.** The AAP glossaries do not carry most operational
planning vocabulary — MAOP, AOD, GAT, JPTL, JTL, NSL, TNL, CPOE and COPD are all
absent from AAP-15. They live in the lexicons of the Allied Joint Publications,
which is where this build gets them: 725 abbreviations and 248 terms that appear
in no AAP glossary. A further 608 AAP entries gained a publication reference,
shown on the card as tags like `AJP-3.3`, so you can see which doctrine uses a
term and how widely.

Where an AAP-15 full form matches an AAP-06 term, the definition is attached to
the abbreviation. 145 deprecated abbreviations are kept as cross-references
("use X instead").

When an abbreviation has several meanings, the senses are ordered by how well
attested they are — whether a definition exists and how many publications use
it — so `GAT` gives *guidance, apportionment and targeting* before *general air
traffic*, and `CP` gives *command post* first.

The app is English only. AAP-15 is a bilingual source and entries sorted under
the French abbreviation are re-keyed to their English abbreviation on build, so
`GAT` is the headword rather than the French `CAG`.

### Unofficial additions

Two small layers are **not** NATO terminology. They exist so the search can be
driven in everyday language, and the app labels them:

- `data/supplementary.json` — abbreviations in common use that none of the
  official sources contain (NOTAM, UAV, WARNO and similar). Shown with a
  **Common usage** tag. Entries here are dropped automatically if a source
  later covers them, which is what happened to IFF, LNO, LOGREP, PSYOPS,
  STRATCOM and UAS once the AJP lexicons were added — 8 remain.
- `data/aliases.json` — plain-language English phrases ("roadside bomb" → IED)
  for 93 entries. Used for searching only; not displayed.

Both are plain JSON and are meant to be extended — see below.

## How well does the description search work?

Looking up an abbreviation, or a term by its proper name, is reliable.

Finding an entry from a *paraphrase* is ordinary keyword search with stemming
and a hand-written keyword layer, not a language model. On a sample of
descriptions phrased without reference to the entry's own wording, the intended
entry came first about half the time. When a description fails, the fix is to
add the phrasing to `data/aliases.json` and rebuild — which is why that file
exists.

## Extending the keyword layers

Both keyword files use the same shape. `abbr` is keyed by abbreviation; add
`"en"` to bind the keywords to one sense when an abbreviation has several.
`term` is keyed by an English term.

```json
{
  "abbr": {
    "ROE": [{ "k": ["when soldiers may open fire", "use of force rules"] }],
    "AD":  [{ "en": "air defence", "k": ["anti aircraft"] }]
  },
  "term": {
    "centre of gravity": ["source of strength"]
  }
}
```

Diacritics are optional: search folds `å ä ö é` to their base letters, so
*résumé* and *resume* both match.

After editing, rebuild `data/terms.json`:

```bash
python3 tools/build_data.py parsed/aap15.json parsed/aap06.json parsed/ajp_lex.json \
        data/terms.json data/supplementary.json data/aliases.json
```

Then bump `CACHE` in `sw.js` so installed copies pick up the new file.

## Rebuilding from the source PDFs

`tools/` contains the full pipeline. It needs `poppler-utils` and Python 3.

```bash
pdftohtml -xml -i -stdout AAP-15.pdf > aap15.xml
pdftohtml -xml -i -stdout AAP-06.pdf > aap06.xml
python3 tools/parse_aap15.py aap15.xml parsed/aap15.json
python3 tools/parse_aap06.py aap06.xml parsed/aap06.json
```

The Allied Joint Publications are fetched from GOV.UK, which publishes the
current editions openly:

```bash
python3 tools/fetch_ajp.py parsed/ajp_manifest.json
python3 tools/parse_ajp.py pdfs/ parsed/ajp_manifest.json parsed/ajp_lex.json
```

Then merge everything:

```bash
python3 tools/build_data.py parsed/aap15.json parsed/aap06.json parsed/ajp_lex.json \
        data/terms.json data/supplementary.json data/aliases.json
```

The AAP-15 parser reads the PDF's typography rather than its text: bold marks a
headword, upright text is the entry's primary language and italic the secondary,
and the status line (`NATO Agreed` / `Agréé OTAN`) says which is which. Line
breaks are re-flowed using Helvetica metrics (`tools/helv.py`), so a wrapped
phrase can be told apart from a second synonym on its own line.

The AJP parser cannot rely on headings — publications word them differently
("Part 1 - Acronyms and abbreviations", "Acronyms, abbreviations, and
initialisms", or none at all) — so it locates the Lexicon by its title page and
classifies what follows by shape: a two-column line is an abbreviation, and a
block ending in `(NATO Agreed)` is a term and its definition.

## Layout

```
index.html      markup
styles.css      light/dark theming, no framework
app.js          index building, search, rendering
sw.js           offline cache
data/           terminology and the keyword layers
tools/          PDF parsers, the AJP fetcher and the dataset builder
```

No build step, no dependencies, no CDN. Everything the page loads is in this
repository.

## Licence and attribution

The code in this repository is MIT licensed — see `LICENSE`.

The terminology is NATO's. The Allied Joint Publications are Crown copyright
where published by the UK Ministry of Defence and are released for public use. NATO states that its terminology may be copied
without the express consent of the NATO Standardization Office provided NATO is
shown as the source; terminology NATO has taken from external sources may be
subject to third-party copyright. This is an unofficial aid and carries no
status — for anything authoritative, use NATOTerm and the current standards.
