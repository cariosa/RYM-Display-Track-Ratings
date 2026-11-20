RYM-Display-Track-Ratings
Shows average track ratings, the track page genre and rankings, and each track's own voted genres and descriptors directly on RYM release pages.

<img width="704" height="1224" alt="Fetched Ratings and Data - RYM Display Track Ratings" src="https://github.com/user-attachments/assets/adbebf47-3282-4491-9ffe-95cb5b2cd4d3" />

Shows each track's own rating, genres, descriptors and chart rankings right on RateYourMusic release pages. RYM normally keeps most of this behind premium, so this saves you the clicks through every track page.

**What you get**
- Average rating and rating count next to each track, with the bold star when RYM shows one
- The track page genre and its chart rankings
- Each track's own voted genres, scenes, movements and descriptors, in a collapsible "Details" block. Items inherited from the album can be hidden.

**How to use it**
A small toolbar appears above the tracklist:
- **Fetch Ratings** loads ratings, page genre and rankings.
- **Fetch track details** loads the per-track genres and descriptors.
- **Show** toggles the display, and the gear menu has Expand all, Page genre beside details, Hide inherited and Clear data for this release.

Click a running fetch button again to stop it. Shift+click refetches everything, even data that is still fresh.

**Please go easy on it.** Fetching sends a lot of requests, and RYM can rate-limit or block your IP. Data is stored on your device and fetch buttons skip anything newer than 7 days. The delay between requests and the cache age are both set from your userscript manager menu. If Cloudflare shows a challenge, the script stops. Solve it in the tab, wait a while, then continue.

Works on Firefox mobile too.

**v2.0:** rewritten and now stores data per song and per release. Anything saved by v1 is not carried over, so you'll need to fetch it again.

## Installation

- install a userscript manager like [violentmonkey](https://violentmonkey.github.io/) on your browser.
- install this userscript from [greasyfork](https://greasyfork.org/en/scripts/527869-rym-display-track-ratings).
