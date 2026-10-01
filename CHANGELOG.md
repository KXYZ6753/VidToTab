# Changelog

What's new in each release, exactly as it appears under "What's new" on the
release page. Write a version's section before tagging it: the release build
(`scripts/release-notes.mjs`) takes the section headed with the tag's version
and puts it into `.github/release-template.md`. A version with no section here
gets the list of its commits instead.

Major versions are named after the planets, outward from the sun: 0.x (beta)
and 1.x are Mercury, 2.x Venus, 3.x Earth, then Mars, Jupiter, Saturn, Uranus
and Neptune.

## 0.4.0

**Listen.** In Practice, switch **Timer → Listen** (or press **L**). VidToTab reads every note off the page and follows you through the microphone, chords included.
- **Wait for me** holds each note until you play it and turns the page when you finish.
- **Play along** keeps time and scores what you hit.
- Wrong notes are named ("Heard F2, expected A2").
- The first time, it asks for your tuning and capo. If the video already gave them away, they're filled in.
