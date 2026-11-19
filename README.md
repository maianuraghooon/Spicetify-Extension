# Artist Songs Plus

A [Spicetify](https://spicetify.app) extension that adds a native-looking song list to every artist page in Spotify desktop.

![Preview](preview.png)

## Features

- **All songs at once.** Every song from the artist's albums, singles and compilations, instead of only the top 5.
- **Play counts.** See how many times each song has been streamed.
- **Sorting.** Click the Title, Year or Plays column label (click again to reverse), or use the dropdown.
- **Filter box.** Type part of a song or album name to narrow the list.
- **Merge duplicates.** A song that appears on both a single and an album is shown once, using the version with the most plays.
- **Play in order.** Click a song to play it, and the songs below it in the current sort order are queued after it.
- **Queue top 50.** Adds the first 50 songs of the current sort to your queue.
- **Discography tab.** Every release with its total play count.
- **Play counts on album cards.** A small label with the total plays on each album and single in the artist page's own Discography section.

## Install

### With Spicetify Marketplace

Open Marketplace in the Spotify sidebar, search for **Artist Songs Plus**, and click Install.

### Manually

1. Download `artistSongsPlus.js` into your Spicetify `Extensions` folder (on Linux this is usually `~/.config/spicetify/Extensions`).
2. Run:

```
spicetify config extensions artistSongsPlus.js
spicetify apply
```

## Notes

- Clicking a song clears your current queue and replaces it with the rest of the list.
- Big catalogs take a few seconds to load, because each release is requested separately.
- The extension reads Spotify's internal data, which Spotify can change without notice. If play counts show "–", please open an issue.
