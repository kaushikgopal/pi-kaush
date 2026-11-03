# pi-intercom-hotkey

Copy the current pi-intercom session ID with **Ctrl+Shift+I**. The shortcut copies only the ID; it does not change the editor or send a message. It requires pi-intercom to be loaded.

## Install

Install the local package:

```fish
pi install ~/dev/oss/pi-kaush/extensions/pi-intercom-hotkey
```

Restart Pi or run `/reload`.

## Use

Press **Ctrl+Shift+I** in the session you want to contact. Paste the ID into another Pi session and ask it to send a message using intercom. Both sessions must be reachable through the same broker and pool for local messaging.

The shortcut uses the active intercom ID, which may differ from the Pi session ID when intercom uses a stable ID or an identity claim. The installed pi-intercom version exposes this ID through `PI_INTERCOM_SESSION_ID`. If intercom is not loaded or the ID is unavailable, nothing is copied.

Pi uses the local clipboard. Over SSH, Pi also sends an OSC 52 clipboard sequence to the terminal. For remote Rex connections without SSH environment variables, `PI_CLIPBOARD_OSC52=1` enables the same sequence. The terminal client must support OSC 52; Rex iOS support has not been verified.

The shortcut requires a terminal that reports Ctrl+Shift+I as a distinct key combination.
