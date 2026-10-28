# Upload status

Prepared on 2026-10-28. No store media changes have been saved by this agent.

## Chrome Web Store

Blocked by the current browser tool. Both snapshot and screenshot return `The extensions gallery cannot be scripted` for the developer dashboard at `chrome.google.com/webstore/devconsole/`, including the listing editor. The prepared files are in `cws/media/`.

Upload the five numbered screenshots, then the small promo PNG and marquee PNG. Check the store's save and review controls before submitting. Do not cancel the pending 0.1.3 package review without deciding whether the media change needs it.

## Firefox Add-ons

The edit page is accessible and initially showed an empty gallery. The media form was inspected directly at `/developers/addon/coddy-for-browser/edit_media/edit`; it confirms PNG/JPG support and a 2400 x 1800 limit. No video field is present in that media form.

The normal page's media-edit controls did not open reliably, and screenshot attempts disconnected the browser. No file upload or save was attempted through the unstyled standalone fragment because the normal page's upload handler could not be verified. The prepared files and recommended order are in `amo/media/` and `captions.json`.

Use the normal page's Images / Edit section for upload. Save the gallery, reload the page, and confirm the thumbnails and captions persist. English and Russian captions are prepared; image files are shared by AMO locales.

## Repository

This is a media-only branch. The extension version remains 0.1.3. Do not merge merely to upload the images: the existing merge workflow would create another patch release. The store assets can be uploaded without changing the package or merging this branch.
