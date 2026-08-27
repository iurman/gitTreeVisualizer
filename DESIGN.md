# Design

The brief left the visual identity open and asked for opinions, a signature
element, and an account of what changed under self-critique. This is that
account. It is written after the fact but the two passes it describes really
did happen in that order, and the second one changed the first.

---

## The fixed constraint

Pixel art, achieved by rendering into a low-resolution target and upscaling
with nearest-neighbour filtering. This was not mine to choose, and it earns its
place twice over.

It forces honest aggregation. At five thousand commits, individually shaded
leaves are a lie: they are two pixels each and no amount of shading makes them
legible. Quantizing to a fixed palette at 480 by 270 means a dense canopy
*becomes* a mass, which is the truthful reading of a thousand commits in one
month. A high-fidelity renderer would draw five thousand distinguishable things
and let the viewer believe they could distinguish them.

It also makes the flat state native rather than degraded. The growth animation
happens in two dimensions, and a flat 2D pixel drawing is a complete thing, not
a 3D render with the depth taken away. The unfold then reads as gaining a
dimension rather than as the renderer finally switching on.

---

## Pass one: the proposal

### Where the vernacular comes from

The subject is time, growth, decay and revision. I went looking at where those
are already drawn: botanical specimen plates, dendrochronological core samples,
geological strata, barograph drums, seed catalogues.

The one I kept is the **cyanotype specimen plate**. Anna Atkins photographed
algae onto Prussian-blue paper in 1843 and made the first book illustrated with
photographs; the process is the direct ancestor of the blueprint. It fits this
project on more than vibes:

- **The exposure logic is the same as the data.** On a cyanotype, the specimen
  is the part light never reached. It comes out pale against the blue. That is
  exactly the figure-ground relationship this needs — a tree standing out of a
  dark field, lit by nothing in particular.
- **It is blue-dominant**, which is rare. The three looks the brief warned about
  are warm-cream-and-terracotta, near-black-with-one-acid-accent, and
  hairline-rule broadsheet. All three are neutral-grounded. Committing to a
  saturated blue field puts the work somewhere none of them are.
- **It is a scientific record, not an illustration.** A plate is evidence. That
  is the right register for something whose entire claim is that the shape is
  verifiable.

### The palette

Twenty-four colours, three tonal families. The post-processing pass quantizes
every pixel to exactly these, so this is the complete colour vocabulary of the
product: a colour not on this list cannot appear on the canvas.

**Ground — the plate.** Eight Prussian blues, from ink to a bleached haze.
Atmosphere, ground plane, interface chrome, depth falloff.

```
#050912  #0A1424  #102138  #17304E  #1F4166  #2A5480  #38689A  #4C82B6
```

**Specimen — the tree, and the type.** Eight steps from blue-shadowed to bone.
The shadow end borrows the plate's colour because on a real cyanotype it does:
the shadows on a pressed specimen are the paper showing through.

```
#1E2C3A  #324152  #4C5A6A  #6C7681  #8D9490  #B0AFA0  #D3CCB6  #F3EFDE
```

**Reaction — what the chemistry does when something happens.** Verdigris,
sulfur, iron oxide. Lens encodings, merges, warnings, the growth cursor.

```
#1E7F6A  #2FA98C  #5CCBAE  #A99A3C  #D6C356  #EFE08A  #A8482E  #D9714B
```

Lenses recolour strictly within one family, which is why five lenses never
break the plate's cohesion: the age lens walks the specimen ramp, the author
lens spreads over the reaction family at golden-ratio spacing so adjacent
contributors never land on adjacent tones, and the deletions lens is the only
one that crosses — from specimen shadow into oxide, because that is the point
it is making.

### Type

Three faces, three jobs, and the display face is rationed.

- **Old Standard TT** for display. A 19th-century scholarly Didone, the type
  actually set on specimen plates and scientific monographs. It appears on the
  wordmark, the landing headline, and commit subjects. Nowhere else.
- **Archivo** for body. A grotesque descended from 19th-century American
  gothics — the type on catalogues, forms and labels. It pairs with a Didone
  the way a herbarium label pairs with the plate's engraved caption, and it
  does not read as the default UI sans that Inter has become.
- **IBM Plex Mono** for the utility layer. SHAs, counts, dates, ring labels.
  It comes out of technical documentation and instrumentation, which is the
  register the numbers here are in.

All interface type renders as ordinary DOM at full resolution over the
pixelated canvas. No bitmap fonts. Crisp type on chunky pixels is a deliberate
pairing — it says the pixels are a choice about the *subject*, not a limitation
of the *medium* — and it keeps the entire interface layer as normal React with
normal focus rings and normal screen-reader behaviour.

### Layout

Instruments around a specimen. The canvas is the full viewport and everything
else is a rule, a gauge or a label laid over it:

- A **top rule** carrying the wordmark, the repository's identity and its
  counts, search, and audio.
- A **left rail** of controls, set in a bordered segmented column like a
  switch panel.
- A **right rail** of named places to go, which reads as an index to the plate.
- A **bottom rule** — the specimen rule — carrying the density histogram, the
  range brush, the growth cursor and the granularity control, all on one axis
  because they are all the same axis.

Registration corner marks on the landing plate, a one-pixel border vocabulary,
and no border radius anywhere. Not because hairline rules are fashionable, but
because a plate has a plate mark.

### The signature element: the core sample

