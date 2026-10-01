VidToTab turns guitar tab videos into clean, printable songsheets, and follows along while you play.

## Download

| Your computer | File |
|---|---|
| Mac with Apple Silicon (M1 or later) | [`VidToTab-{{version}}-arm64.dmg`]({{download}}/VidToTab-{{version}}-arm64.dmg) |
| Windows (64-bit) | [`VidToTab.Setup.{{version}}.exe`]({{download}}/VidToTab.Setup.{{version}}.exe) |
| Ubuntu / Debian | [`vidtotab_{{version}}_amd64.deb`]({{download}}/vidtotab_{{version}}_amd64.deb) (or [`_arm64.deb`]({{download}}/vidtotab_{{version}}_arm64.deb)) |
| Other Linux | [`VidToTab-{{version}}.AppImage`]({{download}}/VidToTab-{{version}}.AppImage) |

Bundled with ffmpeg & yt-dlp.

## First launch

- **Mac:** the app isn't notarised by Apple, so the first launch is blocked. Open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**. Or run:
  `xattr -dr com.apple.quarantine /Applications/VidToTab.app`
- **Windows:** SmartScreen warns about an unknown publisher. Click **More info → Run anyway**.
- **AppImage:** run `chmod +x VidToTab-{{version}}.AppImage` first.

## Updating

New versions are announced in the app. Your songsheets carry over.

## Privacy

Everything stays on your device.

## What's new in {{version}}

{{whats_new}}

---

Found a problem? [Open an issue](https://github.com/{{repo}}/issues) · [Full guide](https://github.com/{{repo}}#readme)
