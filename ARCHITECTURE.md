# Architecture

Three seams carry this codebase. Everything else is detail.

1. **The adapter boundary.** All repository access produces one normalized
   `RepoSnapshot`. Nothing downstream knows where the data came from.
2. **The layout contract.** Layout is a pure function of `(tree, mode,
   options)`. Adding a feature means writing one more conforming function, not
   changing the renderer.
3. **The morph system.** The renderer builds geometry once per repository and
   never rebuilds it. Every view change is an interpolation between two
   attribute sets, driven by one uniform.

If a future change requires touching the renderer to add a view, one of these
has been broken.

```
/packages
  /core        pure TypeScript. no three, no react, no node builtins.
               types, topology inference, layout, points of interest,
               lenses, search, the flat SVG silhouette.
  /web         vite + react + three. renderer, morph system, sound, interface.
/apps
  /site        vercel deployment: the viewer plus serverless routes.
```

`core` has one runtime dependency (zod) and imports nothing that assumes a
browser. That is what lets the same layout code run in a worker, in a Node
serverless function drawing a share image, and in a unit test with no DOM.

---

## 1. The adapter boundary

`core/src/types.ts` defines `RepoSnapshot` and validates it with zod. Every
source parses through `parseSnapshot` at the seam, so malformed data fails
where the stack trace still points at the source rather than deep inside a
layout function.

```ts
type RepoSnapshot = {
  schemaVersion: 1;
  name: string;              // "owner/repo"
  description: string | null;
  head: string;
  defaultBranch: string;
  source: 'github' | 'local';
  truncated: boolean;
  generatedAt: string;
  commits: Commit[];
  refs: Ref[];
  tree?: { path: string; size: number }[];   // only for directory mode
};
```

The viewer reads `source` for one thing: a badge. There is no other branch on
it anywhere in the codebase.

### Adding the local CLI (v2)

A CLI for private repositories is planned and is not built here, but the shape
it slots into already exists. It needs to:

1. Read a local repository with `git log --format=... --numstat` and
   `git for-each-ref`.
2. Emit a `RepoSnapshot` with `source: 'local'`.
3. Serve it, or write it to a file the viewer loads.

Nothing in `core`, in the renderer, in the sound engine or in the interface
changes. The one place to touch in `web` is `state/repo.ts`, which gains a
sibling to `fetchRepo` that reads from the CLI's endpoint instead of `/api`.

The contract already carries two fields GitHub's API cannot supply and a local
git can: `Commit.ext` (the dominant file extension a commit touched) and
per-commit file lists. The file-type lens is written against `Commit.ext` and
reports itself unavailable when the source cannot populate it, rather than
inventing a value. That lens will start working on local repositories without
a line of lens code changing.

---

## 2. Topology inference

Git does not store branch membership. Once a branch is merged and deleted,
nothing records which commits belonged to it. `core/src/topology.ts` infers it:

```
1. Index commits by oid; build the child -> parent adjacency.
2. TRUNK: from HEAD, follow parents[0] to a parentless root.
   Claimed, limb 0, depth 0.
3. For each trunk commit with 2+ parents, reverse chronologically:
     for each parent p after the first:
       walk p by first-parent until reaching a claimed commit.
       That chain is a limb; attachPoint is the merge commit.
4. Rescan each new limb for its own merges, so a merge into a feature
   branch yields a sub-limb. Depth capped at 6; deeper chains fold
   into their parent.
5. DANGLING: refs pointing at unclaimed commits become limbs with
   rejoined = false. They grow off into space and never rejoin.
6. Anything still unclaimed attaches to its nearest claimed ancestor
   as a stub. Grafted second roots land here.
```

Breadth-first over a work queue rather than recursive, because a deep history
would otherwise blow the stack. Every first-parent walk carries a visited set:
a cycle is impossible in a well-formed DAG but rewritten history produces
malformed input, and without the set this hangs instead of failing.

Handled explicitly, with a fixture DAG each: octopus merges, grafted histories
with multiple roots, shallow clones whose parents are absent from the snapshot,
single-commit repositories, empty repositories, and cycles.

