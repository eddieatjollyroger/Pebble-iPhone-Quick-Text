// Phone side of Quick Text. The watch picks a contact and a message; this script asks Home
// Assistant to send a quiet notification to your iPhone. An iPhone Shortcuts automation
// (iOS 27 "Notification" trigger) turns that notification into a text message.

// Where the settings page is hosted (put quicktext-settings.html in your GitHub Pages repo)
var CONFIG_URL = 'https://eddieatjollyroger.github.io/Pebble-iPhone-Quick-Text/';

// "passive" keeps the notification silent. If the Shortcuts automation doesn't fire,
// try 'active' here.
var INTERRUPTION = 'passive';
var CLEAR_AFTER_MS = 10000;     // remove the notification from the phone after this long

// The apps a contact can be sent through. The app's name travels inside the notification
// ("whatsapp||+351...||text"), and one shortcut on the iPhone branches on it.
var CHANNELS = {
  messages: { short: '' },       // the Messages app (iMessage / SMS)
  whatsapp: { short: 'WA' }
};

function channelOf(via) {
  var v = String(via || '').toLowerCase();
  return CHANNELS[v] ? v : 'messages';
}

var DEFAULTS = {
  trigger: 'PEBBLE_TEXT',
  notify_service: '',
  contacts: [],
  messages: ['On my way', 'Running late', 'Call you back soon', 'OK', 'Thanks!']
};

var settings = JSON.parse(JSON.stringify(DEFAULTS));

function loadSettings() {
  try {
    var saved = JSON.parse(localStorage.getItem('qt_settings') || 'null');
    if (!saved) return;
    if (typeof saved.trigger === 'string' && saved.trigger) settings.trigger = saved.trigger;

    if (typeof saved.notify_service === 'string') settings.notify_service = saved.notify_service;
    if (saved.contacts instanceof Array) settings.contacts = saved.contacts;
    if (saved.messages instanceof Array) settings.messages = saved.messages;
  } catch (e) { /* use defaults */ }
}

function saveSettings() {
  try { localStorage.setItem('qt_settings', JSON.stringify(settings)); } catch (e) { }
}

function themeValue() {
  return localStorage.getItem('theme') === 'light' ? 1 : 0;
}

/* ---------- Messages to the watch: one at a time, with ACK and retry ---------- */

var queue = [];
var inflight = null;

function pump() {
  if (inflight || queue.length === 0) return;
  inflight = queue.shift();
  var item = inflight;
  Pebble.sendAppMessage(item.payload, function() {
    inflight = null;
    pump();
  }, function() {
    item.tries++;
    if (item.tries < 5) queue.unshift(item);
    inflight = null;
    setTimeout(pump, 250);
  });
}

function enqueue(payload) {
  queue.push({ payload: payload, tries: 0 });
  pump();
}

// Fonts on the watch can't draw emoji, so labels for it drop them and are kept short
function watchLabel(text, maxBytes) {
  // Keep only what the watch's fonts can draw: Latin letters with accents, digits, ordinary
  // punctuation and a few typographic marks. Emoji, symbols, invisible joiners and other
  // scripts are dropped, since they'd show as blanks or boxes.
  var clean = String(text || '')
    .replace(/[^\u0020-\u007E\u00A0-\u017F\u2013\u2014\u2018-\u201D\u2022\u2026\u20AC]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '');

  // The watch's buffers count bytes, not letters, and accented letters take two bytes.
  // Cut at a whole character so nothing is left half-finished.
  var out = '', bytes = 0;
  for (var i = 0; i < clean.length; i++) {
    var code = clean.charCodeAt(i);
    var size = code < 0x80 ? 1 : (code < 0x800 ? 2 : 3);
    if (bytes + size > maxBytes) break;
    out += clean.charAt(i);
    bytes += size;
  }
  return out.replace(/\s+$/, '');
}

// A short fingerprint of what the watch shows, so we can tell whether it needs the lists again
function listsHash() {
  var str = JSON.stringify([
    settings.contacts.slice(0, 8).map(function(c) { return watchLabel(c.name, 23); }),
    settings.messages.slice(0, 12).map(function(m) { return watchLabel(m, 47); })
  ]);
  var h = 5381;
  for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return String(h);
}

