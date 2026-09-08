/*
 * Speak to Yourself — an on-device reflection companion for the hemisync page.
 *
 * Inspired by krystline.ai-style self-awareness apps, but fully local:
 * you leave small check-ins over time (mood + a line of truth), and the
 * app gathers them into a private picture of you — moods, streaks, the
 * words that keep surfacing, the hour you tend to speak. When you ask,
 * it reflects that picture BACK to you in second person, and can speak
 * it aloud with a calm synthesized voice.
 *
 * Privacy: everything lives in localStorage ('vhs_self_*'). Nothing is
 * sent anywhere. No API keys. Works offline.
 */

(function () {
  'use strict';

  var KEY = 'vhs_self_entries';
  var KEY_NAME = 'vhs_self_name';

  /* ---------- storage ---------- */

  function loadEntries() {
    try {
      var r = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(r) ? r : [];
    } catch (e) { return []; }
  }
  function saveEntries(a) {
    try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {}
  }

  /* ---------- mood model ---------- */

  var MOODS = [
    { id: 'storm',  label: 'Storm',   v: 1, color: '#e5484d' },
    { id: 'low',    label: 'Low',     v: 2, color: '#f07d2e' },
    { id: 'okay',   label: 'Okay',    v: 3, color: '#e8c93e' },
    { id: 'good',   label: 'Good',    v: 4, color: '#46c46e' },
    { id: 'clear',  label: 'Clear',   v: 5, color: '#3ea6e8' },
  ];
  function moodById(id) {
    for (var i = 0; i < MOODS.length; i++) if (MOODS[i].id === id) return MOODS[i];
    return MOODS[2];
  }

  /* ---------- pattern mining (heuristics, no AI) ---------- */

  var STOP = new Set(('a an the i you me my we our us it its they them he she him her ' +
    'and but or so if then than of in on at to for with without from by as is are was were ' +
    'be been being am do does did done have has had having not no yes yeah really just ' +
    'like know think feel felt want wanted need needed today tomorrow yesterday now ' +
    'always never sometimes often maybe probably still already').split(' '));

  function words(text) {
    return (text.toLowerCase().match(/[a-z']{2,}/g) || []);
  }
  function freq(arr) {
    var m = {};
    arr.forEach(function (w) { m[w] = (m[w] || 0) + 1; });
    return m;
  }
  function topFreq(m, n) {
    return Object.keys(m)
      .filter(function (w) { return !STOP.has(w) && w.length > 2; })
      .sort(function (a, b) { return m[b] - m[a]; })
      .slice(0, n);
  }

  function calcStreak(entries) {
    if (!entries.length) return 0;
    var days = new Set(entries.map(function (e) { return new Date(e.ts).toDateString(); }));
    var streak = 0, d = new Date();
    while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1); }
    return streak;
  }

  function hourOf(e) { return new Date(e.ts).getHours(); }

  function bestHour(entries) {
    var h = {};
    entries.forEach(function (e) { var k = hourOf(e); h[k] = (h[k] || 0) + 1; });
    var best = -1, bestN = 0;
    Object.keys(h).forEach(function (k) {
      if (h[k] > bestN) { bestN = h[k]; best = Number(k); }
    });
    return best;
  }

  /* ---------- the reflection (second person, specific) ---------- */

  function reflect(entries) {
    if (!entries.length) {
      return 'You have not spoken yet. Leave a single honest line — a mood and a sentence — and I will begin to know you.';
    }
    var n = entries.length;
    var avg = entries.reduce(function (s, e) { return s + moodById(e.mood).v; }, 0) / n;
    var moodTone = avg >= 3.6 ? 'steady' : (avg >= 2.6 ? 'mixed' : 'heavy');

    var parts = [];
    parts.push('Over ' + (n === 1 ? 'your one check-in' : 'your ' + n + ' check-ins') +
      ', your average mood has been ' + (avg >= 3.6 ? 'bright' : (avg >= 2.6 ? 'in-between' : 'low')) +
      (moodTone === 'steady' ? ' — you hold a steady center.' : '.'));

    var streak = calcStreak(entries);
    if (streak >= 2) parts.push('You have shown up ' + streak + ' days in a row — that is a practice forming.');

    var allWords = [];
    entries.forEach(function (e) { allWords = allWords.concat(words(e.text)); });
    var top = topFreq(freq(allWords), 4);
    if (top.length) parts.push('The words that keep surfacing in your own voice: ' + top.join(', ') + '.');

    var recent = entries.slice(-3);
    var moods = recent.map(function (e) { return moodById(e.mood).label.toLowerCase(); });
    if (recent.length >= 2 && new Set(moods).size === 1) {
      parts.push('Your last ' + recent.length + ' check-ins have all been "' + moods[0] + '" — worth asking what stays the same.');
    }

    var bh = bestHour(entries);
    if (bh >= 0) {
      var ampm = bh < 12 ? 'morning' : (bh < 18 ? 'afternoon' : 'evening');
      parts.push('You tend to speak in the ' + ampm + '.');
    }

    var last = entries[n - 1];
    var lm = moodById(last.mood);
    parts.push('Your most recent line — "' + last.text + '" — landed in "' + lm.label.toLowerCase() + '". Sit with that for a breath.');

    return parts.join(' ');
  }

  /* ---------- speech ---------- */

  function speak(text, btn) {
    if (!('speechSynthesis' in window)) return;
    if (window.__vhSpeaking) { window.speechSynthesis.cancel(); window.__vhSpeaking = false; }
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92; u.pitch = 1.02; u.volume = 1.0;
    var timer = setTimeout(function () { window.__vhSpeaking = false; }, 60000);
    u.onend = function () { clearTimeout(timer); window.__vhSpeaking = false; };
    window.__vhSpeaking = true;
    window.speechSynthesis.speak(u);
    if (btn) flash(btn, 'Speaking…');
  }

  function flash(el, txt) {
    var old = el.textContent;
    el.textContent = txt;
    setTimeout(function () { el.textContent = old; }, 1600);
  }

  /* ---------- UI ---------- */

  function render(entries) {
    var mount = document.getElementById('selftalk');
    if (!mount) return;
    var name = '';
    try { name = localStorage.getItem(KEY_NAME) || ''; } catch (e) {}

    var html = '';
    html += '<div class="st-hello">' +
      (name ? 'Hello, <b>' + esc(name) + '</b> — ' : '') +
      'this is your private mirror. Leave check-ins; it learns you.</div>';

    html += '<div class="st-mood-row">';
    MOODS.forEach(function (m) {
      html += '<button type="button" class="st-mood" data-mood="' + m.id + '" style="--mc:' + m.color + '">' + m.label + '</button>';
    });
    html += '</div>';

    html += '<textarea class="st-txt" rows="2" placeholder="one honest line… what is true right now?"></textarea>';
    html += '<div class="st-send-row">' +
      '<button type="button" class="st-send">Speak</button>' +
      '<button type="button" class="st-reflect">Reflect back to me</button>' +
      '<button type="button" class="st-listen">Hear it</button>' +
      '</div>';

    html += '<div class="st-panel" id="st-panel"></div>';

    html += '<div class="st-history">';
    var recent = entries.slice(-6).reverse();
    if (!recent.length) {
      html += '<div class="st-empty">Nothing yet — your words will gather here.</div>';
    } else {
      recent.forEach(function (e) {
        var m = moodById(e.mood);
        html += '<div class="st-entry"><span class="st-dot" style="background:' + m.color + '"></span>' +
          '<span class="st-date">' + fmtDate(e.ts) + '</span>' +
          '<span class="st-text">' + esc(e.text) + '</span></div>';
      });
    }
    html += '</div>';

    mount.innerHTML = html;

    mount.querySelectorAll('.st-mood').forEach(function (b) {
      b.addEventListener('click', function () {
        mount.querySelectorAll('.st-mood').forEach(function (x) { x.classList.remove('sel'); });
        b.classList.add('sel');
      });
    });
    mount.querySelector('.st-send').addEventListener('click', function () { addEntry(); });
    mount.querySelector('.st-reflect').addEventListener('click', function () { showReflection(); });
    mount.querySelector('.st-listen').addEventListener('click', function () {
      var p = document.getElementById('st-panel');
      if (p && p.dataset.reflection) speak(p.dataset.reflection, this);
    });
  }

  function addEntry() {
    var mount = document.getElementById('selftalk');
    var sel = mount.querySelector('.st-mood.sel');
    var mood = sel ? sel.dataset.mood : 'okay';
    var text = mount.querySelector('.st-txt').value.trim();
    if (!text) { flash(mount.querySelector('.st-send'), 'Say something first'); return; }
    var entries = loadEntries();
    entries.push({ ts: Date.now(), mood: mood, text: text });
    saveEntries(entries);
    mount.querySelector('.st-txt').value = '';
    mount.querySelectorAll('.st-mood').forEach(function (x) { x.classList.remove('sel'); });
    render(entries);
    showReflection(true);
  }

  function showReflection(quiet) {
    var entries = loadEntries();
    var txt = reflect(entries);
    var panel = document.getElementById('st-panel');
    panel.innerHTML = '<div class="st-reflect-lbl">SPEAK TO YOURSELF</div><div class="st-reflect-txt">' + txt + '</div>';
    panel.dataset.reflection = txt;
    panel.classList.add('vis');
    if (!quiet) flash(document.querySelector('.st-reflect'), 'Here is what I see');
  }

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return 'today';
    var y = d.getFullYear() === now.getFullYear() ? '' : ' ' + d.getFullYear();
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + y;
  }

  window.initSelfTalk = function () {
    render(loadEntries());
  };
})();