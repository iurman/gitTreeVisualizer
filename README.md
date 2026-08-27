# tree

Paste a public GitHub repository and watch its commit history grow into a
three-dimensional tree, rendered in pixel art, with a soundtrack generated from
the repository's own history.

**[tree.isaacurman.com](https://tree.isaacurman.com)**

The tree is not decorative. The trunk is the first-parent chain from HEAD. The
limbs are branches that really existed, inferred from merge commits. The leaves
are commits, sized by how much they changed. The rings are time, at a
granularity you choose. Thickness follows the pipe model, placement follows
phyllotaxis, and height follows compressed time — so the shape can be checked
against the repository it came from.

Two moments matter. **The growth**: the tree does not appear, it grows, in
commit order, from a seed, with sound. **The unfold**: it grows flat, in two
dimensions, then unfolds into three and becomes orbitable.

---

## Using it

Paste a repository URL or `owner/repo`, then press **Grow the tree**. That click
is also what opens the audio context, which is why a deep link shows a planted
seed and waits rather than growing silently in the background.

| | |
|---|---|
| **Drag** the canvas | Orbit |
| **Scroll** | Zoom |
| **Click** a leaf | Open the commit |
| **↑ ↓ ← →** on the canvas | Walk the graph: parent, child, previous and next sibling |
| **Shift + arrows** on the canvas | Nudge the camera |
| **Space** | Skip to the fully grown tree |
| **Escape** | Close the detail panel |
| **Drag** the bottom rule | Select a range of history |
| **Alt-drag** the bottom rule | Scrub growth back and forth |
| **Shift-drag** the bottom rule | Snap the range to whole ring units |
| **Double-click** the bottom rule | Reset to the full history |
| **← →** on the bottom rule | Pan the range by one ring unit |
| **Shift + ← →** on the bottom rule | Resize the range |
| **[** and **]** on the bottom rule | Step ring granularity finer or coarser |

Any interaction ends the growth animation early. The arrow keys walk the graph
when the canvas has focus and move the time window when the timeline does.

### Views

- **Tree** — the canonical form, limbs distributed radially.
- **Flat** — the same tree with its angles collapsed to a plane. This is the
  state it grows in.
- **By author** — every contributor becomes a primary limb. This is no longer
  the repository's structure, and the interface says so.
- **By churn** — real branches, reordered and rescaled by lines changed.
- **Timeline** — everything collapses to a horizontal spine. It was just data
  all along.

### Lenses

Age, author, churn, deletions and file type. Lenses move nothing; they only
recolour, so the real topology is always intact underneath. The deletions lens
makes net-negative commits fall and pile at the base.

The file-type lens needs to know which files a commit touched, which GitHub's
GraphQL API does not report. It says so rather than inventing an answer, and it
works in directory mode where the paths are known.

### Sharing

Every state is in the URL:

```
/:owner/:repo?mode=tree3d&lens=author&at=<sha>&t=<0..1>&ring=month&from=<iso>&to=<iso>
```

`from` and `to` are omitted when the window is the full history, and `ring` is
omitted when it matches the auto-selected default — so a shared link stays
correct if the repository gains commits later. Share images honour the window
and granularity, so "this is what our December crunch looked like" produces a
card of exactly that.

---

## What it does when the history is awkward

Real repositories break the naive version of this in three ways, and all three
are handled explicitly rather than papered over.

**Squash-merged repositories** have a linear history with no merge commits and
would render as a bare pole. Branches are reconstructed from pull request
metadata, drawn ghosted and dashed, and labelled: *this repository
squash-merges, branches are reconstructed from pull requests*. Reconstructed
commits never link out to a SHA that no longer exists.

**Histories with no recoverable structure at all** fall back to directory
mode: the skeleton comes from the file tree at HEAD and commit history still
drives growth. Also labelled.

**Dormant periods** would otherwise produce a long bare stretch of trunk. Time
is compressed: gaps longer than three ring units clamp to three ring units, so
bursts read as dense clusters and dead years read as a short seam.

---

## Running it

Requires Node 20+ and pnpm 10+.

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

With no credentials, the development server serves a synthesized repository
with real branch topology, dormant gaps and bursts. It is deterministic, so a
visual change is always a change you made. The repository name picks the shape,
so every case is a deep link:

| Path | What you get |
|---|---|
| `/acme/demo` | Merge topology, sub-branches, a few abandoned refs |
| `/acme/demo-5000` | The same, at five thousand commits |
| `/acme/squash-300` | A squash-merged history; branches reconstructed from pull requests |
| `/acme/flat-300` | No recoverable structure at all; directory mode takes over |

To develop against real repositories:

```bash
GITHUB_TOKEN=ghp_... GITTREE_LIVE=1 pnpm dev
```

The `GITTREE_LIVE` opt-in is deliberate: an ambient `GITHUB_TOKEN` in your
shell is usually scoped to something else, and this stops it being spent by
accident.

```bash
pnpm test         # the core test suite
pnpm typecheck    # every package
pnpm build        # production build
```

### Layout

```
/packages/core    pure TypeScript: the data contract, topology inference,
                  layout, points of interest, lenses, the flat SVG
/packages/web     the viewer: renderer, morph system, sound, interface
/apps/site        the Vercel deployment: viewer plus serverless routes
```

`core` has one runtime dependency and no browser assumptions, so the same
layout code runs in a worker, in a serverless function drawing a share image,
and in a test with no DOM.

---

## Deploying

A Vercel project pointed at `apps/site`.

| | |
|---|---|
| Build command | `pnpm build` |
| Output directory | `apps/site/dist` |
| Install command | `pnpm install` |
| Node version | 20 or later |

Set `GITHUB_TOKEN` to a token with `public_repo` scope, server-side only. It is
never shipped to the client.

For a custom domain, point a CNAME at `cname.vercel-dns.com`.

Responses are cached at the edge with `s-maxage=3600,
stale-while-revalidate=86400`, so a popular repository never waits on GitHub
twice, and requests are rate limited per IP. Repository reads are capped at
2,000 commits and absurdly large repositories are refused with clear copy
rather than timing out.

---

## Accessibility and fallbacks

- Every control is keyboard reachable with a visible focus ring. Walking the
  graph with the arrow keys is a real way through the tree, not a toy.
- `prefers-reduced-motion` shortens transitions and stops the ambient sway. It
  does not silence audio; those are separate concerns and separate controls.
- Sound is muted persistently through `localStorage`, muted while the tab is
  hidden, and always has a visible toggle.
- Narrow viewports open flat, with orbit as an opt-in. Audio works.
- Without WebGL, a server-rendered SVG of the same tree is shown, not an error
  screen.
- Loading is progressive: the first commits render while the rest stream. There
  is no blocking spinner.

---

## Not in this version

Accounts, databases, private repositories, theme editors, embeds and repository
comparison are all out of scope. A local CLI for private repositories is
planned; the data layer is built so it slots in behind the adapter without a
rewrite. See [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Reading further

- **[DESIGN.md](DESIGN.md)** — the palette, the type, the signature element,
  and what changed under self-critique.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the three seams: the adapter
  boundary, the layout contract, and the morph system.