// Theme + contact list + message list, in one go. The watch stores all of it, so this is only
// needed when something changed or the watch has lost it.
function syncWatch() {
  enqueue({ '10': themeValue() });
  sendLists();
  try { localStorage.setItem('qt_synced', JSON.stringify({ hash: listsHash(), theme: themeValue() })); } catch (e) { }
}

function watchNeedsSync() {
  try {
    var synced = JSON.parse(localStorage.getItem('qt_synced') || 'null');
    return !synced || synced.hash !== listsHash() || synced.theme !== themeValue();
  } catch (e) { return true; }
}

function sendLists() {
  queue = queue.filter(function(i) { return i.payload['4'] === undefined; });   // drop stale list messages

  var contacts = settings.contacts.slice(0, 8);
  enqueue({ '4': 0, '6': contacts.length });
  contacts.forEach(function(c, i) { enqueue({ '4': 0, '5': i, '7': watchLabel(c.name, 23) || 'contact ' + (i + 1) }); });

  var messages = settings.messages.slice(0, 12);
  enqueue({ '4': 1, '6': messages.length });
  messages.forEach(function(m, i) { enqueue({ '4': 1, '5': i, '7': watchLabel(m, 47) || 'message ' + (i + 1) }); });
}

// Goes to the front of the line, so it isn't held up behind a long list sync
function enqueueFirst(payload) {
  queue.unshift({ payload: payload, tries: 0 });
  pump();
}

function report(text, ok) {
  enqueueFirst({ '8': text, '9': ok ? 1 : 0 });
}

/* ---------- Home Assistant ---------- */

function haBase() {
  var url = localStorage.getItem('ha_url');
  var token = localStorage.getItem('ha_token');
  if (!url || !token) return null;
  if (url.charAt(url.length - 1) === '/') url = url.slice(0, -1);
  return { url: url, token: token };
}

// The phone's notify service, like "mobile_app_my_iphone". From settings if set, otherwise
// every notify.mobile_app_* service Home Assistant lists.
function phoneTargets(done) {
  if (settings.notify_service) { done([settings.notify_service]); return; }
  var ha = haBase();
  if (!ha) { done([]); return; }

  var xhr = new XMLHttpRequest();
  xhr.open('GET', ha.url + '/api/services', true);
  xhr.setRequestHeader("Authorization", "Bearer " + ha.token);
  xhr.onload = function() {
    var found = [];
    if (xhr.status === 200) {
      try {
        JSON.parse(xhr.responseText).forEach(function(d) {
          if (d.domain !== 'notify') return;
          Object.keys(d.services || {}).forEach(function(n) {
            if (n.indexOf('mobile_app_') === 0) found.push(n);
          });
        });
      } catch (e) { console.log('service list parse error: ' + e); }
    }
    done(found);
  };
  xhr.onerror = function() { done([]); };
  xhr.send();
}

function postNotify(service, body, cb) {
  var ha = haBase();
  var xhr = new XMLHttpRequest();
  xhr.open('POST', ha.url + '/api/services/notify/' + service, true);
  xhr.setRequestHeader("Authorization", "Bearer " + ha.token);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.onload = function() {
    if (xhr.status >= 200 && xhr.status < 300) cb(true, '');
    else {
      console.log("HA error " + xhr.status + ": " + xhr.responseText);
      cb(false, 'error ' + xhr.status);
    }
  };
  xhr.onerror = function() { cb(false, 'no connection'); };
  xhr.send(JSON.stringify(body));
}

