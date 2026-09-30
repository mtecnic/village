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
