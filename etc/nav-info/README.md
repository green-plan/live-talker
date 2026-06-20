Navigation information fetched from: https://github.com/pnxenopoulos/awpy

`nav-info.csv` isn't committed here — it's downloaded by `scripts/fetch-nav-info.ts` (runs
automatically via the root `postinstall` script; re-run manually with `npm run fetch:nav-info`).
The download is pinned to a specific awpy commit and checked against a hardcoded SHA-256 before
being written, since upstream awpy 2.x dropped this precomputed file in favor of parsing raw `.nav`
meshes — see the script for the exact URL/hash. See `THIRD_PARTY_LICENSE.txt` for the MIT license
that covers the pnxenopoulos/awpy repository itself — copied from
https://github.com/pnxenopoulos/awpy/blob/007b119a6a5b4b8ee7d3011d96ce00bed7323c12/LICENSE.