// The notification the iPhone automation listens for:
//   title   = the trigger word (default PEBBLE_TEXT)
//   message = "<app>||<recipient>||<text>"   (app is messages or whatsapp)
function sendText(contact, text) {
  if (!haBase()) { report('no HA settings', false); return; }
  phoneTargets(function(targets) {
    if (!targets.length) { report('no phone found', false); return; }

    var tag = 'pebble_text_' + new Date().getTime();
    var noSeparator = function(v) { return String(v).replace(/\|\|/g, '| |'); };
    var message = channelOf(contact.via) + '||' + noSeparator(contact.to) + '||' + noSeparator(text);
    var body = {
      "title": settings.trigger,
      "message": message,
      "data": { "tag": tag, "push": { "interruption-level": INTERRUPTION } }
    };

    var left = targets.length, anyOk = false, lastError = '';
    targets.forEach(function(t) {
      postNotify(t, body, function(ok, err) {
        if (ok) {
          anyOk = true;
          // Tidy up: remove the notification from the phone a few seconds later
          setTimeout(function() {
            postNotify(t, { "message": "clear_notification", "data": { "tag": tag } }, function() {});
          }, CLEAR_AFTER_MS);
        } else { lastError = err; }
        left--;
        if (left === 0) {
          if (anyOk) report('sent to ' + watchLabel(contact.name, 20), true);
          else report(lastError, false);
        }
      });
    });
  });
}

/* ---------- Reply to the last message ---------- */

// An iPhone automation stores the sender and text of each received message in two Home
// Assistant "input_text" helpers (see the settings page). The app reads them here, so the
// watch can offer "reply" on top of the contact list. The "from" value can be just the
// sender, or "<app>||<sender>" (for example "WhatsApp||Anna") so the reply goes back through
// the app the message came in on.
var REPLY_FROM_ENTITY = 'input_text.pebble_last_from';
var REPLY_TEXT_ENTITY = 'input_text.pebble_last_text';
var REPLY_MAX_AGE_MIN = 180;      // ignore messages older than this
var reply = null;                 // { id, name, to, via, text, stamp } for the current "reply" row
var replySeq = 0;                 // a new number for every different message
var recentReplies = {};           // id -> who that reply goes to, so an answer can't reach the wrong person
var FALLBACK_POLL_MS = 30000;     // only used if Home Assistant can't push updates to us (see "Live updates")

var helpersMissing = false;       // true once we've found the reply helpers don't exist
var replyRetried = false;         // one automatic retry per launch if Home Assistant can't be reached

// cb(state, httpStatus). state is null if the request failed; status 404 means no such helper.
function getState(entity, cb) {
  var ha = haBase();
  if (!ha) { cb(null, 0); return; }
  var xhr = new XMLHttpRequest();
  xhr.open('GET', ha.url + '/api/states/' + entity, true);
  xhr.setRequestHeader("Authorization", "Bearer " + ha.token);
  xhr.onload = function() {
    if (xhr.status !== 200) { cb(null, xhr.status); return; }
    try { cb(JSON.parse(xhr.responseText), 200); } catch (e) { cb(null, 200); }
  };
  xhr.onerror = function() { cb(null, 0); };
  xhr.send();
}

// Numbers and emails written differently should still match: ignore spaces, dashes, brackets
function normalizeHandle(value) {
  return String(value || '').replace(/[\s\-().]/g, '').toLowerCase();
}

// Finds a saved contact by number/email, or by name (WhatsApp notifications give a name)
function findContact(value) {
  var h = normalizeHandle(value);
  if (!h) return null;
  var i, c;
  for (i = 0; i < settings.contacts.length; i++) {
    c = normalizeHandle(settings.contacts[i].to);
    if (c === h) return settings.contacts[i];
    if (h.length >= 9 && c.length >= 9 && c.slice(-9) === h.slice(-9)) return settings.contacts[i];   // same number, other format
  }
  var name = String(value).replace(/^\s+|\s+$/g, '').toLowerCase();
  for (i = 0; i < settings.contacts.length; i++) {
    if (String(settings.contacts[i].name).toLowerCase() === name) return settings.contacts[i];
  }
  return null;
}

// "WhatsApp", "WhatsApp Business", "Messages"... -> one of our app names
function channelFromApp(name) {
  var n = String(name || '').toLowerCase();
  if (n.indexOf('whatsapp') !== -1) return 'whatsapp';
  return 'messages';
}

// Splits "<app>||<sender>". A plain sender (no app) leaves the app unknown.
function parseFrom(raw) {
  raw = String(raw);
  var i = raw.indexOf('||');
  if (i === -1) return { via: null, from: raw };
  return { via: channelFromApp(raw.slice(0, i)), from: raw.slice(i + 2).replace(/^\s+|\s+$/g, '') };
}

