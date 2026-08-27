# Build Prompt: Git History as a Living Tree (v1)

Hand this whole file to a coding agent at the root of an empty repo. It is written to be executed in phases, not one-shot. Each phase has an acceptance check, and later phases assume earlier invariants hold.

**You are expected to make the aesthetic decisions yourself.** Section 9 gives you a process and a set of constraints, not answers. Do not come back asking which palette to use.

---

## 0. What you are building

A single-purpose site at `tree.isaacurman.com` where someone pastes a public GitHub repository URL and watches their commit history grow into a three-dimensional tree, rendered in a pixel-art style, with a procedural soundtrack generated from the repo's own history.

The tree is not decorative. The trunk is the first-parent chain from HEAD. Limbs are real merged branches. Leaves are commits. Thickness, length, and height all derive from repository data. A viewer should be able to verify that the shape reflects their actual history.

The two moments that matter:

1. **The growth.** The tree does not appear. It grows, from seed, in commit order, with sound. This is the whole product. Everything else supports it.
2. **The unfold.** It grows flat, in two dimensions, then unfolds into three and becomes orbitable. This is the reveal.

### v1 scope

In: public GitHub repos, URL paste, deep links, growth animation, 2D to 3D unfold, orbit, search, points of interest, time scrubber, lenses, sound.

Out: accounts, databases, user-uploaded sharing, theme editors, embeds, repo comparison, private repos.

### One deferred feature that shapes the architecture

A local CLI for private repos is planned for v2. You are not building it. But you **must** structure the data layer so it can be added without a rewrite: all repository access goes through an adapter that emits a normalized `RepoSnapshot`, and nothing downstream of that adapter knows or cares where the data came from. See section 3.

---

## 1. Hard invariants

If any of these are violated, the project needs a rewrite later. Treat them as non-negotiable.

**1.1 One data contract.** Every data source produces the identical `RepoSnapshot` shape. The viewer knows only a `source` field, used for a UI badge.

**1.2 Layout is a pure function.** `(tree, mode, options) => positions`. Layout code imports nothing from Three.js and touches no scene objects. Unit-testable with no DOM.

**1.3 The renderer never rebuilds geometry to change views.** Every view change (growth, 2D to 3D, sort, filter, scrub) is a morph between two position buffers interpolated on the GPU. Building the renderer around one static layout is the single failure mode this document exists to prevent.

**1.4 Every limb has a fixed vertex count** regardless of length or commit count. This is what makes limb geometry morphable in the vertex shader alongside leaves. Variable counts mean CPU geometry regeneration on every transition, which will stutter.

**1.5 Growth is the scrubber.** The growth animation is not a special case. It is the time scrubber's `growthCutoff` parameter animated from 0 to 1. Implement the scrubber first, then the intro is free.

**1.6 Node identity is the commit SHA**, stable across every layout, filter, and mode.

---

## 2. Repository structure

pnpm workspaces monorepo. The split exists so v2's CLI can reuse everything above the adapter.

```
/packages
  /core        pure TS. no three, no react, no node builtins.
               types, topology inference, layout, points of interest.
  /web         vite + react + three. the viewer.
/apps
  /site        vercel deployment: web + serverless API routes
```

---

## 3. The data contract

Define in `core/src/types.ts` before writing anything else. Validate with zod at the adapter boundary so malformed data fails at the seam, not deep inside layout code.

```ts
export type Commit = {
  oid: string;
  parents: string[];       // full SHAs, ordered. parents[0] is first parent.
  author: string;
  authorEmail: string;
  date: string;            // ISO 8601
  subject: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  prNumber?: number;
};

export type Ref = {
  name: string;
  oid: string;
  kind: 'branch' | 'tag' | 'remote';
};

export type RepoSnapshot = {
  schemaVersion: 1;
  name: string;            // "owner/repo"
  description: string | null;
  head: string;
  defaultBranch: string;
  source: 'github';        // v2 adds 'local'
  truncated: boolean;
  generatedAt: string;
  commits: Commit[];
  refs: Ref[];
};
```

---

## 4. Phase 1: Topology inference

