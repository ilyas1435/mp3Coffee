---
name: yt-dlp track selection
description: Durable rules for selecting original or dubbed YouTube audio without breaking other extractors.
---

For YouTube alternate audio, yt-dlp's extractor assigns `language_preference = 10` to the original track, `5` to the default track, and `-1` to dubbed tracks. Original-audio selection should prioritize `language_preference > 0` and bypass stream providers that do not expose that metadata.

**Why:** Selecting the lowest-quality stream globally can return a higher-priority dub, while YouTube-specific format names can be invalid on sites such as Internet Archive.

**How to apply:** Gate YouTube client arguments and YouTube format selectors behind YouTube URL detection. Use the site's neutral `best` selector for other extractors, and do not silently fall back to an arbitrary dubbed track when original-track metadata is available.