# pi-reload-hotkey

Reload Pi with **Ctrl+Shift+R**. No runtime dependencies, configuration, or persistent state.

## Install

```sh
pi install npm:@pi-kaush/pi-reload-hotkey
```

Restart Pi or run `/reload`. To load the local source instead:

```sh
pi install ~/dev/oss/pi-kaush/extensions/pi-reload-hotkey
```

## Use

Press **Ctrl+Shift+R**, or run `/reload-hotkey`. The command uses Pi's reload path, including its checks for an active response or compaction. It does not send a model prompt or replace your editor.

Your terminal must report Ctrl+Shift+R as a distinct key combination.

## Disable or remove

Disable the extension with `pi config` and run `/reload`, or remove the package:

```sh
pi remove npm:@pi-kaush/pi-reload-hotkey
```

For a local install, pass the same local path to `pi remove` instead.

The shortcut and command disappear when Pi reloads. Nothing else needs cleanup.