**Build this first, with tests, before any rendering.**

Git does not store branch membership. Once a branch is merged and deleted, nothing records which commits belonged to it. You must infer it.

### 4.1 Algorithm

```
buildTopology(snapshot) -> TreeStructure

1. Index commits by oid. Build child->parent adjacency.
2. TRUNK: from HEAD, follow parents[0] repeatedly to a parentless
   root. Mark each as claimed, limbId 0, depth 0.
3. For each trunk commit with parents.length >= 2, reverse
   chronologically:
     for each parent p in parents[1..]:
       walk p by first-parent until reaching a claimed commit
       that chain is a limb; attachPoint is the merge commit
       depth = parent depth + 1
4. Recurse step 3 into each new limb so merges into limbs produce
   sub-limbs. Cap depth at 6, fold deeper chains into their parent.
5. DANGLING: refs whose oid is unclaimed become limbs with
   rejoined=false, attached at their merge base. These grow off
   into space and never rejoin.
6. Remaining unclaimed commits attach to their nearest claimed
   ancestor as stubs.
```

### 4.2 Edge cases that will bite you

- **Octopus merges** (3+ parents) are legal. Do not assume `parents.length <= 2`.
- **Multiple root commits** occur in grafted histories. One is the trunk root; others become limbs.
- **Cycles** should be impossible but rewritten history produces malformed input. Keep a visited set and fail with a clear error rather than hanging.
- **Shallow clones** have commits whose parents are absent. Detect missing SHAs and terminate the walk gracefully.
- **Empty or single-commit repos** render a sprout, not a crash.

### 4.3 The squash-merge problem

Modern repos frequently squash-merge, producing a linear first-parent history with zero merge commits. The algorithm above then yields a bare pole. This will happen on the first popular repo someone pastes.

Detect with `mergeCommitCount / totalCommits < 0.02`. Respond by querying `associatedPullRequests` per commit; a squashed PR still reports its original commit count, so synthesize a stub limb of that length and flag it `synthesized: true`. Render synthesized limbs distinctly (ghosted, dashed, whatever fits your art direction) and show a badge: this repo squash-merges, branches are reconstructed from pull requests. Never present inferred structure as recorded structure.

If no PR data exists, fall back to directory mode (section 12).

### 4.4 Acceptance check

Unit tests over hand-built fixture DAGs: linear, single merge, nested merges, octopus, dangling branch, multiple roots, shallow, single commit, empty. All passing with zero rendering code written.

---

## 5. Phase 2: Layout

Still pure. Still no Three.js.

### 5.1 Geometric rules

These are what make it read as a tree rather than a graph drawn with brown lines.

**Thickness via the pipe model.** Real trees obey da Vinci's rule: a branch's cross-sectional area equals the sum of its children's.

```
radius(limb) = sqrt( sum(radius(child)^2) + leafArea )
```

Seed `leafArea` from commit count. Taper from `radius` at the base to `radius * 0.4` at the tip. Correct-looking taper falls out automatically instead of being authored.

**Placement via phyllotaxis.** Distribute limbs around the trunk at the golden angle (137.5 degrees), starting offset seeded by a stable hash of the branch name. Two consequences, both wanted: the same repo always produces a byte-identical tree, and limbs naturally avoid overlap.

**Height from compressed time.** Never map timestamps linearly. A repo with a two-year dormant gap produces a bare stretch of trunk. Use:

```
h(t) = normalize( sqrt( clampGaps(t, maxGap = ringUnit * 3) ) )
```

Bursts read as dense clusters, dead periods compress to a short visible seam. The gap clamp is tied to the ring unit rather than hardcoded, because the right amount of compression depends entirely on the timescale being viewed. See section 5.6.

**Branching angle.** 35 to 50 degrees off the parent axis, jittered by seeded hash, steeper with depth.

### 5.2 The layout interface

Every mode conforms to exactly this. Adding a feature later means writing one more conforming function.

