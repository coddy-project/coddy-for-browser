# Store media

Upload-ready assets for Coddy for Browser. These files do not change the extension package or its version. Do not merge a media-only change to `main` just to update a listing: `RELEASE_ON_MERGE` also releases documentation merges.

## Chrome Web Store

Upload the five numbered PNGs from `cws/media/` in numerical order. Each is 1280 x 800, RGB PNG, with no external border or letterboxing. The third image is an explanatory overview assembled from two genuine approval captures, not a single browser state. The last image demonstrates the light theme.

Use `cws/media/promo-small.png` for the 440 x 280 small promo tile and `cws/media/promo-marquee.png` for the 1400 x 560 marquee. Both use the existing Coddy icon, outlined wordmarks and a purple palette. They contain no rating, award, ranking or performance claims. Editable SVG files are beside them.

The Chrome dashboard accepts a YouTube URL for video, not an MP4 upload. Video was explicitly deferred for this set.

## Firefox Add-ons

Recommended order:

1. `amo/media/desktop-sidebar.png`;
2. `amo/media/android-chat.png`;
3. `amo/media/android-approval.png`;
4. `amo/media/android-working.png`.

The Android images retain their original 540 x 1200 portrait size. Their portrait format preserves the mobile interface instead of stretching it into a desktop aspect ratio. AMO's live upload form accepts PNG and JPG up to 2400 x 1800; the documentation's 1280 x 800 guidance describes the display size. `amo/media/android-overview.png` is an optional 1280 x 800 arrangement of the three mobile captures, without overlaid text.

AMO has one screenshot set with localized captions. English and Russian captions, source files and composition notes are in [captions.json](captions.json). No Chrome screenshots belong in this gallery.

## Sources and privacy

The source captures remain unchanged in `docs/screenshots/`. They show the real extension and Coddy web UI; the settings capture has a blank key field, a loopback server address and a generic browser name. The original captures were made with extension 0.1.2; 0.1.3 changed documentation only, not the displayed runtime interface. The displayed Coddy server version is independent of the extension version.

The source files and transformations for every gallery asset are recorded in `captions.json`. Phone captures keep their aspect ratio. The permission overview retains both source captures at native resolution. No generated chat answer or invented product state was added.

## Rebuild

Python 3 with Pillow, and the DejaVu Sans font files at `/usr/share/fonts/truetype/dejavu/`:

```bash
python3 scripts/store-media.py
```

To render the promotional SVG sources, install librsvg and ImageMagick:

```bash
rsvg-convert cws/media/promo-small.svg | convert png:- -background '#100d1a' -alpha remove -alpha off -type TrueColor PNG24:cws/media/promo-small.png
rsvg-convert cws/media/promo-marquee.svg | convert png:- -background '#100d1a' -alpha remove -alpha off -type TrueColor PNG24:cws/media/promo-marquee.png
```

Open [the contact sheet](index.html) to review the set before uploading. Check the saved listing after upload; selecting a file or seeing a successful local build does not prove the gallery was saved. Do not cancel a pending extension review to upload these assets without approval.

Current [upload status and blockers](upload-status.md) are recorded separately. No gallery upload has been saved by this agent.

## Requirements checked

- [Chrome image requirements](https://developer.chrome.com/docs/webstore/images), including five screenshots at most and exact promo sizes;
- [Chrome listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), including YouTube video URLs;
- [Chrome listing best practices](https://developer.chrome.com/docs/webstore/best_listing), including genuine, readable UI and consistent branding;
- [Mozilla listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/), including a recommended 1280 x 800 canvas, translated captions and minimal image text.
