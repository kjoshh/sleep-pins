# Sleep Pins

> **No longer needed.** Helium 0.22.2.1 and later has persistent pinned tabs built in ([imputnet/helium#2931](https://github.com/imputnet/helium/pull/2931)).

<img src="icons/icon128.png" width="64" align="right" alt="">

A little browser extension for [Helium](https://helium.computer) that makes pinned tabs stick around.

- Closing a pinned tab puts it to sleep instead of losing it.
- Sleeping pinned tabs are skipped when you switch tabs.
- Pinned tabs come back after a restart.

## Install

1. [Download the ZIP](https://github.com/kjoshh/sleep-pins/archive/refs/heads/main.zip) and unzip it, or run `git clone https://github.com/kjoshh/sleep-pins`.
2. Open `helium://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder. Keep it there.

To really close a pinned tab, unpin it first.

Uses `tabs` and `storage`. Nothing leaves your browser.

[MIT](LICENSE)