```ts
export type LayoutMode = 'tree3d' | 'tree2d' | 'byAuthor' | 'byChurn' | 'timeline';

export type LayoutResult = {
  leafPositions: Float32Array;   // 3 per commit
  leafScales: Float32Array;      // 1 per commit
  limbVertices: Float32Array;    // fixed count per limb
  limbRadii: Float32Array;
  bounds: { min: [number,number,number]; max: [number,number,number] };
};

export function layout(tree: TreeStructure, mode: LayoutMode, opts: LayoutOptions): LayoutResult;
```

**Array lengths must be identical across every mode.** A commit hidden in a view gets scale 0, never a shorter array. This is what makes morphing possible.

### 5.3 The modes

- **`tree3d`** The canonical form, limbs distributed radially.
- **`tree2d`** Not a separate layout. It is `tree3d` with `thetaCompression: 1.0`, collapsing every limb's angle toward a plane then fanning in plus/minus X to avoid overlap. Interpolating that one parameter is the entire unfold.
- **`byAuthor`** Alternative topology: each contributor is a primary limb, their commits sub-branches. This is no longer the repo's real structure, so label it in the UI.
- **`byChurn`** Real topology, limbs reordered and rescaled by lines changed.
- **`timeline`** Everything collapses to a horizontal spine with commits as ticks. The "it was just data all along" reveal.

### 5.4 Lenses

Lenses move nothing. They write per-instance color and scale attributes only, so they are nearly free and always preserve real topology. Ship all of: author, recency, churn, deletions, file type.

### 5.5 Growth

`growthCutoff: number` in `LayoutOptions`, 0 to 1, mapped through the same compressed time scale as height.

- Leaves with normalized time above the cutoff get scale 0.
- Limbs truncate at their last visible commit, with the tip interpolating between segments so growth is continuous rather than stepping segment to segment.
- A limb does not begin to sprout until the trunk has grown past its attach point. This ordering is what makes the growth read as botanical instead of as a progress bar.

### 5.6 Ring granularity and time window

Two user-facing time controls, orthogonal to each other and to `growthCutoff`. Both live in `LayoutOptions`, both are pure inputs to layout, and both therefore morph for free.

```ts
export type RingUnit = 'hour' | 'day' | 'week' | 'month' | 'year';

export type TimeWindow = {
  start: string;   // ISO 8601
  end: string;
};

// added to LayoutOptions
ringUnit: RingUnit;
window: TimeWindow;
growthCutoff: number;   // 0..1, relative to the window, not the repo
```

**Ring granularity** controls where growth rings are drawn on the trunk and limbs, and it also drives the gap-clamp constant above. A repo viewed at year granularity should compress multi-month gaps hard; the same repo viewed at hour granularity over a single day should compress almost nothing.

Set `maxGap = ringUnit * 3` in the clamp. This is the whole reason the two are coupled: decoupling them produces a tree that is either a bare pole or an unreadable pancake whenever the user changes granularity.

**Auto-select the default.** Never open at a fixed granularity. Choose the finest unit that yields between roughly 8 and 60 rings across the current window, then let the user override. A ten-year repo opens at years; a repo three days old opens at hours. Opening a decade-old repo at hourly granularity would ask for 87,000 rings.

**Cap ring rendering regardless of granularity.** If the selected unit yields more rings than can be drawn legibly, draw only every Nth ring at full weight and render the rest as a subtle texture, or drop them entirely below a screen-space spacing threshold of a few pixels. Rings must never become a solid band. Emphasize the next unit up (month boundaries when viewing days, year boundaries when viewing months) with a heavier weight so there is always a readable hierarchy.

**Time window** selects a sub-range of history. Three consequences to handle deliberately:

1. **Renormalize height to the window.** A two-week window in a ten-year repo should fill the view, not sit as a sliver near the top. `normalize()` operates over the window, not the repo. Because this is a layout change, the transition into a narrower window is a morph and the tree visibly stretches into it, which is the right feel.

2. **Commits before the window get a stump, not deletion.** Hiding them entirely severs the tree from the ground and destroys the sense of scale. Instead, collapse all pre-window history into a short ghosted trunk segment at the base, with a label showing how much is compressed into it ("4,102 commits before this range"). Commits after the window truncate at their tip with a cut-mark treatment.

