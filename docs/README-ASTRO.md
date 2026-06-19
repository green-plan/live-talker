```markdown
# Astro Framework Reference Guide
**Context:** This document serves as the architectural and syntax reference for building a high-performance landing page for **live—talker**, an AI esports shoutcasting tool, using the Astro web framework. Information below is verified against the official Astro documentation (docs.astro.build) and the `withastro/astro` GitHub repository as of mid-2026 (Astro 6 stable, shipped February 2026; Astro acquired by Cloudflare January 2026).

---

## 1. Core Architecture: Astro Islands & Zero JS

Astro is a server-first web framework optimized for content-driven sites like landing pages.

* **Zero JS by Default:** Astro renders every component to static HTML & CSS at build time and strips out client-side JavaScript entirely unless you explicitly opt in. The initial load is pure HTML and CSS — there is no framework runtime to hydrate unless you ask for one.
* **Astro Islands:** "Islands architecture" — popularized by Astro — renders the page as fast static HTML with small, isolated "islands" of interactivity. If you need an interactive UI component (React, Vue, Svelte, Preact, SolidJS), embed it in an `.astro` page and Astro will hydrate **only that component**, leaving the rest of the page untouched. You can mix multiple UI frameworks on the same page — each island is independent.
* **Server Islands (newer feature):** `server:defer` moves slow/dynamic server-rendered sections out of the critical rendering path so the rest of the page can ship as static HTML immediately, with the deferred region streamed in afterward. Useful for anything personalized or fetched at request time; not needed for a fully static marketing page.
* **Why it matters for this project:** the landing page is almost entirely static marketing content (hero, features, pricing, footer). Only genuinely interactive widgets — an audio player/visualizer, a pricing toggle, a waitlist form — should ever break out of pure `.astro` and become an island.

---

## 2. Project Setup & Structure

**Installation:** `npm create astro@latest`

**Standard Directory Structure:**
```text
/
├── public/           # Static assets (images, fonts, favicon) served untouched by the bundler.
├── src/
│   ├── components/   # Reusable UI units (.astro, .jsx, .svelte).
│   ├── layouts/       # Page wrapper components (e.g., Layout.astro).
│   ├── pages/        # File-based routing. Every .astro file here becomes a route.
│   ├── content/       # Markdown/MDX/YAML content (if using Content Collections).
│   ├── actions/        # Server actions (e.g. src/actions/index.ts) — typed server functions.
│   └── styles/        # Global CSS.
├── astro.config.mjs  # Astro configuration and integrations (e.g., Tailwind, React).
└── package.json
```

---

## 3. Astro Component Syntax (`.astro` files)

An Astro component consists of two parts: the **Component Script** and the **Component Template**. They are separated by a `---` code fence (frontmatter).

### A. The Component Script (Server-Side)

Everything inside the `---` fence runs at **build time** (or on the server, for on-demand rendering). It NEVER runs in the user's browser. You can fetch data, import other components, and write secure server code here.

```astro
---
// 1. Imports
import BaseLayout from '../layouts/BaseLayout.astro';
import HeroVideo from '../components/HeroVideo.jsx';

// 2. Component Props
const { title, showCallToAction = true } = Astro.props;

// 3. Server-side logic / Data fetching
const apiResponse = await fetch('https://api.example.com/esports-stats');
const stats = await apiResponse.json();
---
```

### B. The Component Template (HTML/JSX-like)

Below the fence is the template. It uses HTML, but supports JS expressions inside curly braces `{}` (similar to JSX).

```astro
<div class="bg-slate-950 text-white">
  <h1>{title}</h1>

  {showCallToAction && <button>Get Early Access</button>}

  <ul>
    {stats.map((stat) => (
      <li>{stat.name}: {stat.value}</li>
    ))}
  </ul>

  <HeroVideo client:load videoUrl="/assets/showcase.mp4" />
</div>
```

### C. Slots (passing markup into a component)

`<slot />` renders whatever markup the parent placed between the component's tags. Use **named slots** (`<slot name="..." />`) when a component needs more than one content region.

```astro
<!-- Card.astro -->
<div class="card">
  <header><slot name="eyebrow" /></header>
  <slot /> <!-- default slot -->
</div>