function usable(state) {
  return state && state.state && ['unknown', 'unavailable', 'none', ''].indexOf(String(state.state).toLowerCase()) === -1;
}

function sendReplyTarget(isNew) {
  if (!reply) {
    enqueueFirst({ '4': 2, '6': 0 });
    return;
  }
  var short = CHANNELS[reply.via].short;
  var base = watchLabel(reply.name, short ? 18 : 23) || 'sender';   // a name that was all emoji still needs a label
  var label = short ? base + ' (' + short + ')' : base;
  var payload = { '4': 2, '6': 1, '7': label, '11': watchLabel(reply.text, 47), '13': reply.id };
  if (isNew) payload['12'] = 1;          // makes the watch buzz
  enqueueFirst(payload);
}

function replyKey(r) {
  return r ? [r.name, r.to, r.via, r.text, r.stamp].join('\u0001') : '';
}

// Home Assistant only stamps a helper when its value changes, so a second text from the same
// person leaves the "from" helper looking old. Use the newest time on either helper.
function newestTime(states) {
  var newest = 0;
  states.forEach(function(st) {
    ['last_updated', 'last_reported', 'last_changed'].forEach(function(k) {
      if (!st || !st[k]) return;
      var t = Date.parse(String(st[k]).replace(/\.\d+/, ''));
      if (!isNaN(t) && t > newest) newest = t;
    });
  });
  return newest;
}

// poll = true is the quiet periodic check while the app is open: it only talks to the watch
// when a new message has arrived.
function refreshReply(poll) {
  // Replies are optional. If the helpers don't exist (the setup was skipped), don't keep asking
  // Home Assistant: answer "no reply" straight away. This is checked once each time the app
  // opens, and again whenever the settings are saved.
  if (helpersMissing) {
    if (!poll) { reply = null; sendReplyTarget(); }
    return;
  }

  // Both helpers are fetched at the same time, which saves a round trip to Home Assistant
  var from = null, text = null, fromStatus = 0, left = 2;
  function finish() {
    if (--left > 0) return;

    if (!from && fromStatus === 404) helpersMissing = true;
    else if (from) helpersMissing = false;
    if (!helpersMissing && from) startLive();       // helpers exist: listen for new messages

    // A failed request (no connection, helper missing) says nothing about the message itself.
    // Keep what we already had instead of making the reply row vanish.
    if (!from || !text) {
      if (poll) return;
      console.log("reply check: couldn't read the helpers, keeping the last reply");
      sendReplyTarget();
      // The phone's network can still be waking up right after launch: try once more shortly
      if (!helpersMissing && !replyRetried) { replyRetried = true; setTimeout(function() { refreshReply(false); }, 3000); }
      return;
    }

    var next = null;
    var newest = newestTime([from, text]);
    var ageMin = newest ? (new Date().getTime() - newest) / 60000 : 0;
    if (!poll) {
      console.log("reply check: from=" + JSON.stringify(from.state) + " text=" + JSON.stringify(text.state) +
                  " age=" + Math.round(ageMin) + "min");
    }
    if (usable(from) && usable(text) && ageMin <= REPLY_MAX_AGE_MIN) {
      var parsed = parseFrom(from.state);
      var known = findContact(parsed.from);   // use the saved contact's name and number when we have them
      // the app the message arrived on wins; otherwise the contact's own app; otherwise Messages
      var via = parsed.via || (known ? channelOf(known.via) : 'messages');
      next = {
        name: known ? known.name : parsed.from,
        // a contact's saved number or email belongs to its own app. Through any other app,
        // reply to the sender as that app named them.
        to: (known && channelOf(known.via) === via) ? known.to : parsed.from,
        via: via,
        text: String(text.state),
        stamp: newest || 0      // changes even if the same words arrive twice
      };
    }

    var changed = replyKey(next) !== replyKey(reply);
    if (changed) {
      if (next) {
        next.id = ++replySeq;
        recentReplies[next.id] = { name: next.name, to: next.to, via: next.via };
        delete recentReplies[next.id - 8];       // only keep the last few
      }
      reply = next;
    }
    if (poll && !changed) return;                // nothing new: stay quiet
    sendReplyTarget(poll && changed && !!reply); // a new message while the app is open also buzzes the watch
  }

  getState(REPLY_FROM_ENTITY, function(state, status) { from = state; fromStatus = status; finish(); });
  getState(REPLY_TEXT_ENTITY, function(state) { text = state; finish(); });
}