3. **`growthCutoff` is relative to the window.** Playing the growth animation after selecting a range grows only that range. This is what makes range selection useful rather than a filter.

**Suggest granularity on window change.** When the window narrows enough that the current ring unit produces fewer than about 6 rings, step down a unit automatically, and step up on widening. Make this a suggestion the user can override rather than a lock, and do not fight a manual choice once they have made one.

---

## 6. Phase 3: Renderer and morph system

The load-bearing phase. Get it right and everything after is a day each.

### 6.1 Instancing

- Leaves: one `InstancedMesh`, 2-triangle quad, count = total commits, capped at 20,000.
- Limbs: one merged `BufferGeometry` for all limbs, built once. Not one `TubeGeometry` per limb, or you will have 500 draw calls before drawing a leaf.

### 6.2 GPU morphing

Both materials carry:

```glsl
attribute vec3 aPositionA;
attribute vec3 aPositionB;
attribute float aScaleA;
attribute float aScaleB;
attribute float aDelay;
uniform float uMorph;

void main() {
  float t = smoothstep(aDelay, aDelay + 0.6, uMorph);
  vec3 p = mix(aPositionA, aPositionB, t);
  float s = mix(aScaleA, aScaleB, t);
  ...
}
```

Transition: compute the target layout on a worker (it is pure, so this is trivial), write into the B attributes, animate `uMorph` 0 to 1 over about 900ms, then copy B into A and reset. Zero per-frame CPU work across all instances.

Set `aDelay` from node depth so the tree unfolds trunk-outward rather than all at once.

### 6.3 Camera

**Do not interpolate between OrthographicCamera and PerspectiveCamera.** Blending projection matrices is fiddly and looks wrong at the midpoint. Use one `PerspectiveCamera` throughout; for the 2D state set FOV to about 8 degrees and pull far back. Visually orthographic, and a single scalar to animate alongside `uMorph`. Match `position.z` to FOV so framing stays constant.

### 6.4 Acceptance check

A real repo renders, and a keypress morphs `tree3d` to `tree2d` smoothly at 60fps with 5000 commits on a mid-range laptop. Do not proceed until true.

---

## 7. Phase 4: Sound

Sound is a first-class feature here, not a garnish. The growth animation is a sonification of the repository's history: dense commit periods produce dense sound, quiet years produce near-silence, a big merge is an event you hear.

### 7.1 Synthesize, do not sample

Use the Web Audio API with oscillators, filtered noise, and envelopes. No audio files. Reasons: zero asset weight, no loading delay before the hero moment, and every event can be parameterized by real commit data instead of picking from a handful of fixed clips.

Suggested voice mapping, adjust to taste:

- **Leaf appearing**: very short filtered noise burst, a tick. Pitch and brightness scale with commit size.
- **Limb sprouting**: short pitched tone with a soft attack. Pitch by limb depth, so deeper branches are higher.
- **Merge**: two tones converging to a unison.
- **Ring boundary**: a low resonant marker, barely audible, fired as growth crosses each ring. Because ring unit is user-selectable, this is what gives a chosen timescale an audible pulse. Fire on the emphasized rings only when minor rings are dense, or it turns into a drum roll.
- **Granularity change**: a short pitched sweep, up for finer, down for coarser.
- **Hover**: a very quiet high tick.
- **Click and mode change**: a short two-note motif, the second note pitched by which mode was entered so each view has an identity.
- **Falling leaf**: descending filtered noise, quiet.
- **Ambient bed**: a low drone whose filter cutoff tracks camera height, so orbiting has a sense of space. Keep it barely present.

### 7.2 The three things that make generative audio not sound like noise

**Quantize every pitch to a scale.** Pick one (pentatonic is forgiving) and snap all generated pitches to it. Overlapping events then never sound wrong, no matter how many fire at once. Without this it will sound broken.

**Pool and throttle voices.** A 5000-commit repo growing over 20 seconds is 250 events per second. Cap concurrent voices at about 8, throttle triggers to roughly 12 per second, and when events exceed the throttle, aggregate them: play one louder, brighter tick representing the burst rather than dropping them silently. Density should be audible.