### Squash-merged histories

A repository that squash-merges has a linear first-parent history with no merge
commits, and the algorithm above yields a bare pole. Detected as
`mergeCommitCount / totalCommits < 0.02`. A squashed pull request still reports
how many commits it originally had, which is enough to reconstruct a limb of
the right length hanging off the squash commit.

Reconstructed commits are flagged `synthetic`, their limbs `synthesized`. They
render ghosted and dashed, they never link out to a SHA that no longer exists,
and the interface says so while they are on screen. **Inferred structure is
never presented as recorded structure.**

### Directory mode

If topology yields fewer than three limbs and there is no pull request data to
rebuild from, `buildDirectoryTopology` produces a `TreeStructure` from the file
tree at HEAD instead: directories are limbs, commits are distributed across
them by a stable hash weighted by file count, and history still drives growth.

It is a `TreeStructure` like any other, so every layout mode, the renderer, the
sound engine and the interface work on it unchanged. It is labelled in the
interface, because the shape is then the repository's layout rather than its
history.

---

## 3. The layout contract

```ts
export function layout(
  tree: TreeStructure,
  mode: LayoutMode,
  opts: LayoutOptions,
): LayoutResult;
```

Pure. Imports nothing from Three.js, touches no scene object, allocates its own
output. It runs on a worker for the viewer and inline for the share image.

### The invariant everything depends on

**Array lengths are identical across every mode and every time setting.** A
commit a view does not show gets scale 0, never a shorter array. A limb slot
with nothing in it collapses to a point with `limbVisible = 0`.

This is what makes GPU morphing possible: two layouts are always
element-for-element comparable, so a transition is `mix(a, b, t)` per vertex
and nothing else. Break it and every transition becomes a CPU geometry rebuild.

Limb slot count is `max(limbs, authors + 1)` — sized once per repository for
the largest requirement any mode has, which is why `byAuthor` can morph into
`tree3d` even though contributors and branches are different things.

Enforced by tests over every mode, every ring granularity, and every window and
growth combination.

### Fixed vertex counts

Every limb gets exactly `limbSegments` rings of six vertices regardless of its
length or commit count. Growth does not drop rings; it *compresses* them into
the grown portion, sampling the spine at `u * g`. That is why the tip advances
continuously instead of stepping from segment to segment, and why growth needs
no geometry regeneration.

### The geometric rules

- **Thickness from the pipe model.** `radius = sqrt(sum(childRadius²) +
  leafArea)`, computed depth-descending, with `leafArea` seeded from commit
  count. Taper runs from `radius` at the base to `radius * 0.4` at the tip.
  Correct-looking taper falls out of the arithmetic rather than being authored.
- **Placement by phyllotaxis.** Sibling limbs step around their parent at the
  golden angle from an offset seeded by a stable FNV-1a hash of the parent's
  label. Two consequences, both wanted: limbs avoid each other without any
  collision code, and the same repository produces a byte-identical tree on
  every machine and every reload. There is no `Math.random` anywhere in `core`.
- **Height from compressed time.** Gaps longer than three ring units clamp to
  three ring units, then `sqrt`, then normalize over the window. A two-year
  silence becomes a short seam instead of a bare pole, and bursts stay dense.
- **Length from data.** A branch's rise is the greater of its time span and a
  floor derived from its commit count, so a branch opened and merged within an
  hour is still a visible branch.

### The unfold

`tree2d` is not a separate layout. It is `tree3d` with `thetaCompression: 1`,
collapsing each limb's azimuth toward the XY plane with a seeded nudge so no
two land on top of each other. Interpolating that one scalar is the entire
unfold. A test asserts the two produce byte-identical output.

### Ring granularity and the time window

Both live in `LayoutOptions`, both are pure inputs, and both therefore morph
for free.

The gap clamp is `ringUnit * 3`. The coupling is the point: a decade viewed at
year granularity should compress multi-month gaps hard, and the same repository
viewed at hour granularity across one day should compress almost nothing.
Decoupling them gives a bare pole or an unreadable pancake whenever the reader
changes granularity.