/* ---------- Live updates ---------- */

// Home Assistant can push changes over its WebSocket API, so the phone is told the moment a
// new message is stored, with no need to keep asking. If this phone script has no WebSocket, or
// the connection can't be made, it falls back to a slow check instead.
var liveSocket = null;
var liveStarted = false;
var liveEverWorked = false;
var liveFailures = 0;
var liveReconnect = null;
var livePing = null;
var livePong = null;
var liveDebounce = null;
var fallbackPoll = null;
var liveMsgId = 10;

function startFallbackPolling() {
  if (fallbackPoll) return;
  fallbackPoll = setInterval(function() { refreshReply(true); }, FALLBACK_POLL_MS);
}

function stopFallbackPolling() {
  if (fallbackPoll) { clearInterval(fallbackPoll); fallbackPoll = null; }
}

function stopLive() {
  liveStarted = false;
  stopFallbackPolling();
  if (liveReconnect) { clearTimeout(liveReconnect); liveReconnect = null; }
  if (livePing) { clearInterval(livePing); livePing = null; }
  if (livePong) { clearTimeout(livePong); livePong = null; }
  if (liveSocket) {
    var old = liveSocket;
    liveSocket = null;
    try { old.close(); } catch (e) { }
  }
}

// The two helpers are set one after the other, so wait a moment and read them once
function scheduleReplyCheck() {
  if (liveDebounce) clearTimeout(liveDebounce);
  liveDebounce = setTimeout(function() { liveDebounce = null; refreshReply(true); }, 500);
}

function liveFailed() {
  liveFailures++;
  // Never managed to connect after a few tries: this phone or setup can't do it. Check slowly.
  if (!liveEverWorked && liveFailures >= 3) { startFallbackPolling(); return; }
  startFallbackPolling();                       // meanwhile, don't go blind
  var wait = Math.min(60000, 2000 * Math.pow(2, Math.min(liveFailures, 5)));
  if (liveReconnect) clearTimeout(liveReconnect);
  liveReconnect = setTimeout(function() { liveReconnect = null; connectLive(); }, wait);
}

function connectLive() {
  var ha = haBase();
  if (!ha || typeof WebSocket === 'undefined') { startFallbackPolling(); return; }

  var ws;
  try { ws = new WebSocket(ha.url.replace(/^http/i, 'ws') + '/api/websocket'); }
  catch (e) { liveFailed(); return; }
  liveSocket = ws;

  ws.onmessage = function(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }

    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: ha.token }));
    } else if (msg.type === 'auth_ok') {
      liveEverWorked = true;
      liveFailures = 0;
      stopFallbackPolling();
      ws.send(JSON.stringify({ id: 1, type: 'subscribe_trigger',
        trigger: { platform: 'state', entity_id: [REPLY_FROM_ENTITY, REPLY_TEXT_ENTITY] } }));
      refreshReply(true);                       // pick up anything that arrived while we weren't connected
      // A tiny ping now and then, so a connection that silently died is noticed and reopened
      if (livePing) clearInterval(livePing);
      livePing = setInterval(function() {
        try { ws.send(JSON.stringify({ id: ++liveMsgId, type: 'ping' })); } catch (e) { return; }
        if (livePong) clearTimeout(livePong);
        livePong = setTimeout(function() { try { ws.close(); } catch (e) { } }, 10000);
      }, 45000);
    } else if (msg.type === 'auth_invalid') {
      console.log('live updates: Home Assistant refused the token');
      stopLive();
    } else if (msg.type === 'result' && msg.id === 1 && !msg.success) {
      console.log('live updates: subscribing failed, checking slowly instead');
      startFallbackPolling();
    } else if (msg.type === 'event' && msg.id === 1) {
      scheduleReplyCheck();
    } else if (msg.type === 'pong') {
      if (livePong) { clearTimeout(livePong); livePong = null; }
    }
  };
  ws.onclose = function() {
    if (liveSocket !== ws) return;              // we closed it ourselves
    liveSocket = null;
    if (livePing) { clearInterval(livePing); livePing = null; }
    liveFailed();
  };
  ws.onerror = function() { /* onclose follows */ };
}