**Put a compressor and limiter on the master bus.** Overlapping envelopes clip badly without one. Master gain well below 1.0.

### 7.3 The autoplay problem, and the fix

Browsers will not let an `AudioContext` start without a user gesture. If a deep link auto-grows the tree on load, the entire growth sequence plays silently, which is the worst possible outcome for the one moment the product is built around.

**Fix:** deep links do not auto-grow. They resolve the repo, fetch data in the background, and present a planted seed with a single primary action to begin. That click is the gesture that unlocks audio, and it also makes the growth feel chosen rather than missed. Do not treat this as a compromise; a deliberate start beats an animation the user scrolled past.

Create the `AudioContext` inside that click handler and `resume()` it there.

### 7.4 Controls

- Persistent mute toggle, state in `localStorage`, visible at all times, keyboard reachable.
- Default unmuted, since the gesture gate already prevents surprise.
- Master volume slider in a settings popover.
- Mute when the tab is hidden (`visibilitychange`).
- `prefers-reduced-motion` shortens transitions but should not silence audio; they are separate concerns.

---

## 8. Phase 5: Interaction

### 8.1 Entry and routing

- `/` is the landing state: a single input for a GitHub URL or `owner/repo`, accepting both full URLs and shorthand.
- `/:owner/:repo` is a deep link. Resolves, fetches, shows the seed state, begins on click.
- Invalid or private repos get specific copy: "Repository not found, or it is private. Only public repositories are supported." Not "Something went wrong."
- A small set of interesting example repos on the landing state, chosen for having genuinely varied tree shapes. Pick ones with real merge topology, not squash-only repos.

### 8.2 Picking

Raycast the leaf `InstancedMesh`, read `instanceId`, map to SHA. Hover shows a tooltip. Click opens a detail panel with subject, author, date, diff stat, and a link to the commit on GitHub.

### 8.3 Points of interest

Precompute in `core`, expose as jump targets: oldest commit, newest, largest single edit, largest deletion, longest-lived branch, busiest day, first commit by each contributor.

Navigation flies the camera along a Catmull-Rom spline to an offset from the target, easing in and out over about 1.2 seconds. While flying, raise the pixel render target resolution so the zoom feels like it is resolving detail rather than scaling up. Restore on arrival.

Also implement keyboard DAG walking: arrows move to parent, child, previous sibling, next sibling, camera following. Almost nobody implements this and it is unreasonably satisfying.

### 8.4 Falling leaves

When the deletions lens marks a commit net-negative, write the current time to a per-instance `aFallStart`. The vertex shader does the rest. No physics engine.

```glsl
float age = uTime - aFallStart;
if (aFallStart > 0.0 && age > 0.0) {
  float fall = 0.5 * uGravity * age * age;
  p.y = max(uGroundY, p.y - fall);
  p.x += sin(age * 2.0 + aSeed * 6.28) * 0.35 * min(age, 2.0);
  p.z += cos(age * 1.7 + aSeed * 6.28) * 0.35 * min(age, 2.0);
}
```

Clamp at ground so they pile up at the base. Thousands cost nothing.

### 8.5 Search, minimap, scrubber

- **Search** over subject, author, and SHA prefix with a small client-side index. Matches highlight via the lens attributes, non-matches dim, Enter flies to the top match.
- **Minimap and range brush**: a thin commit-density histogram pinned to the bottom edge, spanning the repo's full life, synced to camera height. This is also the range selector: drag on empty track to brush a new window, drag the handles to resize, drag the middle to pan, double-click to reset to full history. Show the selected window as a bright region and the rest dimmed. Because the histogram shows density, users can see where the interesting periods are before selecting them.
- **Scrubber**: within the selected window, drag to grow and ungrow. Build this before the intro animation, since the intro is this animated.
- **Ring granularity control**: a compact segmented control reading hour / day / week / month / year, with the auto-selected unit indicated. Disable units that would be nonsensical for the current window (hours across a decade) rather than letting the user pick something that renders as a solid band.
- **Snap-to-unit affordance**: shift-drag on the brush snaps window edges to the current ring unit, so selecting exactly one month or one week is easy. Free drag otherwise.