<!-- usage -->
<Card>
  <span slot="eyebrow">● THE PAYOFF</span>
  <p>A full commentary track.</p>
</Card>
```

---

## 4. Layouts and Slots

Layouts are standard Astro components used to wrap content. They use the `<slot />` element to determine where injected content should render.

**src/layouts/Layout.astro:**

```astro
---
const { pageTitle } = Astro.props;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{pageTitle}</title>
  </head>
  <body class="bg-black text-slate-100">
    <nav>...</nav>
    <main>
      <slot />
    </main>
    <footer>...</footer>
  </body>
</html>
```

**src/pages/index.astro:**

```astro
---
import Layout from '../layouts/Layout.astro';
---
<Layout pageTitle="live—talker | a tiny AI broadcast crew">
  <section class="hero">
    <h1>Revolutionize Your Cast</h1>
  </section>
</Layout>
```

---

## 5. Client Directives — Controlling Hydration

Every UI-framework component (`.jsx`, `.svelte`, `.vue`, etc.) embedded in an `.astro` file ships **zero JavaScript by default** — it's rendered to static HTML. You must explicitly opt a component into hydration with a `client:*` directive on the tag. This is the single most important lever for keeping a landing page fast: only the components that genuinely need interactivity should carry one.

| Directive | When it hydrates | Best for |
|---|---|---|
| `client:load` | Immediately, on page load | Above-the-fold interactive elements that must work instantly (e.g. a nav toggle) |
| `client:idle` | Once the main thread is idle (`requestIdleCallback`) | Lower-priority widgets that don't need to be interactive *immediately* |
| `client:visible` | When the component scrolls into the viewport (`IntersectionObserver`) | Anything below the fold — an audio visualizer, a pricing toggle, a testimonial carousel |
| `client:media="(min-width: 768px)"` | Once the given media query matches | Components only relevant at certain breakpoints |
| `client:only="react"` | Skips server-render entirely, renders client-side only | Components that depend on browser-only APIs and can't render meaningfully on the server |

```astro
<AudioVisualizer client:visible waveform={waveformData} />
<PricingToggle client:idle />
```

**Rule of thumb for this landing page:** default to no directive (static HTML). Reach for `client:visible` first for anything below the fold (it costs nothing until scrolled to); reserve `client:load` for the one or two things that must be interactive the instant the page paints.

---

## 6. Images — `astro:assets`

Astro ships a built-in image pipeline. Always import local images and let Astro optimize them — never hand-write an `<img>` for a local asset.

```astro
---
import { Image, Picture, getImage } from 'astro:assets';
import heroShot from '../assets/hero-broadcast.png';
---
<!-- Single optimized format -->
<Image src={heroShot} alt="live-talker broadcast preview" width={960} />

<!-- Multiple formats, browser picks the best one -->
<Picture src={heroShot} formats={['avif', 'webp']} alt="live-talker broadcast preview" />
```

* `<Image />` infers width/height to prevent layout shift, and converts/compresses at build time (or on-demand for server-rendered pages).
* `<Picture />` generates a `<picture>` element with multiple `<source>` tags — use it when you want the browser to choose the most efficient format.
* For non-`<img>` uses (CSS `background-image`, OG meta tags), call `getImage()` directly and use the returned `.src`:

```astro
---
const og = await getImage({ src: heroShot, format: 'webp' });
---
<meta property="og:image" content={og.src} />
```

---

## 7. Styling, Scoped CSS & Tailwind

### A. Scoped `<style>` by default

Every `<style>` block in an `.astro` file is automatically scoped to that component (Astro adds a unique `data-astro-cid-*` attribute) — even a bare `h1 {}` selector only affects this component's markup, never leaks globally, and never gets overridden by a sibling component's `h1 {}`.

```astro
<style>
  h1 { color: white; } /* scoped — only this component's <h1> */
</style>
```

Use `<style is:global>` (or `:global(...)` inside a scoped block) when you deliberately need a rule to apply outside the component, e.g. styling markdown-rendered children.

### B. `define:vars` — server values into CSS

Pass a frontmatter value straight into a `<style>` block as a CSS custom property — handy for data-driven glow colors, progress widths, etc.

```astro
---
const glow = '#22d3ee';
---
<style define:vars={{ glow }}>
  .node { box-shadow: 0 0 40px var(--glow); }
