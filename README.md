# iPhone setup (one time)

  Update to iOS 27.</br></br>
  Allow notifications for the Home Assistant app.</br></br>
  Open Shortcuts, then Automation, then add a new automation and choose Notification.</br></br>
  App: Home Assistant. Filter: title contains your trigger word (default PEBBLE_TEXT).</br></br>
  Set it to run immediately, not "Ask Before Running".</br></br>
  Add these actions: Split Text on the notification's message with the custom separator ||; Get Item from List (first item) as the recipient; Get Item from List (last item) as the text; Send Message with that text to that recipient.</br></br>
  Send yourself a test from the watch.</br></br>