Keyboard: left and right arrows pan the window by one ring unit, shift plus arrows resize it, and bracket keys step granularity. These share the arrow keys with DAG walking, so scope them to focus: arrows walk the DAG when the canvas has focus, and move the window when the timeline does.

### 8.6 URL state

`/:owner/:repo?mode=tree3d&lens=author&at=<sha>&t=<0..1>&ring=month&from=<iso>&to=<iso>`

Every state linkable, debounced on write, restored on load. Omit `from` and `to` when the window is the full history so the common URL stays short. Omit `ring` when it matches the auto-selected default, so a shared link stays correct if the repo gains commits later. A link to a specific window is one of the more shareable things here ("this is what our December crunch looked like"), so make sure the OG image respects the window and granularity params too.

---

## 9. Phase 6: Art direction (you decide)

You are the design lead. Make opinionated choices and justify them in `DESIGN.md`. Do not ask which palette to use.

### 9.1 The fixed constraint

Pixel art, achieved by rendering to a low-resolution target and upscaling with nearest-neighbour filtering. This is fixed because it does real work: it forces honest aggregation at high commit counts instead of pretending 5000 individually-shaded leaves are legible, and it makes the flat 2D growth state the *native* look rather than a degraded version of the 3D one.

Everything else about the visual identity is yours.

### 9.2 Process

Work in two passes before writing any styling code.

**Pass one, propose.** Write a compact token system: a palette of 20 to 24 colors organized in three tonal families so lenses can recolor within a family without breaking cohesion; two or three typefaces with defined roles (a characterful display face used with restraint, a body face, and a monospace utility face for SHAs and counts); a layout concept; and one signature element the site will be remembered by.

**Pass two, critique.** Ask whether you would have arrived at this same proposal for an unrelated brief. If yes, it is a default rather than a choice, so revise it and note what changed and why.

### 9.3 Defaults to avoid

Generated interfaces currently cluster hard around three looks, and all three would make this project read as templated:

1. Warm cream background near `#F4F1EA` with a high-contrast serif and a terracotta accent near `#D97757`.
2. Near-black with a single acid-green or vermilion accent.
3. Broadsheet layout with hairline rules, zero border radius, dense columns.

Also avoid the specific trap for this project: phosphor-green terminal styling. It fits the audience so obviously that it is the first thing anyone would try, and it is the most-used look in developer tooling.

Ground your choices in the subject's own world. This is a tool about time, growth, decay, and revision history. Consider where else those things are rendered: field guides, geological strata, dendrochronology, seed catalogs, botanical specimen plates, weather instrumentation, early computer graphics. Any of those give you a vernacular that is specific rather than generic.

### 9.4 Technical requirements for the pixel pipeline

- Render into a `WebGLRenderTarget` around 480x270, aspect-adjusted. `THREE.NearestFilter` for min and mag. No mipmaps. No antialiasing. `setPixelRatio(1)` for the low-res pass.
- Post pass quantizes to your fixed palette by nearest match in linear space, with a 4x4 Bayer dither to break banding.
- **Snap vertex positions to a grid in the vertex shader.** Without this, orbiting produces sub-pixel crawl and it looks like a broken video stream rather than pixel art. This single technique is what separates convincing pixel art from a blurry downscale:

```glsl
vec4 clip = projectionMatrix * mvPosition;
vec2 grid = uResolution * 0.5;
clip.xy = floor(clip.xy / clip.w * grid) / grid * clip.w;
gl_Position = clip;
```

- **All UI renders as normal DOM at full resolution on top of the pixelated canvas.** Do not attempt bitmap fonts. Crisp type over chunky pixels is a deliberate combination that looks intentional, and it keeps the entire interface layer as regular React.

### 9.5 Copy

Write the interface copy yourself, and treat it as design material. Plain verbs, sentence case, active voice, no filler. Name things by what the user controls, not how the system works. Errors explain what happened and what to do. The empty state is an invitation to act. Copy that reads as generated will undo good visual work.