function startLive() {
  if (liveStarted) return;
  liveStarted = true;
  connectLive();
}

/* ---------- Events ---------- */

Pebble.addEventListener('ready', function() {
  loadSettings();
  // The reply goes first, since it's what the watch is waiting on. Its own request at launch
  // is usually lost because this script isn't running yet.
  refreshReply(false);
  // The watch keeps its contacts, messages and theme, so they're only sent again if they changed
  if (watchNeedsSync()) syncWatch();
});

Pebble.addEventListener('appmessage', function(e) {
  var p = e.payload;
  if (!p) return;
  if (p['0'] === 2) {                                  // watch is showing its contact list
    // The watch says how many contacts and messages it has. A mismatch means it lost them
    // (for example the app was reinstalled), so send them again.
    if (p['1'] !== undefined && p['2'] !== undefined &&
        (p['1'] !== Math.min(8, settings.contacts.length) || p['2'] !== Math.min(12, settings.messages.length))) {
      syncWatch();
    }
    refreshReply();
    return;
  }
  if (p['0'] !== 1) return;

  var isReply = (p['1'] === -1 || p['1'] === 255);   // the watch sends -1 for the reply row
  var target = reply;
  if (isReply && p['13'] !== undefined && recentReplies[p['13']]) target = recentReplies[p['13']];
  var contact = isReply ? (target && { name: target.name, to: target.to, via: target.via }) : settings.contacts[p['1']];
  if (!contact || !contact.to) { report('no contact', false); return; }

  var text = (p['3'] !== undefined) ? String(p['3']) : settings.messages[p['2']];
  if (!text) { report('no message', false); return; }

  sendText(contact, text);
});

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL(CONFIG_URL +
    '?s=' + encodeURIComponent(JSON.stringify(settings)) +
    '&url=' + encodeURIComponent(localStorage.getItem('ha_url') || '') +
    '&token=' + encodeURIComponent(localStorage.getItem('ha_token') || '') +
    '&theme=' + (themeValue() ? 'light' : 'dark') +
    '&return_to=' + encodeURIComponent('pebblejs://close#'));
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e.response) return;
  try {
    var cfg = JSON.parse(decodeURIComponent(e.response));
    if (cfg.ha_url) localStorage.setItem('ha_url', cfg.ha_url);
    if (cfg.ha_token) localStorage.setItem('ha_token', cfg.ha_token);
    if (cfg.theme === 'light' || cfg.theme === 'dark') localStorage.setItem('theme', cfg.theme);

    if (typeof cfg.notify_service === 'string') {
      // keep just the service name, e.g. "notify.mobile_app_x" -> "mobile_app_x"
      settings.notify_service = cfg.notify_service.toLowerCase().replace(/-/g, '_').replace(/^notify\./, '').replace(/[^a-z0-9_]/g, '');
    }
    if (typeof cfg.trigger === 'string' && cfg.trigger.replace(/\s/g, '')) settings.trigger = cfg.trigger.replace(/^\s+|\s+$/g, '');

    if (cfg.contacts instanceof Array) {
      settings.contacts = cfg.contacts.filter(function(c) { return c && c.name && c.to; })
        .map(function(c) { return { name: String(c.name), to: String(c.to), via: channelOf(c.via) }; }).slice(0, 8);
    }
    if (cfg.messages instanceof Array) {
      settings.messages = cfg.messages.filter(function(m) { return typeof m === 'string' && m.replace(/\s/g, ''); }).slice(0, 12);
    }
    saveSettings();
    helpersMissing = false;     // settings changed: look for the reply helpers again
    stopLive();
    liveEverWorked = false;
    liveFailures = 0;
    syncWatch();
    refreshReply(false);        // starts listening again if the helpers are there
  } catch (err) {
    console.log('settings parse error: ' + err);
  }
});
