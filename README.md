# Quick Text for Pebble

Send a text from your wrist through your own Home Assistant server. Pick a contact, pick a
message (or dictate one), and your iPhone sends it. No email accounts, no cloud service.

When a message arrives, a "reply" row appears at the top of the contact list with who it's
from and what they said, so you can answer in two presses.

## How it works

1. You choose a contact and a message on the watch.
2. The phone app asks Home Assistant to send a quiet notification to your iPhone.
3. An iPhone Shortcuts automation notices that notification and sends the text with the
   Messages or WhatsApp app.

For replies, a second automation stores each message you receive in Home Assistant, and the
watch app reads it from there.

## What you need

- A Pebble watch with the Pebble app on your iPhone.
- An iPhone on iOS 27 or later (it needs the Shortcuts "Notification" trigger).
- Home Assistant, reachable from your phone (at home or from outside), with the Home Assistant
  companion app on the iPhone and notifications allowed.
- A Home Assistant long-lived access token (profile, Security tab, Long-lived access tokens).

Dictation only appears on watches with a microphone.

## Files

| File | What it is |
|---|---|
| `main.c` | The watch app |
| `index.js` | The phone side (talks to Home Assistant) |
| `quicktext-settings.html` | The settings page, opened from the Pebble app |
| `menu_icon.png` | 25 x 25 launcher icon |
| `icon_144.png`, `icon_48.png` | Store listing icons |

## 1. Install the watch app (CloudPebble)

1. Install watch app on the Pebble app store

## 2. Fill in the settings

Open the app's settings from the Pebble app on your phone.

| Setting | What to enter |
|---|---|
| Home Assistant URL | Your address, for example `https://your-ha.example.org:8123` |
| Long-Lived Access Token | The token from your Home Assistant profile |
| iPhone notify service | Optional. Leave it empty if you have one phone with the Home Assistant app. Otherwise the name from Developer Tools, like `mobile_app_my_iphone` |
| Trigger word | Default `PEBBLE_TEXT`. The automation looks for it in the notification title |
| Contacts | Up to 8. A name for the watch, a phone number, email or name, and which app to send through (Messages or WhatsApp) |
| Messages | Up to 12 canned messages |
| Theme | Dark or light. It applies to the watch too once saved |

Press Save. The contacts, messages and theme are sent to the watch and stored there.

Tip: emoji in names and canned messages are fine for sending, but the watch can't draw them, so
it hides them in its lists. See "Limits" below.

## 3. Build the sending shortcut (iPhone, one time)
Quick way:
1.  install the <a id="shortcut_a" href="https://www.icloud.com/shortcuts/bd19019334894291909a6f9dc6605aff" target="_blank" rel="noopener">install the ready-made shortcut</a>, turn its automation on, and skip the steps below. If tapping it doesn't open Shortcuts, long-press the link and open it in Safari.

Long way:
1. In Home Assistant's companion app, allow notifications.
2. Open Shortcuts, then Automation, and create a new automation with the **Notification**
   trigger.
3. App: **Home Assistant**. Filter: title contains your trigger word (`PEBBLE_TEXT`). Set it to
   run immediately instead of asking.
4. Add the actions:
   1. **Split Text** on the notification's message, with the custom separator `||`.
   2. Three **Get Item from List** actions: item 1 is the **app**, item 2 is the **recipient**,
      item 3 is the **text**.
   3. **If** the app is `whatsapp`: add WhatsApp's **Send Message** with the text to the
      recipient.
   4. **Otherwise**: add the Messages **Send Message** with the text to the recipient.
5. Send yourself a test from the watch.

The notification message is always `app||recipient||text`, for example
`whatsapp||+351912345678||On my way`. The app is `messages` or `whatsapp`.

Notes:
- Only add the branches for the apps you use. Anything that isn't WhatsApp goes through Messages.
- If an app's Send Message action won't accept a phone number as the recipient, use the contact's
  name as saved in your iPhone's Contacts.
- Field names in the Shortcuts trigger may be worded differently on your iOS version.
- If the automation doesn't fire, change `INTERRUPTION` at the top of `index.js` from `'passive'`
  to `'active'`.
- The phone asks Home Assistant to remove the notification about 10 seconds after sending.

## 4. Optional: reply to the last message

This adds the "reply" row. Skip it if you don't want it. The rest of the app works the same without it.

Quick way:
1. <a id="reply_shortcut_a" href="https://www.icloud.com/shortcuts/62f6b2c8feac4ec09e73a8853d031fc6" target="_blank" rel="noopener">install the ready-made reply shortcut</a> and turn its automation on. You still need to create the two Home Assistant helpers (the first step below). If tapping doesn't open Shortcuts, long-press the link and open it in Safari.

