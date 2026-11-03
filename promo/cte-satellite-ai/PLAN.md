# AI, decoded #1: the satellite that decides what we see (Catch the Error)

**Format:** the explainer with a catch (formats.md #1 shape, taught as "AI, decoded", a numbered series).
**World:** mission control. A dark slate console (not pure black), amber mono telemetry, cream photo prints sliding
out of a downlink slot, a wireframe Earth. Not the paper desk of the last two (Cyclon, Instagram TV).
**The red pen in this world:** a red grease pencil on the console glass (what flight controllers really used).
**Anchor image:** a photo of Earth coming down the downlink, and a stamp: DELETED / NOT SENT.
**Device (one):** the sound is the topic: the camera shutter of the satellite is the beat; every kept photo is a
shutter + downlink chirp, every dropped one a shutter + a dull "not sent" thud.
**Length:** ~50 s + ident. Voice: Sparsh's trained voice (as the last Reels).

## Triple hook (first 2 s)
- **See:** frame 1 the satellite's shutter fires over a cloudy Earth, the photo drops toward a slot, the slot shuts and
  stamps NOT SENT.
- **Read:** "It decides what we **never see**." (red grease pencil under "never see").
- **Hear:** shutter click on frame 1, the stamp thud on "never".

## Beats (voice → picture → text on screen → sound)
| # | Voice | Picture | Text on screen | Sound |
| --- | --- | --- | --- | --- |
| l01 | This satellite decides which photos of Earth we never see. | shutter, photo, slot shuts, NOT SENT stamp | It decides what we never see | shutter, stamp |
| l02 | …two thirds of Earth is under cloud. | REAL: NASA's cloud-fraction map wraps the globe, counter 0 → 67% | ≈ 67% under cloud · NASA (Aqua/MODIS) | soft riser, ticks |
| l03 | So most photos from space are just... white. | REAL: a grid of 9 Sentinel-2 tiles, 6 go white one by one | — (the beat lands on "white") | 6 dull pops, silence on "white" |
| l04 | …a few minutes per pass to send its photos home. | the satellite arcs over a ground dish; a "contact" bar fills and runs out | CONTACT 00:08:00 → 00:00 | telemetry beeps |
| l05 | So in twenty twenty, Europe tried something new. | REAL: Φsat-1 photo, date stamp | Φsat-1 · 2 Sep 2020 · ESA | launch rumble (1 s), stamp |
| l06 | A tiny AI chip… checking every photo for cloud before it's sent. | REAL: the Myriad 2 chip photo; photos pass a scan line, labelled CLOUD / CLEAR | CLOUD ✕ · CLEAR ✓ | scanner sweep, ticks |
| l07 | …radiation for thirty-six hours… | the chip under a beam, a 36 h counter | 36 h of radiation (CERN) | a hum building |
| l08 | …about thirty percent of the data. | a data bar shrinks by 30% | −30% data | the pen tick |
| l09 | …Phi-sat two, the size of a shoebox, runs apps in orbit. | REAL: Φsat-2 image; a shoebox outline beside it; app tiles slide out | Φsat-2 · 16 Aug 2024 · 6U | three soft pops |
| l10 | Spot ships. Draw street maps. Find wildfires. | one tile per word, the pen ticks each; REAL: ship, map, fire stills | ships · maps · fire | tick ×3 |
| l11 | …send the alert first, before the full picture. | an ALERT card races down the downlink, the full image crawls behind it | ALERT first · picture later | alert ping, whoosh |
| l12 | So, what's the catch? | music cuts, the console dims | what's the catch? | silence, then the pen |
| l13 | If the AI finds no fire, nothing comes down… | the downlink slot stays shut, an empty frame | nothing comes down | a dead click |
| l14 | …mistakes smoke for cloud… | REAL: a smoke plume next to a cloud, the pen asks "which is which?" | smoke? cloud? | the stamp, low |
| l15 | The AI isn't just taking the pictures… | pull back: the whole Earth, the satellite, the shut slot | It decides what we see | music back in |
| l16 | Would you let it decide? Yes or no. | YES / NO buttons on the console | Yes or no? 👇 | two pops |

Every number on screen is the number the voice says. Line l14 is a "what if" (said as "if"), not a reported failure.

## Facts and sources (checked 2026-11-03)
- ~67% of Earth's surface is typically under cloud: NASA, from about a decade of Aqua/MODIS data (Earth Observatory
  says "about two-thirds").
- Φsat-1: ESA, launched 2 Sep 2020; Intel Movidius Myriad 2 chip for cloud screening; ~30% bandwidth saving; the chip
  was tested at CERN for 36 hours. In its first trial it still sent everything down and flagged what it would have
  dropped (so the voice says "checking", not "deleting").
- Φsat-2: 6U CubeSat by Open Cosmos with Ubotica's AI computer; launched 16 Aug 2024 on SpaceX Transporter-11 from
  Vandenberg; apps: cloud detection, street maps, ship detection, image compression, marine anomalies, wildfire.
  ESA on the wildfire app: if no fire or burnt area is detected, no data are returned.
- Fire alerts before the full image: OroraTech runs models on board and sends fire details down within minutes, ahead
  of full images (IEEE Spectrum, 2026).
- A LEO ground-station pass is typically under ~10 minutes ("a few minutes per pass").

## Real media (credit on screen, at least three)
1. NASA cloud-fraction map ("Cloudy Earth", NASA Earth Observatory, public domain).
2. Sentinel-2 tiles, cloudy and clear ("contains modified Copernicus Sentinel data 2026").
3. Φsat-1 and the Myriad 2 chip (ESA / Intel press images, credited).
4. Φsat-2 (ESA / Open Cosmos press image, credited).
5. A wildfire and smoke plume from orbit (NASA Earth Observatory, public domain).
6. Ours: a 10 s screen recording of NASA Worldview over India today (clouds moving), if the owner records it.
