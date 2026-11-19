/* NATO Term Lookup - offline abbreviation and term reference.
   No dependencies, no network calls beyond this app's own files.

   Three views live on one page, chosen by the hash route:
     #/          search      - one bar, abbreviation or definition
     #/lexicon   lexicon     - the same records, A to Z
     #/add       form        - add a term, kept in this browser
     #/edit/<id> form        - change one you added
*/
(function () {
  'use strict';

  var MAX_RESULTS = 60;
  var TERM_SLOTS = 20;    // of MAX_RESULTS, held back for entries with no abbreviation
  var LEX_PAGE = 120;     // lexicon entries drawn per step

  var els = {
    body:     document.body,
    main:     document.getElementById('main'),
    q:        document.getElementById('q'),
    mode:     document.getElementById('mode'),
    qClear:   document.getElementById('q-clear'),
    results:  document.getElementById('results'),
    count:    document.getElementById('count'),
    theme:    document.getElementById('theme'),
    status:   document.getElementById('status'),

    srcBtn:     document.getElementById('src-btn'),
    srcSummary: document.getElementById('src-summary'),
    srcPanel:   document.getElementById('src-panel'),
    srcSearch:  document.getElementById('src-search'),
    srcList:    document.getElementById('src-list'),
    srcEmpty:   document.getElementById('src-empty'),
    srcAll:     document.getElementById('src-all'),
    srcNone:    document.getElementById('src-none'),

    lexTitle:   document.getElementById('lex-title'),
    lexLetters: document.getElementById('lex-letters'),
    lexList:    document.getElementById('lex-list'),
    lexMore:    document.getElementById('lex-more'),

    formView: document.getElementById('form-view'),
    form:     document.getElementById('term-form'),
    fTitle:   document.getElementById('f-title'),
    fAbbr:    document.getElementById('f-abbr'),
    fTerm:    document.getElementById('f-term'),
    fDef:     document.getElementById('f-def'),
    fMsg:     document.getElementById('f-msg'),
    fSave:    document.getElementById('f-save'),
    fCancel:  document.getElementById('f-cancel'),

    dialog:    document.getElementById('confirm'),
    dlgTitle:  document.getElementById('confirm-title'),
    dlgText:   document.getElementById('confirm-text'),
    dlgOk:     document.getElementById('confirm-ok'),
    dlgCancel: document.getElementById('confirm-cancel'),

    localMsg: document.getElementById('local-msg')
  };

  var RELOAD_KEY = 'nato-lookup.reload';

  /* The markup and this script have to come from the same deploy. When a
     cache has mixed two of them every lookup above is null, the page looks
     right and nothing on it responds, and it stays that way on every later
     visit. Throw the cache away and come back once instead. */
  function recover(missing) {
    /* Once only. If the fresh copy is broken too, leave the page alone
       rather than reload for ever. */
    try {
      if (sessionStorage.getItem(RELOAD_KEY) === '1') return;
      sessionStorage.setItem(RELOAD_KEY, '1');
    } catch (e) {
      return;                      /* no session storage: do not risk a loop */
    }
    if (window.console) {
      console.warn('NATO Term Lookup: the page and the script are from ' +
                   'different versions (missing ' + missing.join(', ') + '). ' +
                   'Clearing the cache and reloading.');
    }
    var jobs = [];
    if (window.caches) {
      jobs.push(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }));
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }));
    }
    Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
  }

  var missing = [];
  for (var elKey in els) { if (!els[elKey]) missing.push(elKey); }
  if (missing.length) { recover(missing); return; }
  try { sessionStorage.removeItem(RELOAD_KEY); } catch (e) { /* private mode */ }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------------- theme ---------------- */

  function systemDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || t === 'light' ? t : (systemDark() ? 'dark' : 'light');
  }
  function labelTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    var text = 'Switch to the ' + next + ' theme';
    els.theme.setAttribute('aria-label', text);
    els.theme.setAttribute('title', text);
  }
  /* Carry the change across rather than cutting to it. The transition lives
     on a class so it is only ever on during the switch itself: left standing,
     it would slow every hover and fire once on first paint. */
  var themeTimer = 0;
  function crossfade() {
    if (window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var root = document.documentElement;
    root.classList.add('theming');
    /* Read a layout value to settle the style with the transition in place.
       Without it the class and the new theme land in one recalculation,
       there is no earlier state to move from, and the colours jump. */
    void root.offsetWidth;
    clearTimeout(themeTimer);
    themeTimer = setTimeout(function () { root.classList.remove('theming'); }, 360);
  }

  els.theme.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    crossfade();
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
    labelTheme();
  });
  labelTheme();

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
  var vocab = [];
  var idf = Object.create(null);
  var foldedTerm = [];
  var foldedBody = [];
  var abbrKeys = [];
  var prominence = [];
  var stemMap = Object.create(null);

  /* Short, high-signal fields are scored separately from long prose, so a
     two-word term that matches beats a long definition that happens to
     contain several of the query words. */
  var F_TERM = [['t', 3], ['k', 2.6], ['alt', 2], ['v', 2]];
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
      'during after before more most some each both one two').split(' ');
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
                            (e.k || []).join(' ')].join(' '));

      var keys = [];
      if (e.a) keys.push(normAbbr(e.a));
      if (e.v) for (var vi = 0; vi < e.v.length; vi++) keys.push(normAbbr(e.v[vi]));
      abbrKeys[i] = keys;

      /* How well attested a sense is: whether it carries a definition and how
         many publications use it. Breaks ties between senses of the same
         abbreviation so the one in current use comes first. */
      prominence[i] = (e.d ? 1 : 0) + (e.p ? e.p.length : 0) +
                      (e.s === 'OTHER' || e.s === 'LOCAL' ? 2 : 0);
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
    buildLexicon();
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
    'COMMON': 'Common usage, not an official source',
    'OTHER': 'Met in practice, not from a published glossary',
    'LOCAL': 'Added by you, held in this browser'
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
    var CODE = { 'COMMON': 'Common', 'OTHER': 'Other' };
    ['AAP-15', 'AAP-06', 'COMMON', 'OTHER'].forEach(function (id) {
      if (counts[id]) {
        sources.push({ id: id, code: CODE[id] || id,
                       name: SRC_META[id], count: counts[id], group: 'glossary' });
      }
    });
    sources.push({ id: 'AJP', code: 'AJP', name: SRC_META.AJP,
                   count: anyAjp, group: 'glossary' });
    if (counts.LOCAL) {
      sources.push({ id: 'LOCAL', code: 'Yours', name: SRC_META.LOCAL,
                     count: counts.LOCAL, group: 'glossary' });
    }
    var codes = Object.keys(publications).sort(function (a, b) {
      return a.localeCompare(b, 'en', { numeric: true });
    });
    for (var c = 0; c < codes.length; c++) {
      sources.push({ id: codes[c], code: codes[c], name: publications[codes[c]],
                     count: counts[codes[c]] || 0, group: 'ajp' });
    }
    var live = Object.create(null);
    for (var s2 = 0; s2 < sources.length; s2++) live[sources[s2].id] = 1;
    for (var sel in selected) {
      if (!live[sel]) { delete selected[sel]; selectedCount--; }
    }
    summarise();
    renderSources(els.srcSearch.value);
  }

  function renderSources(query) {
    var q = fold(query).trim();
    var frag = document.createDocumentFragment();
    var shown = 0, lastGroup = null;
    for (var i = 0; i < sources.length; i++) {
      var sc = sources[i];
      if (q && fold(sc.code + ' ' + sc.name).indexOf(q) === -1) continue;
      if (sc.group !== lastGroup && sc.group === 'ajp') {
        frag.appendChild(el('li', 'src-sep', 'Allied Joint Publications'));
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
      lab.appendChild(el('span', 'src-count', sc.count.toLocaleString('en-GB')));
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
      els.srcSummary.textContent = 'All';
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

  function clearFilters() {
    selected = Object.create(null);
    selectedCount = 0;
    renderSources(els.srcSearch.value);
    summarise();
    refresh();
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

  els.srcBtn.addEventListener('click', function () { openPanel(els.srcPanel.hidden); });
  els.srcSearch.addEventListener('input', function () { renderSources(els.srcSearch.value); });
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
    refresh();
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
    refresh();
  });
  els.srcNone.addEventListener('click', clearFilters);
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
      /* Long compound with no hit at all: fall back to the longest prefix
         that exists in the vocabulary. */
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

  function searchAbbr(query, scores, touched) {
    var q = normAbbr(query);
    if (!q) return;
    var raw = query.trim().toUpperCase();
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
      /* Punctuation is stripped before matching, so "D&G" and "DG" look alike.
         Favour the entry spelled the way the person typed it. */
      if (best > 0 && entries[i].a && entries[i].a.toUpperCase() === raw) best += 25;
      if (best > 0) { scores[i] = best; touched.push(i); }
    }
  }

  var scores = null, hits = null, hitGen = null, gen = 0;
  var termScratch = null, bodyScratch = null;

  /* ---------------- rendering parts ---------------- */

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

  var SRC_LABEL = { 'AAP-15': 'AAP-15', 'AAP-06': 'AAP-06', 'AJP': 'AJP lexicon' };

  function metaLine(e) {
    var p = el('p', 'meta');
    var first = true;
    function part(node) {
      if (!first) p.appendChild(el('span', 'sep', '·'));
      first = false;
      p.appendChild(node);
    }
    if (e.s === 'LOCAL') part(el('span', 'flag flag-own', 'Added by you'));
    else if (e.s === 'COMMON') part(el('span', 'flag', 'Common usage'));
    else if (e.s === 'OTHER') part(el('span', 'flag', 'Other'));
    else part(document.createTextNode(SRC_LABEL[e.s] || e.s));

    if (e.p && e.p.length) {
      part(document.createTextNode(e.p.slice(0, 3).join(', ') +
        (e.p.length > 3 ? ' +' + (e.p.length - 3) : '')));
    }
    if (e.y) part(document.createTextNode(e.y));
    if (e.v) part(document.createTextNode('also written ' + e.v.join(', ')));
    if (e.alt) part(document.createTextNode('also: ' + e.alt.join('; ')));
    if (e.g) for (var g = 0; g < e.g.length; g++) part(el('span', 'flag', e.g[g]));
    return p;
  }

  function actionBtn(label, fn) {
    var b = el('button', 'link-btn', label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function card(e, terms) {
    var box = el('article', 'entry');
    var head = el('div', 'entry-head');
    if (e.a) head.appendChild(el('span', 'abbr', e.a));
    var term = el('h3', 'term');
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
    box.appendChild(metaLine(e));

    if (e.s === 'LOCAL' && e.id) {
      var acts = el('p', 'entry-actions');
      var edit = el('a', 'link-btn', 'Edit this term');
      edit.href = '#/edit/' + encodeURIComponent(e.id);
      acts.appendChild(edit);
      acts.appendChild(actionBtn('Remove this term', function (ev) {
        askRemove(e, ev.currentTarget);
      }));
      box.appendChild(acts);
    }
    return box;
  }

  /* A heading above a group of results, carrying how many it holds and how
     many of those are on screen. */
  function groupHead(label, total, shown) {
    var h = el('h2', 'group');
    h.appendChild(el('span', 'group-label', label));
    h.appendChild(el('span', 'group-n',
                     shown < total ? shown + ' of ' + total : String(total)));
    return h;
  }

  function addCards(frag, list, from, to, terms) {
    for (var i = from; i < to; i++) frag.appendChild(card(entries[list[i]], terms));
  }

  function emptyState(title, body, actions) {
    var box = el('section', 'empty');
    box.appendChild(el('h2', null, title));
    box.appendChild(el('p', null, body));
    var row = el('div', 'empty-actions');
    for (var i = 0; i < actions.length; i++) row.appendChild(actions[i]);
    box.appendChild(row);
    return box;
  }

  function linkBtn(label, href, cls) {
    var a = el('a', 'btn' + (cls ? ' ' + cls : ''), label);
    a.href = href;
    return a;
  }

  function pushBtn(label, fn, cls) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  /* ---------------- the search view ---------------- */

  var MODE_KEY = 'nato-lookup.mode';
  var HINTS = {
    abbr: 'Type the short form to get the full term.',
    def:  'Describe it in plain words, or type the term itself.'
  };
  var PLACEHOLDER = {
    abbr: 'OPORD',
    def:  'order telling units what to do'
  };

  function mode() { return els.mode.value === 'def' ? 'def' : 'abbr'; }

  function applyMode() {
    var m = mode();
    els.q.placeholder = PLACEHOLDER[m];
    els.q.setAttribute('autocapitalize', m === 'abbr' ? 'characters' : 'off');
    var hint = document.getElementById('q-hint');
    hint.textContent = '';
    hint.appendChild(document.createTextNode(HINTS[m] + ' Press '));
    hint.appendChild(el('kbd', null, '/'));
    hint.appendChild(document.createTextNode(' to come back here.'));
    try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* private mode */ }
  }

  function otherMode() { return mode() === 'abbr' ? 'def' : 'abbr'; }

  function switchMode() {
    els.mode.value = otherMode();
    applyMode();
    run();
    els.q.focus();
  }

  function run() {
    if (view !== 'search') return;
    var q = els.q.value.trim();
    els.qClear.hidden = !q;

    if (!q) {
      els.body.setAttribute('data-view', 'start');
      els.results.textContent = '';
      els.count.textContent = '';
      return;
    }
    els.body.setAttribute('data-view', 'results');
    if (!entries.length) {
      els.results.textContent = '';
      els.count.textContent = loadError ? '' : 'Loading the terminology…';
      if (loadError) els.results.appendChild(emptyState('The terminology file did not load',
        loadError, [pushBtn('Try loading it again', function () { location.reload(); }, 'btn-primary')]));
      return;
    }

    gen++;
    var touched = [];
    scores.fill(0);
    var byText = mode() === 'def';
    if (byText) searchText(q, scores, touched); else searchAbbr(q, scores, touched);

    var out = [];
    for (var i = 0; i < touched.length; i++) {
      var idx = touched[i];
      if (scores[idx] > 0 && inSelectedSources(entries[idx])) out.push(idx);
    }
    out.sort(function (a, b) {
      var d = scores[b] - scores[a];
      if (d) return d;
      var la = (entries[a].a || '').length, lb = (entries[b].a || '').length;
      if (la !== lb) return la - lb;
      if (prominence[b] !== prominence[a]) return prominence[b] - prominence[a];
      return (entries[a].t || '').localeCompare(entries[b].t || '');
    });

    render(out, q, byText);
  }

  function render(list, q, grouped) {
    var terms = grouped ? tokens(q) : [fold(q)];
    var frag = document.createDocumentFragment();
    var shown;

    /* A definition search returns abbreviations and plain terms together.
       Keep the abbreviations first, under their own headings, so the two kinds
       are never read as one list. */
    var withAbbr = [], noAbbr = [];
    if (grouped) {
      for (var g = 0; g < list.length; g++) {
        (entries[list[g]].a ? withAbbr : noAbbr).push(list[g]);
      }
    }

    if (grouped && withAbbr.length && noAbbr.length) {
      /* Reserve part of the cap for the terms, or a long run of
         abbreviations would push them off the page entirely. */
      var showT = Math.min(noAbbr.length,
                           Math.max(MAX_RESULTS - withAbbr.length, TERM_SLOTS));
      var showA = Math.min(withAbbr.length, MAX_RESULTS - showT);
      frag.appendChild(groupHead('Abbreviations', withAbbr.length, showA));
      addCards(frag, withAbbr, 0, showA, terms);
      frag.appendChild(groupHead('Terms', noAbbr.length, showT));
      addCards(frag, noAbbr, 0, showT, terms);
      shown = showA + showT;
    } else {
      shown = Math.min(list.length, MAX_RESULTS);
      addCards(frag, list, 0, shown, terms);
    }

    els.results.textContent = '';
    els.results.appendChild(frag);

    var within = selectedCount ? ' in the selected source' + (selectedCount > 1 ? 's' : '') : '';
    if (!list.length) {
      els.count.textContent = 'No match' + within + '.';
      var actions = [];
      if (selectedCount) actions.push(pushBtn('Clear all filters', clearFilters, 'btn-primary'));
      actions.push(pushBtn(grouped ? 'Search abbreviations instead' : 'Search definitions instead',
                           switchMode, selectedCount ? '' : 'btn-primary'));
      actions.push(linkBtn('Add this term', '#/add'));
      els.results.appendChild(emptyState(
        (grouped ? 'No term matches “' : 'No abbreviation matches “') + q + '”',
        selectedCount
          ? 'Nothing in the sources you picked matches. Widen the filter, try the other kind of search, or add the term yourself.'
          : 'Try fewer words, the other kind of search, or add the term yourself — your own terms stay in this browser.',
        actions));
    } else if (list.length > shown) {
      els.count.textContent = 'Showing ' + shown + ' of ' +
        list.length.toLocaleString('en-GB') + ' matches' + within;
    } else {
      els.count.textContent = list.length +
        (list.length === 1 ? ' match' : ' matches') + within;
    }
  }

  /* ---------------- the lexicon view ---------------- */

  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
  var buckets = Object.create(null);
  var lexLetter = 'A';
  var lexShown = 0;
  var letterBtns = [];

  function sortKey(e) { return fold(e.a || e.t || ''); }

  function buildLexicon() {
    buckets = Object.create(null);
    for (var i = 0; i < LETTERS.length; i++) buckets[LETTERS[i]] = [];
    for (var n = 0; n < entries.length; n++) {
      var c = sortKey(entries[n]).charAt(0).toUpperCase();
      buckets[LETTERS.indexOf(c) === -1 ? '#' : c].push(n);
    }
    for (var L = 0; L < LETTERS.length; L++) {
      buckets[LETTERS[L]].sort(function (a, b) {
        var ka = sortKey(entries[a]), kb = sortKey(entries[b]);
        if (ka !== kb) return ka < kb ? -1 : 1;
        return (entries[a].t || '').localeCompare(entries[b].t || '');
      });
    }
  }

  function lexList() {
    var all = buckets[lexLetter] || [];
    if (!selectedCount) return all;
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (inSelectedSources(entries[all[i]])) out.push(all[i]);
    }
    return out;
  }

  function lexCount(letter) {
    var all = buckets[letter] || [];
    if (!selectedCount) return all.length;
    var n = 0;
    for (var i = 0; i < all.length; i++) if (inSelectedSources(entries[all[i]])) n++;
    return n;
  }

  function renderLetters() {
    els.lexLetters.textContent = '';
    letterBtns = [];
    for (var i = 0; i < LETTERS.length; i++) {
      var L = LETTERS[i];
      var n = lexCount(L);
      var b = el('button', 'letter', L);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', L === lexLetter ? 'true' : 'false');
      b.setAttribute('aria-controls', 'lex-list');
      b.id = 'letter-' + (L === '#' ? 'other' : L);
      if (L === lexLetter) els.lexList.setAttribute('aria-labelledby', b.id);
      b.setAttribute('title', n.toLocaleString('en-GB') +
        (n === 1 ? ' entry' : ' entries') + ' under ' + (L === '#' ? 'a number or symbol' : L));
      b.tabIndex = L === lexLetter ? 0 : -1;
      b.dataset.letter = L;
      if (!n) b.disabled = true;
      letterBtns.push(b);
      els.lexLetters.appendChild(b);
    }
  }

  function renderLex(keepShown) {
    if (!entries.length && !loadError) {
      els.lexList.textContent = '';
      els.lexList.appendChild(el('p', 'empty', 'Loading the terminology…'));
      els.lexMore.hidden = true;
      els.count.textContent = '';
      return;
    }
    var list = lexList();
    if (!keepShown) lexShown = 0;
    lexShown = Math.min(Math.max(lexShown || LEX_PAGE, LEX_PAGE), list.length);

    var frag = document.createDocumentFragment();
    for (var i = 0; i < lexShown; i++) frag.appendChild(card(entries[list[i]], []));
    els.lexList.textContent = '';

    if (!list.length) {
      els.lexList.appendChild(emptyState(
        'Nothing under ' + (lexLetter === '#' ? 'numbers and symbols' : lexLetter),
        selectedCount
          ? 'No entry in the sources you picked starts with that. Clear the filter or pick another letter.'
          : 'No entry starts with that. Pick another letter, or add the term yourself.',
        selectedCount
          ? [pushBtn('Clear all filters', clearFilters, 'btn-primary'), linkBtn('Add a term', '#/add')]
          : [linkBtn('Add a term', '#/add', 'btn-primary')]));
    } else {
      els.lexList.appendChild(frag);
    }

    els.lexMore.hidden = lexShown >= list.length;
    if (!els.lexMore.hidden) {
      els.lexMore.textContent = 'Show ' +
        Math.min(LEX_PAGE, list.length - lexShown) + ' more of ' +
        list.length.toLocaleString('en-GB');
    }
    els.count.textContent = list.length
      ? 'Showing ' + Math.min(lexShown, list.length) + ' of ' +
        list.length.toLocaleString('en-GB') + ' under ' + lexLetter +
        (selectedCount ? ' in the selected source' + (selectedCount > 1 ? 's' : '') : '')
      : 'Nothing under ' + lexLetter +
        (selectedCount ? ' in the selected source' + (selectedCount > 1 ? 's' : '') : '') + '.';
  }

  function pickLetter(L, focus) {
    lexLetter = L;
    renderLetters();
    renderLex(false);
    if (focus) {
      for (var i = 0; i < letterBtns.length; i++) {
        if (letterBtns[i].dataset.letter === L) { letterBtns[i].focus(); break; }
      }
    }
  }

  els.lexLetters.addEventListener('click', function (ev) {
    var b = ev.target.closest('button.letter');
    if (!b || b.disabled) return;
    pickLetter(b.dataset.letter, false);
  });

  els.lexLetters.addEventListener('keydown', function (ev) {
    var step = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' }[ev.key];
    if (step === undefined) return;
    ev.preventDefault();
    var live = letterBtns.filter(function (b) { return !b.disabled; });
    if (!live.length) return;
    var at = live.findIndex(function (b) { return b.dataset.letter === lexLetter; });
    var next;
    if (step === 'first') next = live[0];
    else if (step === 'last') next = live[live.length - 1];
    else next = live[(Math.max(at, 0) + step + live.length) % live.length];
    pickLetter(next.dataset.letter, true);
  });

  els.lexMore.addEventListener('click', function () {
    lexShown += LEX_PAGE;
    renderLex(true);
  });

  /* ---------------- routing ---------------- */

  var view = 'search';      // search | lexicon | form
  var navigated = false;    // a hash change, rather than the first paint

  function parseHash() {
    var h = location.hash || '';
    if (h.indexOf('#/edit/') === 0) return { view: 'form', id: decodeURIComponent(h.slice(7)) };
    if (h.indexOf('#/add') === 0) return { view: 'form', id: null };
    if (h.indexOf('#/lexicon') === 0) return { view: 'lexicon' };
    return { view: 'search' };
  }

  function focusTitle(node) {
    node.setAttribute('tabindex', '-1');
    node.focus();
  }

  function applyRoute() {
    var r = parseHash();
    view = r.view;
    openPanel(false);

    if (view === 'form') {
      var rec = r.id ? localEntries[findLocal(r.id)] : null;
      if (r.id && !rec) { location.hash = '#/'; return; }      /* gone: back to search */
      els.body.setAttribute('data-view', 'form');
      openForm(rec || { a: els.q.value.trim(), t: '' });
      if (navigated) (rec ? els.fTerm : els.fAbbr).focus();
      return;
    }
    if (view === 'lexicon') {
      els.body.setAttribute('data-view', 'lexicon');
      renderLetters();
      renderLex(false);
      if (navigated) focusTitle(els.lexTitle);
      return;
    }
    run();
    if (navigated) els.q.focus();
  }

  window.addEventListener('hashchange', function () {
    navigated = true;
    applyRoute();
  });

  /* Everything the current view needs redrawn after the data or the
     filter changed. */
  function refresh() {
    if (view === 'lexicon') { renderLetters(); renderLex(false); }
    else if (view === 'search') run();
  }

  /* ---------------- wiring ---------------- */

  var pending = 0;
  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(run, 70);
  }
  /* The bar stays on screen in the lexicon view, so typing in it has to
     take you back to the results rather than do nothing. */
  function toSearch() {
    if (view === 'search') return false;
    location.hash = '#/';
    return true;
  }
  els.q.addEventListener('input', function () {
    if (toSearch()) return;
    schedule();
  });
  els.mode.addEventListener('change', function () {
    applyMode();
    if (toSearch()) return;
    run();
  });
  els.qClear.addEventListener('click', function () {
    els.q.value = '';
    if (!toSearch()) run();
    els.q.focus();
  });
  els.form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    termTouched = true;
    saveForm();
  });

  /* Blur-first validation: nothing is flagged until the person has left the
     field, and editing clears the message straight away. */
  var termTouched = false;
  els.fTerm.addEventListener('blur', function () {
    if (!termTouched) return;
    if (!els.fTerm.value.trim()) {
      formMsg('Give the term a name. The abbreviation and definition are optional.');
    }
  });
  els.fTerm.addEventListener('input', function () { termTouched = true; formMsg(''); });
  els.fAbbr.addEventListener('input', function () { formMsg(''); });
  els.fDef.addEventListener('input', function () { formMsg(''); });
  document.querySelector('.search').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!toSearch()) run();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !els.srcPanel.hidden) {
      openPanel(false);
      els.srcBtn.focus();
      return;
    }
    if (ev.key === 'Escape' && document.activeElement === els.q && els.q.value) {
      els.q.value = '';
      if (!toSearch()) run();
      return;
    }
    if (ev.key === '/' && view !== 'form' &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) {
      ev.preventDefault();
      els.q.focus();
      els.q.select();
    }
  });

  /* ---------------- terms you add yourself ---------------- */

  /* These are typed in by whoever is using the app. They live in this
     browser's localStorage and nowhere else: never uploaded, never shared,
     and gone if the browser's site data is cleared. They are searched,
     filtered and ranked exactly like the published terminology, and every
     card carries an "Added by you" mark so the two are never confused. */

  var LOCAL_KEY = 'nato-lookup.custom.v1';
  var shipped = [];
  var localEntries = [];
  var editing = null;          // id of the entry being changed, or null
  var undoRec = null;          // last removal, for the undo button

  function newId() {
    return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function today() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function clean(rec) {
    /* Anything may be in storage - another version of the app, a hand edit,
       a half-written value. Keep only what the card knows how to show. */
    if (!rec || typeof rec !== 'object') return null;
    var t = typeof rec.t === 'string' ? rec.t.trim() : '';
    if (!t) return null;
    var out = { id: typeof rec.id === 'string' && rec.id ? rec.id : newId(),
                a: typeof rec.a === 'string' && rec.a.trim() ? rec.a.trim() : null,
                t: t, s: 'LOCAL' };
    if (typeof rec.d === 'string' && rec.d.trim()) out.d = rec.d.trim();
    if (typeof rec.y === 'string' && rec.y) out.y = rec.y;
    return out;
  }

  function loadLocal() {
    var raw = null;
    try { raw = localStorage.getItem(LOCAL_KEY); } catch (e) { return []; }
    if (!raw) return [];
    var list;
    try { list = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(list)) return [];
    var out = [], seen = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var rec = clean(list[i]);
      if (!rec || seen[rec.id]) continue;
      seen[rec.id] = 1;
      out.push(rec);
    }
    return out;
  }

  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(localEntries));
      return '';
    } catch (e) {
      return (e && /quota/i.test(e.name || ''))
        ? 'This browser has no storage space left, so the term was not saved.'
        : 'This browser would not let the app store the term. Private browsing ' +
          'and blocked site data both do that.';
    }
  }

  /* The index is built once over a fixed array, so adding or removing an
     entry means building it again from scratch. */
  function reindex() {
    pTerm = Object.create(null);
    pBody = Object.create(null);
    idf = Object.create(null);
    stemMap = Object.create(null);
    vocab = [];
    foldedTerm = [];
    foldedBody = [];
    abbrKeys = [];
    prominence = [];
    termLen = [];
    bodyLen = [];
    avgBody = 1;
    scores = new Float64Array(entries.length);
    hits = new Int32Array(entries.length);
    hitGen = new Int32Array(entries.length);
    termScratch = new Float64Array(entries.length);
    bodyScratch = new Float64Array(entries.length);
    gen = 0;
    buildIndex();
    buildSources();
  }

  var builtOn = '';
  var loadError = '';

  function statusLine() {
    if (loadError) {
      els.status.textContent = loadError + (localEntries.length
        ? ' Your own ' + (localEntries.length === 1 ? 'term is' : 'terms are') + ' still here.'
        : '');
      return;
    }
    els.status.textContent = shipped.length.toLocaleString('en-GB') +
      ' entries loaded · built ' + builtOn +
      (localEntries.length
        ? ' · ' + localEntries.length + (localEntries.length === 1 ? ' term' : ' terms') +
          ' of your own, stored in this browser'
        : '');
  }

  function applyLocal() {
    entries = shipped.concat(localEntries);
    reindex();
    statusLine();
  }

  function note(text, undoable) {
    els.localMsg.textContent = '';
    if (!text) { els.localMsg.hidden = true; return; }
    els.localMsg.appendChild(document.createTextNode(text));
    if (undoable) els.localMsg.appendChild(actionBtn('Undo the removal', undoRemove));
    els.localMsg.hidden = false;
  }

  function formMsg(text) {
    els.fMsg.textContent = text || '';
    els.fMsg.hidden = !text;
  }

  function openForm(rec) {
    editing = rec && rec.id ? rec.id : null;
    els.fAbbr.value = (rec && rec.a) || '';
    els.fTerm.value = (rec && rec.t) || '';
    els.fDef.value = (rec && rec.d) || '';
    els.fTitle.textContent = editing ? 'Edit your term' : 'Add a term';
    els.fSave.textContent = editing ? 'Save changes' : 'Save term';
    termTouched = false;
    formMsg('');
  }

  function findLocal(id) {
    for (var i = 0; i < localEntries.length; i++) {
      if (localEntries[i].id === id) return i;
    }
    return -1;
  }

  /* Show the entry that was just saved: a source filter that excludes it
     would otherwise leave the person looking at an empty result list. */
  function reveal(rec) {
    if (selectedCount && !selected.LOCAL) {
      selected = Object.create(null);
      selectedCount = 0;
      renderSources(els.srcSearch.value);
      summarise();
    }
    els.mode.value = rec.a ? 'abbr' : 'def';
    applyMode();
    els.q.value = rec.a ? rec.a : rec.t;
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else { view = 'search'; run(); }
  }

  function saveForm() {
    var abbr = els.fAbbr.value.trim().replace(/\s+/g, ' ');
    var term = els.fTerm.value.trim().replace(/\s+/g, ' ');
    var def = els.fDef.value.trim().replace(/[ \t]+/g, ' ');
    if (!term) {
      formMsg('Give the term a name. The abbreviation and definition are optional.');
      els.fTerm.focus();
      return;
    }
    for (var i = 0; i < localEntries.length; i++) {
      var other = localEntries[i];
      if (other.id === editing) continue;
      if (fold(other.t) === fold(term) && normAbbr(other.a || '') === normAbbr(abbr)) {
        formMsg('You have added that one already.');
        return;
      }
    }

    var at = editing ? findLocal(editing) : -1;
    if (editing && at === -1) { location.hash = '#/'; return; }
    var before = at === -1 ? null : localEntries[at];
    var rec = { id: editing || newId(), a: abbr || null, t: term, s: 'LOCAL',
                y: before && before.y ? before.y : today() };
    if (def) rec.d = def;

    if (at === -1) localEntries.push(rec); else localEntries[at] = rec;
    var err = saveLocal();
    if (err) {                                  // put it back as it was
      if (at === -1) localEntries.pop(); else localEntries[at] = before;
      formMsg(err);
      return;
    }
    undoRec = null;
    applyLocal();
    note(at === -1 ? 'Saved in this browser only.' : 'Your changes are saved in this browser.');
    reveal(rec);
  }

  /* Removing a term you added is destructive, so it is named and confirmed. */
  var dlgTrigger = null;
  var dlgTarget = null;

  function askRemove(e, trigger) {
    dlgTrigger = trigger || null;
    dlgTarget = e.id;
    els.dlgTitle.textContent = 'Remove ' + (e.a ? e.a + ' — ' : '') + e.t + '?';
    els.dlgText.textContent = 'It goes from this browser and from your search results. ' +
      'You can undo it straight afterwards.';
    els.dialog.showModal();
    els.dlgCancel.focus();
  }

  function closeDialog() {
    if (els.dialog.open) els.dialog.close();
  }

  els.dlgCancel.addEventListener('click', closeDialog);
  els.dlgOk.addEventListener('click', function () {
    var id = dlgTarget;
    closeDialog();
    if (id) removeLocal(id);
  });
  els.dialog.addEventListener('close', function () {
    dlgTarget = null;
    if (dlgTrigger && document.body.contains(dlgTrigger)) dlgTrigger.focus();
    else els.q.focus();
    dlgTrigger = null;
  });

  function removeLocal(id) {
    var at = findLocal(id);
    if (at === -1) return;
    var gone = localEntries[at];
    localEntries.splice(at, 1);
    var err = saveLocal();
    if (err) {
      localEntries.splice(at, 0, gone);
      note(err);
      return;
    }
    undoRec = { rec: gone, at: at };
    applyLocal();
    if (editing === id && view === 'form') { location.hash = '#/'; return; }
    refresh();
    note('Removed ' + (gone.a ? gone.a + ' — ' : '') + gone.t + '.', true);
  }

  function undoRemove() {
    if (!undoRec) return;
    localEntries.splice(Math.min(undoRec.at, localEntries.length), 0, undoRec.rec);
    var err = saveLocal();
    if (err) {
      localEntries.splice(findLocal(undoRec.rec.id), 1);
      note(err);
      return;
    }
    var back = undoRec.rec;
    undoRec = null;
    applyLocal();
    note('Put back.');
    reveal(back);
  }

  /* Each tab holds the whole list in memory and saves it whole, so a tab that
     never heard about another tab's new term would write over it. */
  window.addEventListener('storage', function (ev) {
    if (ev.key !== null && ev.key !== LOCAL_KEY) return;
    localEntries = loadLocal();
    undoRec = null;
    applyLocal();
    if (view === 'form' && editing && findLocal(editing) === -1) { location.hash = '#/'; return; }
    refresh();
  });

  /* ---------------- load ---------------- */

  try {
    var savedMode = localStorage.getItem(MODE_KEY);
    if (savedMode === 'abbr' || savedMode === 'def') els.mode.value = savedMode;
  } catch (e) { /* private mode */ }
  applyMode();

  localEntries = loadLocal();
  applyRoute();

  fetch('data/terms.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      shipped = data.entries;
      publications = data.publications || {};
      builtOn = data.generated;
      applyLocal();
      refresh();
    })
    .catch(function (err) {
      loadError = 'Could not load the terminology file (' + err.message + ').';
      applyLocal();          /* whatever you added yourself still works */
      refresh();
    });

  if ('serviceWorker' in navigator) {
    /* A new worker taking charge means the files this page is running came
       from the deploy before it. Come back once so the two match. Only when
       a worker was already in charge: the very first registration fires this
       as well, and there is nothing to reload for. */
    var hadWorker = !!navigator.serviceWorker.controller;
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadWorker || reloading) return;
      reloading = true;
      location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline use unavailable */ });
    });
  }
})();