The default granularity is the finest unit yielding roughly 8 to 60 rings
across the current window, never a fixed one. Ring boundaries are decimated
once minors exceed a cap, and majors always survive, so rings never fuse into a
solid band at any granularity.

The window renormalizes height over itself, so a fortnight inside a ten-year
repository fills the view rather than sitting as a sliver. Commits before it
collapse into a ghosted stump with a count, rather than being deleted — hiding
them severs the tree from the ground and destroys the sense of scale.
`growthCutoff` is relative to the window, so playing growth after selecting a
range grows only that range.

---

## 4. Two renderers

`web/src/render/backend.ts` is the whole contract. Above it, nothing knows how
the tree is drawn; below it there are two implementations of `RenderBackend`.

| | `WebGLBackend` | `Canvas2DBackend` |
|---|---|---|
| Drawn by | Three.js on WebGL 2 | a software rasterizer on a 2D context |
| Cost | two draw calls, all morphing on the GPU | ~10 ms a frame at 1,400 commits |
| Gives up | nothing | ambient sway on limbs, per-pixel bark lighting, the higher render scale while flying |
| Needs | a WebGL 2 context | a canvas |

**Three.js is the 3D stack, and was already.** Three's `WebGLRenderer` has been
WebGL 2 only since r163, so "use Three.js" and "target WebGL 2" are the same
decision. WebGL 2 is Chrome 56, Edge 79, Firefox 51 and Safari 15 — over 97% of
browsers. Three's `WebGPURenderer` would be a step backwards on reach, not
forwards: WebGPU is not in Firefox on Linux, not in Safari before 26, and is
still disabled behind flags on a good deal of hardware.

What is left over after 97% is not old browsers. It is current ones with WebGL
switched off: Firefox and Brave both do it under fingerprinting protection, an
enterprise policy or a blocklisted driver does it on machines that are
otherwise fine, and a virtual desktop often has no GPU to offer. That is why
the second backend is a renderer and not an apology — the old fallback was a
static SVG drawn on the server, which has no growth, no orbit, no lenses and no
clicking a commit.

Three.js is still doing the arithmetic in the fallback. `Matrix4`,
`PerspectiveCamera` and `Raycaster` have no WebGL dependency, so `camera.ts`
and `morph.ts` are literally the same code under both backends. Only the
drawing differs.

### Choosing

`capabilities.ts` asks for a WebGL 2 context and reports what came back. No
user-agent parsing: the browsers that matter here are exactly the ones that
lie about who they are, or that report a stock Chrome build with WebGL disabled
behind a shield. The probe context is released through `WEBGL_lose_context`,
because browsers cap live contexts per page and a leaked probe can cost the
real renderer its own.

`?renderer=2d` forces the software path and `?renderer=webgl` forces the GPU
one, which is how the fallback gets exercised on a machine that has a GPU.

### Losing the context

Not an edge case. Mobile Safari and Chrome both drop contexts under memory
pressure, a driver reset takes one out on the desktop, and a GPU process crash
takes out every context on the page. `webglcontextlost` is preventDefault-ed so
the browser will hand one back, and on `webglcontextrestored` **nothing is
rebuilt**: Three recreates every GPU-side cache and re-uploads each buffer from
the JavaScript array that owns it on the next frame. Rebuilding would hand the
new context handles belonging to the old one, which is a screenful of
`INVALID_OPERATION` and no benefit. Only the settings held on the renderer
rather than in a resource — pixel ratio, output colour space, clear colour —
are re-applied.

If the context does not come back within six seconds, the viewer swaps to the
software renderer rather than leaving a frozen canvas that looks like a hang.
A canvas holds exactly one kind of context for its whole life, so the swap
bumps a generation counter, React hands back a fresh `<canvas>`, and the normal
mount path runs again.

### One picture, two ways of drawing it

