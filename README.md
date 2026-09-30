# VOXELPOLIS

**A voxel city builder in a single HTML file.** Double-click `Voxelpolis.html` — it runs in any modern
desktop browser (Chrome, Edge, Firefox, Safari), fully offline. No install, no server, no downloads.

Build roads, zone neighborhoods, power and water your city, fund services, set taxes and policies,
and watch a living voxel metropolis grow — with day/night cycles, seasons, weather, traffic,
disasters (including a certain giant cube lizard), and a generative soundtrack.

## Play

1. Download `Voxelpolis.html`.
2. Double-click it.
3. Pick **New City**, choose a map, and start building.

Everything — terrain, buildings, textures, sound effects and music — is generated procedurally at runtime
with WebGL2 and WebAudio.

## Features

**City building**
- Streets, avenues and highways (with bridges and ramps), power lines, 9 zone types (residential /
  commercial / industrial × low / medium / high density), terraforming, trees, bulldozer with undo.
- 44 placeable buildings: coal, gas, wind, solar, nuclear and fusion power; pumps, towers, treatment and
  desalination; police, fire, clinics, hospitals, schools, universities, parks, transit, sanitation — and
  landmarks like the Ferris Wheel, Stadium, Sky Needle, Voxel Pyramid, Space Center and the Arcology.
- ~100 procedurally generated growable building archetypes that level up (and get richer) with land value.

**Simulation**
- Power and water networks with brownouts, service coverage with capacity, land value, pollution, crime,
  noise, commuter traffic, happiness, demand (RCI), abandonment, fires and 10 population milestones.
- Data overlays for every simulated map, a minimap and a problems chip that tells you *why* a zone isn't growing.

**Managers & economy**
- Pop-up manager windows: Budget & Taxes (per-zone and per-wealth tax sliders, department funding sliders
  with live what-if previews, loans), Policies (19 ordinances with **intensity sliders**), City Statistics,
  Population, Services, Utilities, Advisors, Milestones & Achievements, Disasters, Save & Load, and a
  detailed building inspector.
- **Mayor's Goals** (live objectives with rewards) and **Mayor's Desk** (decision events with trade-offs).
- Seven advisors with personalities, a news ticker and 36 achievements.

**Looks & feel**
- Stable cascaded shadows, SSAO, bloom, tilt-shift miniature depth of field, god rays, filmic grading,
  a full day/night cycle with golden hour and blue hour, seasons (snow, autumn leaves, cherry blossoms),
  weather (rain, storms with lightning, snow, fog), reflective water with foam and ice, stars, moon phases
  and the occasional aurora.
- Night cities with lit windows, neon, street lamps and traffic lights; cars, buses, emergency vehicles,
  planes, boats, birds and balloons; smoke, fireworks and confetti.
- Disasters: fires, tornadoes, meteors, earthquakes, UFO abductions and Cubezilla.
- Generative soundtrack, ambience and synthesized sound effects.
- Autosave, save slots and export/import of `.voxelpolis` files. Photo mode (H) and cinematic camera (C).
- Six map types (river, coast, islands, mountains, lakes, plains), four difficulty levels incl. sandbox,
  four graphics presets with automatic resolution scaling.

### Controls (defaults)

| Action | Input |
|---|---|
| Pan | WASD / arrow keys, middle-drag, or left-drag with the select tool |
| Rotate / tilt | Right-drag, Q / E |
| Zoom | Mouse wheel, + / - |
| Pause / speed | Space, `,` / `.` |
| Tool groups | 1–0, T (terraform), B (bulldoze) |
| Rotate building | R |
| Cancel / close | Esc, right-click |
| Photo mode | H (hide UI), C (cinematic camera) |
| Overlays | O |
| Managers | M budget, P policies, G graphs, U population, V services, Y utilities, N advisors, J milestones, X disasters, K save |
| Help | F1 |

## Development

The game is developed as modular source files under `src/` and inlined into one HTML file:

```
node build.js                  # builds Voxelpolis.html
node tools/shot.js --help      # headless screenshot/test harness (Playwright + SwiftShader)
node tools/smoke.js            # scripted end-to-end integration test
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module contracts.

## License

MIT — see `LICENSE`.