Long way:
1. In Home Assistant, go to Settings, Devices and services, Helpers, and create two **Text**
   helpers named `pebble_last_from` and `pebble_last_text`. Set the maximum length of both to
   255. Their entity IDs will be `input_text.pebble_last_from` and `input_text.pebble_last_text`.
2. On the iPhone, create one more **Notification** automation in Shortcuts, set to run
   immediately. Choose Messages, and WhatsApp too if it lets you pick several apps. Leave the
   title filter empty.
3. Add a **Text** action containing the notification's app name, then `||`, then the
   notification's title (the sender). It reads like `WhatsApp||Anna`.
4. Add two **Call Service** actions from the Home Assistant app, both with service
   `input_text.set_value`:
   - `entity_id` = `input_text.pebble_last_from`, `value` = the text from step 3
   - `entity_id` = `input_text.pebble_last_text`, `value` = the notification's message
5. If the automation can't pick several apps, or doesn't expose the app's name, make one
   automation per app and type the app name (`messages` or `whatsapp`) instead of the variable.

How replies are routed: the reply goes back through the app the message arrived on. If the
sender's name or number matches one of your contacts, the app uses their saved details.

## Using the watch app

- **Contact list** (`$ send_to_`): Up and Down move, and they wrap around. Select opens a contact.
  Back exits.
- **Reply row**: when a recent message exists, the first row reads `reply: Anna (WA)` with the
  message underneath. Messages older than three hours are ignored.
- **Message list**: the first row is `dictate...` on watches with a microphone. The rest are your
  canned messages. Long ones slide sideways when selected.
- **Sending**: you see `sending...`, then `sent to Anna`, a vibration, and you're back on the
  contact list. If something goes wrong, the message stays on screen until you press Back.
- **New message while the app is open**: the reply row updates by itself and the watch gives a
  short buzz.
- **Choosing a reply**: once you pick the reply row, your answer goes to that person even if
  someone else writes while you're choosing what to say.
- **Spinner**: a small `[|]` in the header while the reply is being fetched.

## How live updates work

The phone keeps a connection to Home Assistant open while the app is running and is told the
moment a new message is stored. That's why updates need no repeated checking.

If the phone app can't make that connection, or Home Assistant is older than the feature needs,
it falls back to checking every 30 seconds. If you skipped the optional reply setup, nothing is
checked at all.

## Limits

- Up to 8 contacts and 12 canned messages.
- The watch can only draw Latin letters with accents and ordinary punctuation. Emoji, symbols and
  other writing systems are hidden in the lists, and a name with nothing drawable left shows as
  `contact 2`. The text that's actually sent is not changed.
- "Sent" means Home Assistant accepted the request. The watch can't know whether the Shortcut
  then delivered it.
- Home Assistant only pushes changes when a value changes. If someone sends the exact same words
  twice in a row, the second one may not update the row until the next time the app asks.
- Group chats aren't supported. Telegram isn't supported. Contacts that were set to Telegram now
  go through Messages.
- Your Home Assistant must be reachable from the phone. Send fails with `no connection` if not.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| Nothing happens, the notification arrives but no text is sent | The automation isn't triggering. Check the trigger word, that it runs immediately, and try `INTERRUPTION = 'active'` |
| `no HA settings` | The address or token isn't saved. Open settings and press Save |
| `no phone found` | No `notify.mobile_app_...` service exists. Install the companion app, or type the service name in settings |
| `error 401` | The token is wrong or was deleted |
| `error 404` | The notify service name is wrong |
| `no connection` | The phone can't reach Home Assistant |
| `no contacts` or empty lists | The lists haven't reached the watch. Open settings and press Save |
| Reply row never appears | The helpers don't exist, the automation isn't storing messages, or the message is older than three hours |
| Spinner shows for a long time | The phone app is slow to start. It stops by itself after 15 seconds |
| A contact is blank or missing | Its name was all emoji or symbols. Rename it |

To see what the phone is doing, run `pebble logs --phone=<phone ip>`. Useful lines start with
`reply check:` and `live updates:`.

## Updating

After installing a new version, open the settings and press Save once so the watch gets fresh
lists.

## Privacy

The recipient and message text travel through your Home Assistant server and Apple's push
service while a text is sent, and the notification is removed from the phone shortly after.
Your token is stored only in the Pebble app on your phone. Keep your Home Assistant address
protected, since anyone with the token can control it.

## Sharing the shortcuts with other people

Build the send and reply shortcuts once, then use Share, Copy iCloud Link to share it. 
The Home Assistant helpers for replies still have to be created by hand.