</style>
```

### C. Tailwind CSS (current setup, Tailwind 4)

```bash
npx astro add tailwind
```

This wires up the **`@tailwindcss/vite`** Vite plugin (the old `@astrojs/tailwind` integration is legacy — don't use it for new projects). Your global stylesheet then just needs:

```css
/* src/styles/global.css */
@import "tailwindcss";
```

Import that stylesheet once, in the root layout:

```astro
---
import '../styles/global.css';
---
```

* Apply utility classes directly on elements in the template.
* Use the `class:list` directive for conditional/dynamic classes:

```astro
---
const isHighlight = true;
---
<div class:list={['p-4 rounded-md', { 'bg-cyan-500 text-slate-950': isHighlight, 'bg-slate-900': !isHighlight }]}>
  AI Audio processing active.
</div>
```

---

## 8. View Transitions (`<ClientRouter />`)

Astro can give a static, multi-page site SPA-like animated navigation using the browser's native View Transitions API — no client-side router framework needed. (Note: this component was renamed from `<ViewTransitions />` to `<ClientRouter />` — use the current name.)

```astro
---
import { ClientRouter } from "astro:transitions";
---
<html>
  <head>
    <ClientRouter />
  </head>
  <body>
    <slot />
  </body>
</html>
```

* Opt-in only — by default Astro uses normal full-page navigation; adding `<ClientRouter />` enables animated transitions site-wide.
* `transition:name="hero"` on matching elements across two pages pairs them for a custom morph/cross-fade animation; Astro otherwise infers pairing automatically by element type/position.
* `transition:persist` keeps a specific element (and its state) alive across a navigation instead of replacing it — e.g. a background audio player that should keep playing while the user clicks between sections/pages.
* Automatically respects `prefers-reduced-motion`, and falls back to normal navigation in browsers without API support.

For a one-page landing site this is mostly relevant for animating between an in-page "modal" route (e.g. `/demo`) and the homepage, or for persisting a sticky audio player across route changes if the site grows beyond a single page.

---

## 9. Content Collections (if the site grows beyond one page)

Not needed for a single-page landing site, but the right tool the moment you add a blog, changelog, or case-studies section — type-safe Markdown/MDX/YAML content validated against a Zod schema at build time.

```typescript
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const changelog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/changelog' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
  }),
});

export const collections = { changelog };
```

```astro
---
import { getCollection } from 'astro:content';
const entries = await getCollection('changelog');
---
```

---

## 10. Astro Actions — typed server functions (for the waitlist/early-access form)

Actions give you a type-safe RPC-style server function you can call from a plain HTML `<form>` (zero client JS needed) or from a hydrated island. This is the idiomatic way to handle the "Get Early Access" email capture without standing up a separate API route.

```typescript
// src/actions/index.ts
import { defineAction } from 'astro:actions';
import { z } from 'astro/zod';

export const server = {
  joinWaitlist: defineAction({
    accept: 'form',
    input: z.object({
      email: z.email(),
    }),
    handler: async ({ email }) => {
      // persist `email` wherever the waitlist lives
      return { success: true };
    },
  }),
};
```

```astro
---
import { actions } from 'astro:actions';
---
<form method="POST" action={actions.joinWaitlist}>
  <input type="email" name="email" required placeholder="you@team.gg" />
  <button type="submit">Get Early Access</button>
</form>
```

No JavaScript is required for this to work — it's a progressively-enhanced HTML form post, validated server-side by the Zod schema.

---

## 11. Design System Guidelines for the live—talker Landing Page

Derived from the provided mockups (`livetalker.png`, `arch.png`, `commentary_track.png`) — keep new sections visually consistent with these reference tokens.

**Palette**
* Background: near-black navy, `bg-slate-950` / `#020617`, with a faint dot/grid texture behind hero sections (low-opacity radial-gradient dots).
* Primary accent (the "live—talker" brand color): cyan/sky blue — `text-cyan-400` / `#22d3ee` — used for the em-dash in the wordmark, glow effects, waveform bars, connector nodes, and duration/timestamp text.
* Secondary accent (achievement/highlight badges): amber/gold — `text-amber-400` / `#fbbf24` — used sparingly for "trophy moment" badges (e.g. a `★ 1v3 CLUTCH` pill).
* Success accent: green — `text-emerald-400` / `#4ade80` — for "saved / done" confirmation lines.
* Text: headings in `text-white`/`text-slate-100`, bold, large; secondary copy in `text-slate-400`/`text-slate-500`, often smaller and lighter weight.