Both backends draw into the same 480×270 grid and quantize to the same
twenty-four colours, so the fallback is a quieter version of the same picture
rather than a different product. The rasterizer holds a palette index per pixel
rather than RGB, resolved at write time through a 5-bit-per-channel lookup
table built once, and stores **reciprocal** depth: 1/z is the only quantity
that interpolates linearly in screen space, and the ground plate — seen almost
edge on, spanning a thousand units of depth in a few dozen rows — is exactly
the shape that gets visibly wrong ordering otherwise.

A limb is a screen-space ribbon shaded in five strips across its width, with
the tube normal reconstructed from how far across each strip sits: a point `u`
of the way to the edge has a normal `u` across and `sqrt(1 - u²)` toward the
camera. That is the normal the shader would compute, so the two agree as the
camera orbits rather than only at one angle. Below a couple of pixels the limb
takes the *average* across the tube instead of the value at its centre, because
a one-pixel limb shows its whole visible half in that pixel — taking the centre
hands every thin limb the brightest normal there is whenever the key light is
behind the viewer, which turns a distant canopy into white wire.

---

## 5. The morph system

`web/src/render/`. Two systems, both morphable, both built once.

- **Leaves.** One `InstancedBufferGeometry` of two-triangle quads, one instance
  per commit, capped at 20,000. Billboarded in view space.
- **Limbs.** One merged `BufferGeometry` for every limb, with an index buffer
  built once and never touched. Not one `TubeGeometry` per limb, which would be
  500 draw calls before the first leaf.

Both carry `aPositionA` / `aPositionB`, `aScaleA` / `aScaleB` and `aDelay`:

```glsl
float morphT(float delay) {
  float s = smoothstep(delay, delay + 0.6, uProgress);
  return mix(1.0 - s, s, uToB);
}
```

`aDelay` comes from limb depth, so the tree changes trunk-outward rather than
all at once.

**A and B alternate; they are never copied back.** A transition writes into
whichever set is idle and flips `uToB`. That halves the buffer traffic of the
copy-back approach and means a transition costs one upload and nothing per
frame.

Limb normals are rebuilt in the vertex shader from a morphed ring centre
(`normalize(position - center)`), so no CPU normal pass is needed at any point
in a transition.

### Growth

Growth is the scrubber's `growthCutoff` animated from 0 to 1. Implementing the
scrubber first made the intro free.

It runs on two clocks that agree by construction:

- **Limb truncation and leaf positions** come from worker keyframes at roughly
  20 Hz, interpolated to 60 fps by the same morph system as every other
  transition.
