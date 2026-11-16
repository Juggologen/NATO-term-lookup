/* NATO Term Lookup - offline abbreviation and term reference.
   No dependencies, no network calls beyond this app's own files. */
(function () {
  'use strict';

  var MAX_RESULTS = 60;
  var els = {
    abbr:    document.getElementById('q-abbr'),
    text:    document.getElementById('q-text'),
    results: document.getElementById('results'),
    count:   document.getElementById('count'),
    empty:   document.getElementById('empty'),
    clear:   document.getElementById('clear'),
    theme:   document.getElementById('theme'),
    status:  document.getElementById('status'),
    srcBtn:     document.getElementById('src-btn'),
    srcSummary: document.getElementById('src-summary'),
    srcPanel:   document.getElementById('src-panel'),
    srcSearch:  document.getElementById('src-search'),
    srcList:    document.getElementById('src-list'),
    srcEmpty:   document.getElementById('src-empty'),
    srcAll:     document.getElementById('src-all'),
    srcNone:    document.getElementById('src-none')
  };

  /* ---------------- theme ---------------- */

  function systemDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || t === 'light' ? t : (systemDark() ? 'dark' : 'light');
  }
  els.theme.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
  });

  /* ---------------- text helpers ---------------- */

  var TOKEN = /[a-z0-9]+/g;

  function fold(s) {
    return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
            .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
            .toLowerCase();
  }
  function tokens(s) {
    return fold(s).match(TOKEN) || [];
  }
  function normAbbr(s) {
    return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /* ---------------- index ---------------- */

  var entries = [];
  var publications = {};
  var sources = [];
  var selected = Object.create(null);
  var selectedCount = 0;
  var postings = Object.create(null);  // token -> [idx, weight, idx, weight, ...]
  var vocab = [];                      // sorted tokens, for prefix expansion
  var idf = Object.create(null);
  var foldedTerm = [];
  var foldedBody = [];
  var abbrKeys = [];                   // normalised abbreviation + variants per entry

  /* Short, high-signal fields are scored separately from long prose, so a
     two-word term that matches beats a long definition that happens to
     contain several of the query words. */
  var F_TERM = [['t', 3], ['k', 2.6], ['sv', 2.6], ['alt', 2], ['v', 2]];
  var F_BODY = [['d', 1], ['d2', 1], ['n', 1.2]];

  var pTerm = Object.create(null);
  var pBody = Object.create(null);
  var termLen = [], bodyLen = [], avgBody = 1;

  var STOP = (function () {
    var set = Object.create(null);
    var words = ('a an the and or of to in on at for from by with as is are was were be been ' +
      'being that this these those it its which who whom what when where how why do does did ' +
      'done not no any all such other than then there their them they you your we our us i ' +
      'can could will would shall should may might must into over under about between within ' +
      'during after before more most some each both one two ' +
      'och att som for en ett av pa till med vad ska man den det de har ar kan vid om').split(' ');
    for (var i = 0; i < words.length; i++) set[words[i]] = 1;
    return set;
  })();

  function collect(e, fields) {
    var seen = Object.create(null);
    for (var f = 0; f < fields.length; f++) {
      var val = e[fields[f][0]], weight = fields[f][1];
      if (!val) continue;
      var toks = tokens(Array.isArray(val) ? val.join(' ') : val);
      for (var k = 0; k < toks.length; k++) {
        var t = toks[k];
        if (seen[t] === undefined || seen[t] < weight) seen[t] = weight;
      }
    }
    return seen;
  }

  function addTo(map, tok, i, w) {
    var p = map[tok];
    if (p === undefined) { map[tok] = [i, w]; return; }
    var n = p.length;
    if (p[n - 2] === i) { if (w > p[n - 1]) p[n - 1] = w; } else { p.push(i, w); }
  }

  function buildIndex() {
    var df = Object.create(null);
    var bodyTotal = 0;

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var tSeen = collect(e, F_TERM);
      var bSeen = collect(e, F_BODY);
      var tc = 0, bc = 0, tok;

      for (tok in tSeen) { addTo(pTerm, tok, i, tSeen[tok]); tc++; df[tok] = (df[tok] || 0) + 1; }
      for (tok in bSeen) {
        addTo(pBody, tok, i, bSeen[tok]);
        bc++;
        if (tSeen[tok] === undefined) df[tok] = (df[tok] || 0) + 1;
      }
      termLen[i] = tc || 1;
      bodyLen[i] = bc;
      bodyTotal += bc;

      foldedTerm[i] = fold(e.t || '');
      foldedBody[i] = fold([e.d || '', (e.d2 || []).join(' '), (e.n || []).join(' '),
                            (e.sv || []).join(' '), (e.k || []).join(' ')].join(' '));

      var keys = [];
      if (e.a) keys.push(normAbbr(e.a));
      if (e.v) for (var vi = 0; vi < e.v.length; vi++) keys.push(normAbbr(e.v[vi]));
      abbrKeys[i] = keys;

      /* How well attested a sense is: whether it carries a definition and how
         many publications use it. Breaks ties between senses of the same
         abbreviation so the one in current use comes first. */
      prominence[i] = (e.d ? 1 : 0) + (e.p ? e.p.length : 0);
    }

    avgBody = Math.max(1, bodyTotal / entries.length);
    var n = entries.length;
    var marks = Object.create(null);
    for (var tk in df) {
      idf[tk] = Math.log(1 + (n - df[tk] + 0.5) / (df[tk] + 0.5));
      marks[tk] = 1;
    }
    for (var vt in marks) vocab.push(vt);
    vocab.sort();
    buildStems();
  }

  /* prefix range in the sorted vocabulary */
  function prefixRange(pfx) {
    var lo = 0, hi = vocab.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (vocab[m] < pfx) lo = m + 1; else hi = m; }
    var start = lo;
    hi = vocab.length;
    while (lo < hi) {
      var m2 = (lo + hi) >> 1;
      if (vocab[m2].lastIndexOf(pfx, 0) === 0) lo = m2 + 1; else hi = m2;
    }
    return [start, lo];
  }

  /* ---------------- source filter ---------------- */

  var SRC_META = {
    'AAP-15': 'Glossary of abbreviations',
    'AAP-06': 'Glossary of terms and definitions',
    'AJP': 'Any Allied Joint Publication',
    'COMMON': 'Common usage, not an official source'
  };

  function buildSources() {
    var counts = Object.create(null);
    var anyAjp = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      counts[e.s] = (counts[e.s] || 0) + 1;
      if (e.p) {
        anyAjp++;
        for (var j = 0; j < e.p.length; j++) {
          counts[e.p[j]] = (counts[e.p[j]] || 0) + 1;
        }
      } else if (e.s === 'AJP') {
        anyAjp++;
      }
    }
    sources = [];
    ['AAP-15', 'AAP-06', 'COMMON'].forEach(function (id) {
      if (counts[id]) {
        sources.push({ id: id, code: id === 'COMMON' ? 'Common' : id,
                       name: SRC_META[id], count: counts[id], group: 'glossary' });
      }
    });
    sources.push({ id: 'AJP', code: 'AJP', name: SRC_META.AJP,
                   count: anyAjp, group: 'glossary' });
    var codes = Object.keys(publications).sort(function (a, b) {
      return a.localeCompare(b, 'en', { numeric: true });
    });
    for (var c = 0; c < codes.length; c++) {
      sources.push({ id: codes[c], code: codes[c], name: publications[codes[c]],
                     count: counts[codes[c]] || 0, group: 'ajp' });
    }
    renderSources('');
  }

  function renderSources(query) {
    var q = fold(query).trim();
    var frag = document.createDocumentFragment();
    var shown = 0, lastGroup = null;
    for (var i = 0; i < sources.length; i++) {
      var sc = sources[i];
      if (q && fold(sc.code + ' ' + sc.name).indexOf(q) === -1) continue;
      if (sc.group !== lastGroup && sc.group === 'ajp') {
        var sep = el('li', 'src-sep', 'Allied Joint Publications');
        frag.appendChild(sep);
      }
      lastGroup = sc.group;
      var li = el('li');
      var lab = el('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.value = sc.id;
      box.checked = !!selected[sc.id];
      lab.appendChild(box);
      lab.appendChild(el('span', 'src-code', sc.code));
      lab.appendChild(el('span', 'src-name', sc.name));
      lab.appendChild(el('span', 'src-count', String(sc.count)));
      li.appendChild(lab);
      frag.appendChild(li);
      shown++;
    }
    els.srcList.textContent = '';
    els.srcList.appendChild(frag);
    els.srcEmpty.hidden = shown > 0;
  }

  function summarise() {
    if (!selectedCount) {
      els.srcSummary.textContent = 'All sources';
      els.srcBtn.classList.remove('on');
      return;
    }
    var names = [];
    for (var i = 0; i < sources.length && names.length < 2; i++) {
      if (selected[sources[i].id]) names.push(sources[i].code);
    }
    var text = names.join(', ');
    if (selectedCount > names.length) text += ' +' + (selectedCount - names.length);
    els.srcSummary.textContent = text;
    els.srcBtn.classList.add('on');
  }

  function inSelectedSources(e) {
    if (!selectedCount) return true;
    if (selected.AJP && (e.s === 'AJP' || e.p)) return true;
    if (selected[e.s]) return true;
    if (e.p) {
      for (var i = 0; i < e.p.length; i++) if (selected[e.p[i]]) return true;
    }
    return false;
  }

  function openPanel(open) {
    els.srcPanel.hidden = !open;
    els.srcBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      renderSources(els.srcSearch.value);
      els.srcSearch.focus();
      els.srcSearch.select();
    }
  }

  els.srcBtn.addEventListener('click', function () {
    openPanel(els.srcPanel.hidden);
  });
  els.srcSearch.addEventListener('input', function () {
    renderSources(els.srcSearch.value);
  });
  els.srcList.addEventListener('change', function (ev) {
    var box = ev.target;
    if (!box || box.type !== 'checkbox') return;
    if (box.checked) {
      if (!selected[box.value]) { selected[box.value] = true; selectedCount++; }
    } else if (selected[box.value]) {
      delete selected[box.value];
      selectedCount--;
    }
    summarise();
    run();
  });
  els.srcAll.addEventListener('click', function () {
    selected = Object.create(null);
    selectedCount = 0;
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].id === 'AJP') continue;      /* implied by the individual ones */
      selected[sources[i].id] = true;
      selectedCount++;
    }
    renderSources(els.srcSearch.value);
    summarise();
    run();
  });
  els.srcNone.addEventListener('click', function () {
    selected = Object.create(null);
    selectedCount = 0;
    renderSources(els.srcSearch.value);
    summarise();
    run();
  });
  document.addEventListener('click', function (ev) {
    if (els.srcPanel.hidden) return;
    if (els.srcPanel.contains(ev.target) || els.srcBtn.contains(ev.target)) return;
    openPanel(false);
  });

  /* ---------------- search ---------------- */

  /* Light suffix stripping: enough to bridge "organised"/"organisation",
     "economically"/"economic", "bombs"/"bomb". Not linguistically exact; it
     only has to map related words onto the same key. */
  function stem(tok) {
    if (tok.length < 5) return tok;
    var s = tok;
    s = s.replace(/(isation|ization|ational)$/, '');
    if (s.length >= 6) s = s.replace(/(ally|fully)$/, '');
    if (s.length >= 6) s = s.replace(/(ation|ement|ness|ment|ance|ence|ible|able)$/, '');
    if (s.length >= 5) s = s.replace(/(ingly|edly|ly)$/, '');
    if (s.length >= 5) s = s.replace(/ies$/, 'i');
    if (s.length >= 6) s = s.replace(/(ing|ers|er|ed)$/, '');
    if (s.length >= 5) s = s.replace(/(ses|xes|ches|shes)$/, '');
    if (s.length >= 4) s = s.replace(/([^s])s$/, '$1');
    s = s.replace(/([bdfglmnprt])\1$/, '$1');     /* controll -> control */
    s = s.replace(/e$/, '');
    return s.length >= 3 ? s : tok;
  }

  var stemMap = Object.create(null);
  var prominence = [];

  function buildStems() {
    for (var i = 0; i < vocab.length; i++) {
      var st = stem(vocab[i]);
      var fam = stemMap[st];
      if (fam) fam.push(vocab[i]); else stemMap[st] = [vocab[i]];
    }
  }

  function searchText(query, scores, touched) {
    var raw = tokens(query);
    if (!raw.length) return 0;
    var qt = [];
    for (var z = 0; z < raw.length; z++) if (!STOP[raw[z]]) qt.push(raw[z]);
    if (!qt.length) qt = raw;
    if (qt.length > 31) qt = qt.slice(0, 31);
    var folded = fold(query).trim();

    var sTerm = termScratch, sBody = bodyScratch;

    for (var i = 0; i < qt.length; i++) {
      var tok = qt[i];
      var isLast = (i === qt.length - 1);
      var cand = Object.create(null);
      function offer(term, damp) {
        if (idf[term] === undefined) return;
        if (cand[term] === undefined || cand[term] < damp) cand[term] = damp;
      }
      offer(tok, 1);
      var fam = stemMap[stem(tok)];
      if (fam) for (var fi = 0; fi < fam.length; fi++) offer(fam[fi], 0.8);
      if (isLast && tok.length >= 2) {
        var r = prefixRange(tok);
        if (r[1] - r[0] > 0 && r[1] - r[0] <= 400) {
          for (var v = r[0]; v < r[1]; v++) offer(vocab[v], 0.5);
        }
      }
      /* Long compound with no hit at all (common in Swedish): fall back to the
         longest prefix that exists in the vocabulary. */
      var any = false;
      for (var ck in cand) { any = true; break; }
      if (!any && tok.length >= 7) {
        for (var L = tok.length - 1; L >= 6; L--) {
          var r3 = prefixRange(tok.slice(0, L));
          if (r3[1] > r3[0] && r3[1] - r3[0] <= 200) {
            for (var v3 = r3[0]; v3 < r3[1]; v3++) offer(vocab[v3], 0.35);
            break;
          }
        }
      }
      var matches = [];
      for (var cw in cand) matches.push([cw, cand[cw]]);
      for (var m = 0; m < matches.length; m++) {
        var mt = matches[m][0], damp = matches[m][1], w = idf[mt] * damp;
        var bit = 1 << i;
        var pt = pTerm[mt];
        if (pt) for (var a = 0; a < pt.length; a += 2) {
          var ia = pt[a];
          if (hitGen[ia] !== gen) { hitGen[ia] = gen; hits[ia] = 0; sTerm[ia] = 0; sBody[ia] = 0; touched.push(ia); }
          sTerm[ia] += pt[a + 1] * w / Math.sqrt(termLen[ia]);
          hits[ia] |= bit;
        }
        var pb = pBody[mt];
        if (pb) for (var b = 0; b < pb.length; b += 2) {
          var ib = pb[b];
          if (hitGen[ib] !== gen) { hitGen[ib] = gen; hits[ib] = 0; sTerm[ib] = 0; sBody[ib] = 0; touched.push(ib); }
          sBody[ib] += pb[b + 1] * w / (0.45 + 0.55 * bodyLen[ib] / avgBody);
          hits[ib] |= bit;
        }
      }
    }

    for (var c = 0; c < touched.length; c++) {
      var e = touched[c];
      var bits = hits[e], covered = 0;
      for (var q = 0; q < qt.length; q++) if (bits & (1 << q)) covered++;
      var score = (3.2 * sTerm[e] + sBody[e]) * Math.pow(covered / qt.length, 1.6);
      if (folded.length >= 3) {
        if (foldedTerm[e] === folded) score += 90;
        else if (foldedTerm[e].indexOf(folded) !== -1) score += 34;
        else if (foldedBody[e].indexOf(folded) !== -1) score += 7;
      }
      scores[e] = score;
    }
    return qt.length;
  }

  function searchAbbr(query, scores, touched, textActive) {
    var q = normAbbr(query);
    if (!q) return 0;
    for (var i = 0; i < entries.length; i++) {
      var keys = abbrKeys[i], best = 0;
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k], s = 0;
        if (key === q) s = 1000;
        else if (key.lastIndexOf(q, 0) === 0) s = 600 - Math.min(90, (key.length - q.length) * 6);
        else if (q.length >= 3 && key.indexOf(q) !== -1) s = 260;
        if (k > 0 && s > 0) s -= 40;          /* variants rank just below */
        if (s > best) best = s;
      }
      if (best > 0) {
        if (scores[i] === 0 && !textActive) touched.push(i);
        if (textActive) { if (scores[i] > 0) scores[i] += best; else scores[i] = -1; }
        else scores[i] += best;
      } else if (textActive) {
        scores[i] = -1;                        /* drop: must satisfy both fields */
      }
    }
    return 1;
  }

  var scores = null, hits = null, hitGen = null, gen = 0;
  var termScratch = null, bodyScratch = null;

  function run() {
    var qa = els.abbr.value.trim();
    var qt = els.text.value.trim();
    els.clear.hidden = !(qa || qt);

    if (!qa && !qt) {
      /* With a source selected and nothing typed, list that source instead of
         showing the empty state - it makes the filter usable for browsing. */
      if (selectedCount && entries.length) {
        els.empty.hidden = true;
        var all = [];
        for (var b = 0; b < entries.length; b++) {
          if (inSelectedSources(entries[b])) all.push(b);
        }
        render(all, '', '');
        return;
      }
      els.results.textContent = '';
      els.count.textContent = '';
      els.empty.hidden = false;
      return;
    }
    els.empty.hidden = true;
    if (!entries.length) { els.count.textContent = 'Loading…'; return; }

    gen++;
    var touched = [];
    scores.fill(0);
    var textActive = qt.length > 0;
    if (textActive) searchText(qt, scores, touched);
    if (qa) searchAbbr(qa, scores, touched, textActive);

    var out = [];
    for (var i = 0; i < touched.length; i++) {
      var idx = touched[i];
      if (scores[idx] > 0 && inSelectedSources(entries[idx])) out.push(idx);
    }
    if (!textActive && qa) {
      /* searchAbbr pushed its own matches */
    }
    out.sort(function (a, b) {
      var d = scores[b] - scores[a];
      if (d) return d;
      var la = (entries[a].a || '').length, lb = (entries[b].a || '').length;
      if (la !== lb) return la - lb;
      if (prominence[b] !== prominence[a]) return prominence[b] - prominence[a];
      return (entries[a].t || '').localeCompare(entries[b].t || '');
    });

    render(out, qa, qt);
  }

  /* ---------------- rendering ---------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function highlight(text, terms) {
    var frag = document.createDocumentFragment();
    if (!terms.length || !text) { frag.appendChild(document.createTextNode(text || '')); return frag; }
    var folded = fold(text);
    var marks = [];
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      if (t.length < 2) continue;
      var from = 0, at;
      while ((at = folded.indexOf(t, from)) !== -1) {
        var prev = at === 0 ? '' : folded.charAt(at - 1);
        if (prev === '' || !/[a-z0-9]/.test(prev)) marks.push([at, at + t.length]);
        from = at + t.length;
        if (marks.length > 60) break;
      }
    }
    if (!marks.length) { frag.appendChild(document.createTextNode(text)); return frag; }
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [marks[0]];
    for (var m = 1; m < marks.length; m++) {
      var last = merged[merged.length - 1];
      if (marks[m][0] <= last[1]) last[1] = Math.max(last[1], marks[m][1]);
      else merged.push(marks[m]);
    }
    var pos = 0;
    for (var k = 0; k < merged.length; k++) {
      if (merged[k][0] > pos) frag.appendChild(document.createTextNode(text.slice(pos, merged[k][0])));
      var mk = document.createElement('mark');
      mk.textContent = text.slice(merged[k][0], merged[k][1]);
      frag.appendChild(mk);
      pos = merged[k][1];
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    return frag;
  }

  var SRC_LABEL = { 'AAP-15': 'AAP-15', 'AAP-06': 'AAP-06',
                    'AJP': 'AJP lexicon', 'COMMON': 'Common usage' };

  function card(e, terms) {
    var box = el('article', 'entry');
    var head = el('div', 'entry-head');
    if (e.a) head.appendChild(el('span', 'abbr', e.a));
    var term = el('span', 'term');
    term.appendChild(highlight(e.t || '', terms));
    head.appendChild(term);
    box.appendChild(head);

    if (e.r) {
      var red = el('p', 'def');
      red.appendChild(document.createTextNode('Deprecated form — use '));
      red.appendChild(el('strong', null, e.r));
      red.appendChild(document.createTextNode('.'));
      box.appendChild(red);
    }
    if (e.d) {
      var d = el('p', 'def');
      d.appendChild(highlight(e.d, terms));
      box.appendChild(d);
    }
    if (e.d2) for (var i2 = 0; i2 < e.d2.length; i2++) {
      var d2 = el('p', 'def');
      d2.appendChild(highlight(e.d2[i2], terms));
      box.appendChild(d2);
    }
    if (e.n) for (var n2 = 0; n2 < e.n.length; n2++) {
      var nn = el('p', 'note');
      nn.appendChild(highlight(e.n[n2], terms));
      box.appendChild(nn);
    }
    if (e.sv) {
      var sv = el('p', 'sv');
      sv.appendChild(el('b', null, 'SV '));
      sv.appendChild(highlight(e.sv.join(', '), terms));
      box.appendChild(sv);
    }
    var meta = el('p', 'meta');
    if (e.alt) meta.appendChild(el('span', 'tag tag-also', 'also: ' + e.alt.join('; ')));
    if (e.v) meta.appendChild(el('span', 'tag tag-also', 'form: ' + e.v.join(', ')));
    if (e.g) for (var g = 0; g < e.g.length; g++) {
      meta.appendChild(el('span', 'tag tag-flag', e.g[g]));
    }
    meta.appendChild(el('span', 'tag tag-src' + (e.s === 'COMMON' ? ' tag-common' : ''),
                        SRC_LABEL[e.s] || e.s));
    if (e.p) {
      for (var pi = 0; pi < Math.min(e.p.length, 3); pi++) {
        meta.appendChild(el('span', 'tag tag-pub', e.p[pi]));
      }
      if (e.p.length > 3) {
        meta.appendChild(el('span', 'tag tag-pub', '+' + (e.p.length - 3)));
      }
    }
    if (e.y) meta.appendChild(el('span', null, e.y));
    box.appendChild(meta);
    return box;
  }

  function render(list, qa, qt) {
    var terms = tokens(qt);
    if (qa) terms = terms.concat([fold(qa)]);
    var frag = document.createDocumentFragment();
    var shown = Math.min(list.length, MAX_RESULTS);
    for (var i = 0; i < shown; i++) frag.appendChild(card(entries[list[i]], terms));
    els.results.textContent = '';
    els.results.appendChild(frag);

    var within = selectedCount ? ' in the selected source' + (selectedCount > 1 ? 's' : '') : '';
    if (!list.length) {
      els.count.textContent = 'No match' + within + '.';
      els.results.appendChild(el('p', 'empty', selectedCount
        ? 'Nothing found in the selected sources. Widen the source filter, or try fewer words.'
        : 'Nothing found. Try fewer words, or the other field.'));
    } else if (list.length > shown) {
      els.count.textContent = 'Showing ' + shown + ' of ' +
        list.length.toLocaleString('en-GB') + (within || ' matches');
    } else {
      els.count.textContent = list.length +
        (list.length === 1 ? ' match' : ' matches') + within;
    }
  }

  /* ---------------- wiring ---------------- */

  var pending = 0;
  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(run, 70);
  }
  els.abbr.addEventListener('input', schedule);
  els.text.addEventListener('input', schedule);

  els.clear.addEventListener('click', function () {
    els.abbr.value = '';
    els.text.value = '';
    run();
    els.abbr.focus();
  });

  els.empty.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.abbr) { els.abbr.value = b.dataset.abbr; els.text.value = ''; }
    else { els.text.value = b.dataset.text; els.abbr.value = ''; }
    run();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !els.srcPanel.hidden) {
      openPanel(false);
      els.srcBtn.focus();
      return;
    }
    if (ev.key === 'Escape') {
      if (document.activeElement === els.abbr || document.activeElement === els.text) {
        document.activeElement.value = '';
        run();
      }
      return;
    }
    if (ev.key === '/' && document.activeElement !== els.abbr && document.activeElement !== els.text) {
      ev.preventDefault();
      els.abbr.focus();
    }
  });

  /* ---------------- load ---------------- */

  fetch('data/terms.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      entries = data.entries;
      publications = data.publications || {};
      scores = new Float64Array(entries.length);
      hits = new Int32Array(entries.length);
      hitGen = new Int32Array(entries.length);
      termScratch = new Float64Array(entries.length);
      bodyScratch = new Float64Array(entries.length);
      buildIndex();
      buildSources();
      els.status.textContent = entries.length.toLocaleString('en-GB') + ' entries loaded · built ' + data.generated;
      run();
    })
    .catch(function (err) {
      els.status.textContent = 'Could not load the terminology file (' + err.message + ').';
      els.count.textContent = '';
    });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline use unavailable */ });
    });
  }
})();