**Typography**
* Headlines: bold, tight tracking, sans-serif, lowercase wordmark style for the brand ("live—talker").
* Eyebrow labels (small caps section tags like `● THE PAYOFF`) and inline data tags (`1v1_clutch`, `ace`, `utility`): monospace font, uppercase or snake_case, small size, wide letter-spacing, often prefixed with a small filled dot (`●`) in the accent color.

**Components/Motifs to reuse**
* **Network/architecture diagram:** circular icon nodes (rounded, glowing ring, soft blur halo behind them) connected by thin dashed/dotted lines, each node labeled with a bold title + small gray caption underneath — matches `arch.png` ("The Memory", "The Map Reader", "The Analyst"). Good fit for an "how it works" / pipeline section.
* **Badge pill:** rounded-full border, dark fill, accent-colored icon + bold accent text (`★ 1V3 CLUTCH`) — use for callouts/highlights scattered near diagrams.
* **Audio/commentary card:** rounded-2xl panel with a subtle border (`border-slate-800`), containing a waveform visualization (vertical bars in the cyan accent, varying heights), a filename label bottom-left in muted gray, and a duration readout bottom-right in the accent color — matches `commentary_track.png`. Pair with a small "subtitles included" pill and a green checkmark confirmation line below the card. This is the natural home for an `AudioVisualizer` island (`client:visible`).
* **Glow effects:** soft `box-shadow`/blurred radial gradients behind nodes and icons rather than hard borders — keep glows subtle (low opacity, large blur radius) so the dark background stays dominant.

**Hydration plan for this page:** the hero, architecture diagram, and feature cards should be pure static `.astro` markup (including the badge/diagram SVG or CSS). The waveform/audio-player card, if it actually plays audio, should be the one real island — give it `client:visible` so it costs nothing until scrolled into view. The waitlist form needs no island at all (Astro Actions handle it server-side).

---

## 12. Official Resources & References

* **Official Core Repository:** [GitHub - withastro/astro](https://github.com/withastro/astro)
* **Official Documentation Hub:** [Astro Docs](https://docs.astro.build/)
* **Islands Architecture:** [Concepts — Islands](https://docs.astro.build/en/concepts/islands/)
* **Client Directives Reference:** [Directives Reference](https://docs.astro.build/en/reference/directives-reference/)
* **Images Guide (`astro:assets`):** [Images](https://docs.astro.build/en/guides/images/)
* **Styling Guide:** [Styling & CSS](https://docs.astro.build/en/guides/styling/)
* **View Transitions Guide:** [View Transitions](https://docs.astro.build/en/guides/view-transitions/)
* **Content Collections Guide:** [Content Collections](https://docs.astro.build/en/guides/content-collections/)
* **Actions Guide:** [Actions](https://docs.astro.build/en/guides/actions/)
* **Tailwind Integration Guide:** [Astro Tailwind Setup Documentation](https://docs.astro.build/en/guides/integrations-guide/tailwind/)
* **Deployment Guide (GitHub Pages):** [Deploying Astro Sites to GitHub Pages](https://docs.astro.build/en/guides/deploy/github/)
* **General Deployment Guide:** [Deploy your Astro Site](https://docs.astro.build/en/guides/deploy/)
* **Community Hub & Chat:** [Astro Discord Server](https://astro.build/chat)
* **Curated Framework Resources:** [GitHub - one-aalam/awesome-astro](https://github.com/one-aalam/awesome-astro)

**Notable as of mid-2026:** Astro 6 went stable in February 2026 (Cloudflare acquired Astro the month prior, in January 2026); the current stable line is Astro 6.3.x. The Astro 6 Markdown/content pipeline rebuilds a 100-post site in ~200ms — about 5x faster than Astro 5. An Astro 7 alpha is available for early adopters but is not recommended for production use yet.
```