- **Leaf appearance** is gated per-instance in the vertex shader against
  `aHeight` (the leaf's own normalized time) versus a `uGrowth` uniform updated
  every frame.

The second clock exists because leaf appearance is the thing the eye tracks and
the thing the sound is locked to. A leaf appears at exactly its moment rather
than at the next keyframe, and the sonification scheduler advances against the
same normalized cursor, so audio and picture cannot drift.

`LayoutResult` carries `leafScales` (gated, what everything else reads) and
`leafSizes` + `leafHeights` (ungated, what the shader gates itself). The two
extra arrays are the only concession the pure contract makes to the renderer,
and they are additive.

### Camera

One `PerspectiveCamera` throughout. Blending orthographic and perspective
projection matrices is fiddly and wrong at the midpoint, so the flat state is a
FOV of 8 degrees pulled far back — visually orthographic, and one scalar to
animate alongside the morph. Distance is derived from FOV so framing stays
constant while it moves, and the camera squares up to the plane as the FOV
narrows, because a flat drawing seen at an angle reads as a bad 3D view.

Depth haze is measured relative to the current camera distance, not in absolute
units. An absolute range washes the entire tree to the background colour the
moment the flat state pulls the camera back — this was a real bug, found by
driving the actual app.

### Picking

Analytic, on the CPU, against positions interpolated with the same per-instance
delay the shader uses. Three's instanced raycasting reads an instance matrix
this renderer deliberately never writes, and 20,000 point-to-ray distances cost
less than maintaining those matrices would.

### The pixel pipeline

Scene renders into a `WebGLRenderTarget` around 480 by 270, nearest filtering
both ways, no mipmaps, no antialiasing. A post pass quantizes to the 24-colour
palette by nearest match **in linear space**, with a 4×4 Bayer dither to break
banding. The Bayer matrix is evaluated rather than looked up: a
`float[16](...)` initializer is GLSL ES 3.00 syntax, and it only compiled at all
because Three silently rewrites every `ShaderMaterial` to `#version 300 es` —
an internal detail of one library version, in the one file whose job is to be
portable.

Leaf size is computed in whole render-target pixels, not whole world units.
`uPixelScale` is how many world units one pixel spans at unit depth; multiplying
by a leaf's own depth gives the size of a pixel where that leaf actually is.
Clamping that ratio between 1 and 9 pixels is what stops a forty-commit
repository drawing its whole history below one pixel and a fly-to filling the
frame with a single diamond — both were the same bug, a size fixed in world
units applied as a view-space offset. Snapping it to a whole pixel is what
stops a leaf rendering as a half-lit smear. `leafSize.ts` holds the numbers and
both backends use them.

Vertex positions snap to the low-resolution grid in clip space before the
perspective divide:

```glsl
vec4 clip = projectionMatrix * mvPosition;
vec2 grid = uResolution * 0.5;
clip.xy = floor(clip.xy / clip.w * grid) / grid * clip.w;
```

This single technique is what separates convincing pixel art from a blurry
downscale. Without it, orbiting makes every edge crawl at sub-pixel scale and
the result reads as a broken video stream.

All interface renders as ordinary DOM at full resolution on top. No bitmap
fonts.

---

## 6. Adding a feature

The test of this architecture is that new features are layout functions or
attribute writes, never renderer changes.

| Feature | Where it goes |
|---|---|
| A new arrangement (by file, by directory, by tag) | One more `LayoutMode` branch in `layout.ts` |
| A new lens | One more case in `lenses.ts`; writes tone, family, emphasis |
| A new jump target | One more entry in `poi.ts` |
| A new time control | One more field in `LayoutOptions` |
| A new data source | One more module emitting `RepoSnapshot` |

Search dims non-matches by writing `aDim`. Falling leaves write `aFallStart`
and a parabola in the vertex shader does the rest — no physics engine, and
thousands of them cost nothing. Both move zero vertices on the CPU.

---

## 7. The serverless layer

`apps/site/api/`.

- `repo/[owner]/[name].ts` — one page of history. GraphQL, not REST: REST needs
  a request per commit for diff stats. The first page is smaller so the seed
  state is ready fast; the rest streams while the reader takes in the landing
  copy. `parents(first: 8)`, not 2, because octopus merges are legal. Capped at
  2,000 commits, `s-maxage=3600, stale-while-revalidate=86400`, per-IP rate
  limited so someone scripting random repositories burns their own budget.
- `silhouette/[owner]/[name].ts` — the flat SVG. Now only reached when a
  browser refuses a 2D canvas as well as WebGL, which is rare enough to be worth
  saying plainly; its main job is the share card below.
- `og.ts` — the share card. The same SVG, rasterized to PNG by resvg.

The card carries no text. Every platform renders `og:title` and `og:description`
as type beside the image, so baking the repository name into the picture only
duplicates it — and leaving it out means the renderer needs no fonts, which is
what lets this be a plain SVG through a rasterizer rather than a layout engine
with an asset bundle behind it. `@vercel/og` is not used: outside Next.js it is
an unsupported external for Edge Functions, and its Node build wants both
`__dirname` and `import.meta.url`, which do not coexist in an ESM function.

The SVG renderer lives in `core` and reads the same `LayoutResult` the GPU
does, so a share card is the same tree, at the same window and granularity, as
the link it points at. It is the last-resort fallback and the share image from
one piece of code because they are the same picture.

The token is server-side only and never reaches the client. `GITTREE_LIVE=1` is
required to use it in development, so an ambient `GITHUB_TOKEN` in a shell —
usually scoped to something else entirely — cannot be spent by accident.
