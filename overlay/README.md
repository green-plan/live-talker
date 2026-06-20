# Overlay

A small React + Vite page meant to be added to OBS as a **Browser Source**. It connects
to the backend's overlay server over WebSocket, plays each commentary clip through its
own `<audio>` element (so OBS's "Control audio via OBS" can capture it as an isolated
track), and renders a live waveform, the current/past lines, and a pause control.

See the root [`README.md`](../README.md#broadcasting-with-obs) for how this fits into the
broadcast and how to run it.

## Commands

| Command | Action |
| :--- | :--- |
| `npm run dev` | Local dev server with hot reload, proxying `/overlay/*` to the backend |
| `npm run build` | Production build to `./dist/` — this is what the backend serves to OBS |
| `npm run preview` | Preview the production build locally |

Independent subproject (own `package.json`/lockfile), same as [`homepage/`](../homepage/) —
not an npm workspace member of the root project.