A dendrochronologist reads a tree by driving an increment borer into the trunk,
pulling out a pencil-thin core, and laying the rings out flat on a mounting
board.

The **core sample gutter** is that core, taken from the tree currently on
screen. A narrow vertical strip down the left of the canvas showing every ring
boundary at its true compressed-time height, majors heavier than minors, with
the grown portion tinted and the pre-window stump hatched at the bottom.

It does four jobs with one object:

1. It is the ring legend — it shows what the granularity control actually does
   to the trunk, which is otherwise invisible until you look closely at the
   bark.
2. It is the growth read-out, because the tinted region is the cursor.
3. It is the vertical minimap, since its axis is the trunk's axis.
4. It is the thing the site is remembered by, because nothing else on the web
   has one.

It disappears in the modes that have no vertical time axis. Showing a core
sample next to the by-author view, or next to the timeline where time runs
along X, would be a lie about what the strip measures — and the whole product
rests on not lying about what the shape means.

---

## Pass two: the critique, and what changed

The test the brief set: *would I have arrived at this same proposal for an
unrelated brief?* Two of the answers were uncomfortable.

### The palette could not do its job

**The problem.** A cyanotype is monochrome by definition. That is the whole
process: one iron salt, one hue, tone varying only by exposure. My first
proposal was faithful to that, and faithful to it was *broken*, because the
author lens needs categorical colour. Fifteen contributors cannot be
distinguished along a single blue ramp, and neither can file types. I had
proposed an identity that made a shipped feature impossible.

The obvious repair — bolt on an accent palette — is exactly the move that
produces default look number two. Any set of bright categorical hues over a
dark ground is the generated-interface house style.

**What changed.** I went back to the process instead of to a colour picker.
Cyanotype is one iron chemistry among several that 19th-century photographic
and botanical printing used, and iron does more than Prussian blue: it makes
verdigris where it meets copper, iron oxide where it weathers, and sulfur
appears in every darkroom of the period. So the third family is not an accent
imported from outside — it is the same subject's other reactions.

That reframing had a consequence I would not have got from a colour picker: it
told me which lens gets which family. The deletions lens is the only one that
moves a commit *out* of the specimen family and into oxide, because oxidation
is what the reaction family means. The encoding is now legible without the
legend, which is the test of whether a colour system is doing work or just
being applied.

### The signature element was decoration

**The problem.** My first signature was a decorative "plate frame" — corner
marks, a printed caption block, an edition number. Would I have proposed that
for an unrelated brief? Yes. Absolutely yes. It is a frame; it goes around
anything; it is the visual equivalent of a stock photo. It also failed a
harder test: remove it and nothing about the product becomes harder to use.

**What changed.** I replaced it with the core sample, which is load-bearing. It
came out of a real problem rather than a search for a motif: ring granularity
is one of the more interesting controls here, and it was illegible. A reader
switches from months to weeks and the bark changes in a way they cannot see at
canopy zoom, so the control feels inert. The core sample makes the choice
visible at a glance, and it happens to be the exact instrument a real
dendrochronologist would reach for.

The frame survives, demoted: the corner marks are still on the landing plate,
where framing is all they need to do.

### What survived unchanged

The cyanotype ground, the blue-dominant commitment, and the Didone-plus-
grotesque-plus-technical-mono type system. I pushed on each and could not find
a version I preferred. The blue in particular is the single decision doing the
most work to keep this from reading as templated, and the honest reason it
survived is that I could not name another project I would have proposed it for.

---

## Copy

Interface copy is design material and was written as such. Plain verbs,
sentence case, active voice, no filler. Things are named by what the reader
controls, not by how the system works — the control says *Age*, not
*recency lens*; the timeline says *Drag to select a range*, not *brush to
filter*.

Errors say what happened and what to do next. "Repository not found, or it is
private. Only public repositories are supported." is the whole message: it
names both plausible causes and closes off the one the reader cannot fix.

The empty state is an invitation to act, and its headline states the claim the
product is making: *Every repository is a tree.* The example list gives each
repository a reason to be picked rather than just a name, because the reason is
the interesting part.

Where the product is inferring rather than reporting, the copy says so in the
interface, not in a footnote: *This repository squash-merges. Branches are
reconstructed from pull requests.* Inferred structure is never allowed to look
like recorded structure — ghosted, dashed, and labelled.

---

## Motion and sound

Motion is either a morph or a camera move; there is no third kind. Everything
that changes the tree interpolates two position buffers on the GPU over about
900 milliseconds, delayed by limb depth so the change propagates trunk-outward.
Camera travel follows a Catmull-Rom arc over 1.2 seconds, and the render target
resolution rises during the flight so a zoom reads as resolving detail rather
than scaling a small image up.

`prefers-reduced-motion` shortens every transition and stops the ambient sway.
It does not touch audio: they are separate concerns and conflating them takes
a channel away from someone who wanted one and not the other.

The ambient bed plays only while the camera is moving. Its purpose is to give
travel a sense of space, so stillness closes it completely — a drone that runs
from the moment audio unlocks until the tab closes is not barely present, it is
just a drone, however quietly it is mixed.

Sound is synthesized, quantized to a minor pentatonic on D, and mixed well
below unity through a compressor and a limiter. It is a sonification, not a
soundtrack: dense commit periods are dense, dormant years are near-silent, and
the throttle aggregates bursts into one louder tick rather than dropping them,
so density stays audible. Default unmuted, because the gesture that starts
growth is also the gesture that opens the audio context — nobody is surprised
by it.
