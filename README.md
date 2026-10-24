# iPhone setup (one time)

## Import shortcut or add it manually as instructed below
  Run this shortcut https://www.icloud.com/shortcuts/1aa2855cb00d4421b62acde19fc6eba9
## Manual setup
  Update to iOS 27.</br></br>
  Allow notifications for the Home Assistant app.</br></br>
  Open Shortcuts, then Automation, then add a new automation and choose Notification.</br></br>
  App: Home Assistant. Filter: title contains your trigger word (default PEBBLE_TEXT).</br></br>
  Set it to run immediately, not "Ask Before Running".</br></br>
  Add these actions: Split Text on the notification's message with the custom separator ||; Get Item from List (first item) as the recipient; Get Item from List (last item) as the text; Send Message with that text to that recipient.</br></br>
  Send yourself a test from the watch.</br></br>
