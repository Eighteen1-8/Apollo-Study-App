# Spell-check dictionaries

Hunspell dictionaries in Chromium's `.bdic` format, from Chromium's `hunspell_dictionaries` repository
(https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries, `main`, downloaded 2026-11-07):

| File | Language | SHA-256 |
|---|---|---|
| `en-AU-10-2.bdic` | English (Australia), the default | `13427b9828773291cde00ba266a58fd5110ba6f1d4b29ed86b49f4b3afdf0a39` |
| `en-GB-10-2.bdic` | English (UK) | `e014c23d2215f093205343b9b8805e17c8d8e115d314d93fd5ba51eadf05cff2` |
| `en-US-10-2.bdic` | English (US) | `b0d80e6b6c5491879365e176ecbd98074602a663429bcfcfb0a5a8375c051f13` |

At start-up `electron/main.cjs` (`setupSpelling`) copies them into `<userData>/Dictionaries`, where Chromium reads them
(checked with Electron 33: en-AU flags "color" and suggests "colour", en-US the reverse). The app never downloads
dictionaries (it stays offline), so a language without a file here can't be picked in Settings → Spelling. To add one,
put its `.bdic` from the same repository here; the language is the file name before the version (`en-CA-10-2.bdic` →
`en-CA`).
