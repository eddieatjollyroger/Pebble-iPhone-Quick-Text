// Phone side of Quick Text. The watch picks a contact and a message; this script asks Home
// Assistant to send a quiet notification to your iPhone. An iPhone Shortcuts automation
// (iOS 27 "Notification" trigger) turns that notification into a text message.

// Where the settings page is hosted (put quicktext-settings.html in your GitHub Pages repo)
var CONFIG_URL = 'https://eddieatjollyroger.github.io/Pebble-HA-TV-Remote/quicktext-settings.html';

// "passive" keeps the notification silent. If the Shortcuts automation doesn't fire,
// try 'active' here.
var INTERRUPTION = 'passive';
var CLEAR_AFTER_MS = 10000;     // remove the notification from the phone after this long

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
function watchLabel(text, max) {
  var clean = String(text || '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').replace(/\s+/g, ' ');
  clean = clean.replace(/^\s+|\s+$/g, '');
  return clean.substring(0, max);
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

function report(text, ok) {
  enqueue({ '8': text, '9': ok ? 1 : 0 });
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
//   message = "<recipient>||<text>"
function sendText(contact, text) {
  if (!haBase()) { report('no HA settings', false); return; }
  phoneTargets(function(targets) {
    if (!targets.length) { report('no phone found', false); return; }

    var tag = 'pebble_text_' + new Date().getTime();
    var message = String(contact.to).replace(/\|\|/g, '| |') + '||' + String(text).replace(/\|\|/g, '| |');
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

/* ---------- Events ---------- */

Pebble.addEventListener('ready', function() {
  loadSettings();
  enqueue({ '10': themeValue() });
  sendLists();
});

Pebble.addEventListener('appmessage', function(e) {
  var p = e.payload;
  if (!p || p['0'] !== 1) return;

  var contact = settings.contacts[p['1']];
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
        .map(function(c) { return { name: String(c.name), to: String(c.to) }; }).slice(0, 8);
    }
    if (cfg.messages instanceof Array) {
      settings.messages = cfg.messages.filter(function(m) { return typeof m === 'string' && m.replace(/\s/g, ''); }).slice(0, 12);
    }
    saveSettings();
    enqueue({ '10': themeValue() });
    sendLists();
  } catch (err) {
    console.log('settings parse error: ' + err);
  }
});