---

## 10. Phase 7: GitHub adapter and Vercel

### 10.1 Query

GraphQL, not REST. REST needs one request per commit for diff stats.

```graphql
query($owner:String!, $name:String!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    description
    defaultBranchRef {
      name
      target { ... on Commit {
        history(first:100, after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            oid committedDate messageHeadline
            additions deletions changedFilesIfAvailable
            parents(first:8) { nodes { oid } }
            author { name email }
            associatedPullRequests(first:1) { nodes { number } }
          }
        }
      }}
    }
    refs(refPrefix:"refs/heads/", first:100) {
      nodes { name target { ... on Commit { oid } } }
    }
  }
}
```

`parents(first:8)`, not 2, for octopus merges.

### 10.2 Serverless rules

- Token in an environment variable, server-side only, never shipped to the client.
- Cap at 2000 commits. Return the first 300 immediately so the seed state is ready fast, stream the rest while the user reads the landing copy.
- `Cache-Control: s-maxage=3600, stale-while-revalidate=86400`. Vercel's CDN then does most of the work for free.
- Optional durable cache: Vercel KV keyed on `owner/repo@headSha`, which self-invalidates on any new commit.
- Per-IP rate limit. Someone scripting random repos burns your token's 5000-point hourly budget, not theirs.
- Precheck repo size and refuse anything absurd with clear copy rather than timing out.

### 10.3 Deployment

- Its own Vercel project, separate from the portfolio, so deploys are independent.
- `tree.isaacurman.com`, CNAME to `cname.vercel-dns.com`.
- Dynamic OG image per repo via `@vercel/og`, rendering a flat silhouette of that repo's tree server-side. This is the share loop and it is worth the effort.
- Canonical tags, `robots.txt` allowing indexing, meta description that says what the thing does.

---

## 11. Fallback: flat histories

If topology inference yields fewer than 3 limbs and no PR data exists, switch to directory mode: skeleton from the file tree at HEAD (directories branch, files leaf), commit history drives growth instead of structure. Same renderer, same morph system, one additional layout function. Label it clearly.

---

## 12. Build order

Do not reorder.

| Phase | Deliverable | Checkpoint |
|---|---|---|
| 1 | Types, topology inference | Fixture DAG tests pass, no rendering exists |
| 2 | Layout functions, growth, ring unit, window | Equal-length arrays across all modes and time settings, snapshot-tested |
| 3 | Renderer, GPU morph | 5000 commits morph 2D to 3D at 60fps |
| 4 | Sound engine | Growth sonification is legible and never clips |
| 5 | Interaction: scrubber, POI, search, picking | Every feature is a new layout or attribute write, no renderer changes |
| 6 | Art direction, pixel pipeline | No sub-pixel crawl while orbiting, DESIGN.md written |
| 7 | GitHub adapter, Vercel, OG images | Deep link renders a cached public repo end to end |

If phase 5 requires touching the renderer, phase 3 was built wrong. Stop and fix it rather than working around it.

---

## 13. Quality floor

- Responsive to mobile. Narrow viewports default to `tree2d`, orbit is opt-in. Audio still works.
- Visible keyboard focus everywhere. The DAG-walking navigation is a real accessibility feature, not a toy.
- `prefers-reduced-motion` shortens transitions and stops ambient sway, independently of audio settings.
- WebGL unavailable: fall back to a server-rendered 2D SVG of the tree, not an error screen.
- Progressive loading. First 300 commits render while the rest stream. Never a blocking spinner.
- Growth animation is skippable and interruptible. Any interaction jumps to the fully grown state.

---

## 14. Deliverables

- Monorepo structured per section 2
- Passing `core` test suite
- Deployed at `tree.isaacurman.com`
- `README.md` covering usage and setup
- `DESIGN.md` documenting the palette, type, signature element, and what was revised during self-critique and why
- `ARCHITECTURE.md` documenting the layout function contract, the morph system, and the adapter boundary, so v2's local CLI slots in behind the adapter and every future feature gets added as a layout function rather than a renderer hack
