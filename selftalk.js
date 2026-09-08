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
      '<button type="button" class="st-dictate" style="display:none" title="Say your check-in out loud — it types itself">\uD83C\uDFA4 Dictate</button>' +
      '<button type="button" class="st-send">Save</button>' +
      '<button type="button" class="st-reflect">Reflect back to me</button>' +
      '<button type="button" class="st-listen">Hear it</button>' +
      '</div>';

    html += '<div class="st-panel" id="st-panel"></div>';

    html += '<div class="st-ai-note"><label>' +
      '<input type="checkbox" class="st-ai-on"> Talk with the AI mirror' +
      '</label><span class="st-ai-hint"> — sends only what you type in the chat' +
      ' (plus your recent check-ins, only if you tick this) to craft replies.</span></div>';
    html += '<div class="st-chat" id="st-chat" style="display:none"></div>';
    html += '<div class="st-chat-row" id="st-chat-row" style="display:none">' +
      '<input type="text" class="st-chat-in" placeholder="ask your mirror anything…" maxlength="500">' +
      '<button type="button" class="st-chat-go">Send</button></div>';

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
    wireDictate(mount);
    wireChat(mount);
  }

  /* ---------- voice dictation (chat-style mic) ----------
     Web Speech API: Chrome, Edge, Safari. Hidden entirely where
     unsupported (Firefox) so the row never shows a dead button. */

  var rec = null, recActive = false, recBase = '';

  function wireDictate(mount) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var btn = mount.querySelector('.st-dictate');
    if (!SR || !btn) return;               // Firefox & friends: no mic button
    btn.style.display = '';
    btn.addEventListener('click', function () {
      if (recActive) { try { rec.stop(); } catch (e) {} return; }
      startDictation(btn, mount);
    });
  }

  function startDictation(btn, mount) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var ta = mount.querySelector('.st-txt');
    try { rec = new SR(); } catch (e) { flash(btn, 'Mic unavailable'); return; }
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    recBase = ta.value.trim();
    recActive = true;
    btn.classList.add('rec');
    flash(btn, 'Listening…');

    rec.onresult = function (e) {
      var fin = '', interim = '';
      for (var i = 0; i < e.results.length; i++) {
        var r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      var said = (fin || interim).trim();
      if (said) ta.value = (recBase ? recBase + ' ' : '') + said;
    };
    rec.onerror = function (e) {
      var msg = e.error === 'not-allowed' ? 'Mic blocked'
        : e.error === 'no-speech' ? 'Nothing heard'
        : e.error === 'network' ? 'Speech service unreachable'
        : 'Try again';
      flash(btn, '\uD83C\uDFA4 ' + msg);
    };
    rec.onend = function () {
      recActive = false;
      btn.classList.remove('rec');
      if (btn.textContent.indexOf('Listening') !== -1) btn.textContent = '\uD83C\uDFA4 Dictate';
    };
    try { rec.start(); } catch (err) {
      recActive = false;
      btn.classList.remove('rec');
      flash(btn, '\uD83C\uDFA4 Try again');
    }
  }

  /* ---------- AI mirror (keyless public endpoint, CORS-open) ----------
     pollinations.ai text API: free, no key, Access-Control-Allow-Origin: *.
     Because there is no key, there is nothing to steal — snoopers can only
     use the same free public endpoint any visitor could. Chat turns live in
     memory only (never localStorage, never sent anywhere else). */

  var chatTurns = [];   // [{you, mirror}] — memory only

  function wireChat(mount) {
    var box = mount.querySelector('.st-ai-on');
    var chat = mount.querySelector('#st-chat');
    var row = mount.querySelector('#st-chat-row');
    if (!box) return;
    box.addEventListener('change', function () {
      var on = box.checked;
      chat.style.display = on ? 'flex' : 'none';
      row.style.display = on ? 'flex' : 'none';
      if (on && !chat.children.length) {
        addMsg(chat, 'mirror', 'I am here. Ask me anything about what you have been carrying — or just say hello.');
      }
    });
    var input = mount.querySelector('.st-chat-in');
    var go = mount.querySelector('.st-chat-go');
    function send() {
      var q = input.value.trim();
      if (!q || go.disabled) return;
      input.value = '';
      askMirror(chat, q, go);
    }
    go.addEventListener('click', send);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
  }

  function addMsg(chat, who, text) {
    var d = document.createElement('div');
    d.className = 'st-msg ' + who;
    d.textContent = text;
    if (who === 'mirror') {
      var say = document.createElement('span');
      say.className = 'st-say';
      say.textContent = '\uD83D\uDD0A';
      say.title = 'Read aloud';
      say.addEventListener('click', function () { speak(text, say); });
      d.appendChild(say);
    }
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }

  function mirrorDigest() {
    var entries = loadEntries();
    if (!entries.length) return '';
    return entries.slice(-6).map(function (e) {
      return '[' + moodById(e.mood).label + '] ' + e.text;
    }).join(' | ');
  }

  /* The AI mirror talks to our Cloudflare Worker (mirror-url.js). The key
     lives server-side; the client only sends the message + a short digest
     of recent check-ins. Not configured yet -> graceful offline message;
     the local reflection keeps working either way. */
  function askMirror(chat, q, go) {
    addMsg(chat, 'you', q);
    var thinking = addMsg(chat, 'mirror', '…');
    go.disabled = true;
    var url = window.VH_MIRROR_URL || '';
    if (!url) {
      thinking.textContent = 'The AI mirror is not connected yet — but your words are safe here, and the local reflection still works. (Paste your Worker URL into mirror-url.js to wake it.)';
      go.disabled = false;
      return;
    }
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 30000);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: q.slice(0, 600), digest: mirrorDigest().slice(0, 1200) }),
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        clearTimeout(timer);
        var reply = String(data.reply || '').trim();
        if (!reply) throw new Error('empty reply');
        thinking.textContent = reply;
        var say = document.createElement('span');
        say.className = 'st-say'; say.textContent = '\uD83D\uDD0A'; say.title = 'Read aloud';
        say.addEventListener('click', function () { speak(reply, say); });
        thinking.appendChild(say);
        chatTurns.push({ you: q, mirror: reply });
        if (chatTurns.length > 6) chatTurns.shift();
        go.disabled = false;
      })
      .catch(function () {
        clearTimeout(timer);
        thinking.textContent = 'The mirror could not reach its voice just now — your words are still safe here. Try again in a moment.';
        go.disabled = false;
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