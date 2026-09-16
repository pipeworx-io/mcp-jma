# @pipeworx/jma

Japan Meteorological Agency (JMA) weather forecasts, warnings/advisories, and
earthquake reports — keyless, sourced straight from JMA's public `bosai` JSON
feeds.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `jma_resolve_area(query)` — resolve a place name (English romaji or
  Japanese, e.g. "Tokyo", "Sapporo", "大阪") or a JMA area code to the
  forecast OFFICE code used by `jma_forecast` / `jma_warnings`.
- `jma_forecast(area)` — 3-day short-term forecast (weather, precipitation
  probability, temperature) plus 7-day weekly forecast (weather,
  precipitation probability, forecast reliability, min/max temperature with
  confidence range), per sub-area. Accepts a place name directly — it
  resolves internally the same way as `jma_resolve_area`.
- `jma_warnings(area)` — current warnings and advisories (警報・注意報) for a
  region: headline bulletin plus per-area status (issued / continuing /
  lifted / none in effect) for every JMA warning category (heavy rain,
  storm, flood, wave, storm surge, dense fog, thunderstorm, avalanche,
  frost, and their "special warning" / emergency tiers), at both the
  sub-prefecture and municipality level.
- `jma_earthquakes(limit?, min_magnitude?, min_intensity?)` — recent
  earthquakes with magnitude, maximum seismic intensity (JMA's 10-step
  震度 scale), epicenter, and report/occurrence time.

## Auth

Keyless. No registration, no API key.

## Data sources

- `https://www.jma.go.jp/bosai/common/const/area.json` — the area master
  list: 58 forecast offices plus every prefecture/region/city/ward/town JMA
  itself names, in both Japanese and English. This is what
  `jma_resolve_area` walks.
- `https://www.jma.go.jp/bosai/forecast/data/forecast/<office>.json` — the
  3-day + weekly forecast for one office.
- `https://www.jma.go.jp/bosai/warning/data/warning/<office>.json` — current
  warnings/advisories for one office.
- `https://www.jma.go.jp/bosai/quake/data/list.json` — a rolling feed of
  recent earthquake bulletins (typically the last few weeks), newest first.

## Traps for the next person

- **Forecasts and warnings are published per forecast OFFICE, not per
  city.** There are 58 offices, roughly one per prefecture plus Hokkaido and
  Okinawa subdivisions (e.g. Tokyo = `130000`). A caller will say "Tokyo" or
  "Sapporo", not the office code — every tool that takes `area` resolves it
  through `area.json`'s full hierarchy (office → region → city/ward/town),
  walking up to the owning office.
- **Place-name ranking is (how well the name matches, then how broad the area
  is) — in that order, and the order is load-bearing.** Both halves were
  silent wrong answers when they were the other way round: with level first,
  "Iga" (a city in Mie) returned a Niigata forecast because an office outranks
  a city no matter how badly it matches — same for Kaga→Kagawa, Oki→Okinawa,
  Aki→Nagasaki. With no match-quality signal at all, "Yokohama" returned
  Aomori, because JMA splits designated cities into sub-districts ("Northern"
  / "Southern Yokohama City", no plain 横浜市 leaf) and the only literal
  "Yokohama" leaf is a small town 700km away. The regression test that keeps
  this honest asserts all 2,217 English names in the area master resolve to
  themselves; run it before touching the ranking (fleet #1939).
- **Same-named places in different prefectures are decided by area code (JIS
  prefecture order) and disclosed in `alternatives`.** 伊達市 exists in both
  Hokkaido and Fukushima, 川崎町 in both Miyagi and Fukuoka — nothing in the
  query can separate them, so `alternatives` carries the others WITH the
  office each resolves to. `alternatives: []` therefore means the name really
  was unique; it used to mean the opposite in exactly the cases that went
  wrong.
- **`area.json`'s four levels overlap in code space.** A handful of small
  offices are their own single sub-region, so the same numeric code appears
  in both `offices` and `class10s` (e.g. `011000` Soya). The parent-walk in
  this pack always walks from the LEVEL you matched at (never by treating a
  code as globally unique across the four dicts), which is what makes that
  edge case resolve correctly instead of silently landing on the wrong
  office.
- **`weatherCodes` is a closed, JMA-published numeric set** (three digits,
  ~110 in active use) — this pack ships a full static translation table
  (`weather_en`) built from that fixed set, not a machine translation. The
  free-text `weathers[]` narrative (with time modifiers like "後" / "時々" /
  "一時") is intentionally left native-Japanese-only: it's compositional in
  a way a static table can't safely cover, and a wrong on-the-fly
  translation is worse than none.
- **Warning codes (the `code` field inside each area's `warnings[]`) are a
  separate closed numeric set** from weather codes (02-49, warnings /
  advisories / special warnings / emergency warnings). Cross-checked against
  a live Tokyo response: codes 14/15/16/20 in the `areaTypes` payload lined
  up exactly with "強風", "高波", "落雷", "濃霧" in that response's own
  `headlineText`, which is the validation this table was built against.
- **Seismic intensity (`maxi` / `int[].maxi`) is JMA's own 10-step 震度
  scale**: `1`,`2`,`3`,`4`,`5-`,`5+`,`6-`,`6+`,`7` — `5-`/`5+` mean
  "5 Lower"/"5 Upper", not "slightly less/more than 5". An empty string
  means the bulletin carries no intensity (e.g. a "hypocenter update" record
  with no shaking report).
- `area.json` is ~260KB and essentially static (JMA's forecast-area
  boundaries are a standing administrative structure) — this pack caches it
  in module scope for 24h rather than refetching per call.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "jma": {
      "url": "https://gateway.pipeworx.io/jma/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/jma/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "jma": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-jma"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-jma
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Jma data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
