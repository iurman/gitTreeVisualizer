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

## 4. The morph system

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
banding.

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

## 5. Adding a feature

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

## 6. The serverless layer

`apps/site/api/`.

- `repo/[owner]/[name].ts` — one page of history. GraphQL, not REST: REST needs
  a request per commit for diff stats. The first page is smaller so the seed
  state is ready fast; the rest streams while the reader takes in the landing
  copy. `parents(first: 8)`, not 2, because octopus merges are legal. Capped at
  2,000 commits, `s-maxage=3600, stale-while-revalidate=86400`, per-IP rate
  limited so someone scripting random repositories burns their own budget.
- `silhouette/[owner]/[name].ts` — the flat SVG, for browsers without WebGL.
- `og.tsx` — the share card, embedding the same SVG.

The SVG renderer lives in `core` and reads the same `LayoutResult` the GPU
does, so a share card is the same tree, at the same window and granularity, as
the link it points at. It is the WebGL fallback and the share image from one
piece of code because they are the same picture.

The token is server-side only and never reaches the client. `GITTREE_LIVE=1` is
required to use it in development, so an ambient `GITHUB_TOKEN` in a shell —
usually scoped to something else entirely — cannot be spent by accident.
