# VOXELPOLIS — Architecture & Module Contracts

A voxel city builder shipped as **one self-contained HTML file** (`Voxelpolis.html`) that runs by
double-clicking it on any desktop: no server, no network, no external libraries. Raw WebGL2 +
HTML/CSS UI + WebAudio. Everything is procedural (models, textures, sounds, music).

## 1. Build & test

```
node build.js            # -> Voxelpolis.html  (syntax-checks every file first)
node build.js --check    # syntax check only
node tools/shot.js --query "autostart=1&seed=12345&size=96&city=1" --eval "VC.debug.tod(0.9)" --wait 3000 --out /tmp/x.png
```

* `src/**/*.js` are concatenated: EARLY files first (`core/base.js, data/defs.js, core/state.js,
  gfx/shaderlib.js, gfx/core.js, gfx/voxel.js`), then all others **alphabetically by path**, then `main.js`.
* **Each file is wrapped in its own IIFE and `<script>` tag.** Top-level `const`/`function` names are
  private to the file. Files share state ONLY via the global `VC` object. At the top of a file,
  alias what you need: `const M = VC.M, C = VC.C, P = VC.P;`
* Top-level code may only *define* things (and call `VC.models.define`, which exists early).
  Never call other modules at top level — do it in `init()`/`reset()`/`update()`.
* Never write the literal `</script` inside a JS file (build fails).
* `src/**/*.css` are concatenated (ui/base.css first).
* URL params for testing: `autostart=1` (skip menu), `seed=N`, `size=96|128|192|256`,
  `map=river|coast|islands|mountains|lakes|plains`, `difficulty=easy|normal|hard|sandbox`,
  `city=1` (instantly lays out a sample city with grown buildings via `VC.debug.sampleCity`), `city=plan` (roads+zones only).
* `VC.debug`: `newGame(opts)`, `sampleCity(opts)`, `cam(x,z,dist,yaw,pitch)`, `tod(t)`
  (0.5 noon, 0.75 sunset, 0.9 night), `run(days)` (sync sim fast-forward), `perf()`, `errors()`.
* `tools/shot.js` launches headless Chromium with SwiftShader WebGL2 (slow: ~5-15 fps; that is
  fine). It prints console errors, uncaught exceptions and `VC.errors`, exits 1 on any error.
  Use `--steps '[{"eval":"...","wait":2000,"out":"/tmp/a.png"}, ...]'` for several shots in one run.
  You can view PNG screenshots with the Read tool — **look at your work**.

## 2. Coordinates & units

* Map `W x H` tiles (96..256). Tile `(x, z)`, index `i = z * W + x`. World: 1 tile = 1 unit on X/Z, **Y up**.
* Terrain height = integer **level** per tile (0..`C.MAXH`=48). World Y of a tile top = `level * C.STEP` (0.25).
  Tiles with `level < C.SEA` (6) are water. Water surface Y = `C.SEA_Y` (= 1.38).
* Voxel models: `C.VOX = 1/8` world unit per voxel (8 voxels per tile edge).
* Time: sim day = 1 s real at speed 1 (`C.SPEEDS=[0,1,3,8]` days/sec). 30 days/month, 12 months/year,
  starts day 90 (April 2025). Visual time-of-day `S.time.tod` in [0,1) (0 midnight, .25 sunrise, .5 noon,
  .75 sunset) advances independently (`C.DAYCYCLE_SEC` = 300 s per cycle) unless settings.dayNight is fixed.
* Season (from month): spring Mar-May, summer Jun-Aug, autumn Sep-Nov, winter Dec-Feb (snow).

## 3. Shared data (read-only contracts) — `data/defs.js`

`VC.C` constants, `VC.DIFFICULTY`, `VC.MAP_SIZES`, `VC.MAP_TYPES`, `VC.TERR`, `VC.F` (tile flags),
`VC.ZT`/`VC.zcode/ztype/zden` (zones), `VC.ZONES`, `VC.DENSITY`, `VC.DENSITY_UNLOCK`, `VC.GROW`
(growable capacities & footprints), `VC.ZONE_TOOLS`, `VC.ROAD`/`VC.ROADS`, `VC.DEPARTMENTS`,
`VC.TOOL_GROUPS`, `VC.CATALOG`/`VC.BLD` (every placeable building + stats), `VC.SERVICES`,
`VC.OVERLAYS`, `VC.MAP_KEYS`, `VC.MODS` (modifier keys), `VC.POLICIES`/`VC.POLICY`, `VC.MILESTONES`,
`VC.ADVISORS`, `VC.QUALITY`, `VC.DEFAULT_SETTINGS`. **Do not rename or remove fields.** If you need
an extra field, read it with a default (`def.foo || 0`) and report it.

## 4. State — `core/state.js`

`VC.state` (alias `S`) — created by `VC.createState(opts)`; see the file for every field. Key parts:

* Tile layers (typed arrays, length N): `height, terr, zone, road, pline, trees, bld (building id, 0 none), flags (VC.F bits)`.
* `S.maps[key]` Uint8 0..255 for every `VC.MAP_KEYS` entry (landValue, pollution, crime, noise, traffic,
  happiness, police, fire, health, edu, park, transit, garbage). Written by sim. High = more of it.
* `S.buildings: Map<id, building>`; building object:
  `{ id, key ('grow' or VC.BLD key), x, z, w, d (footprint as placed), rot 0..3, variant (uint16),
     level 1..3, zt 1..3, den 1..3, wealth 0..2 (growables), pop, cap, built 0..1 (construction),
     powered, watered, happy 0..1, abandoned, fire 0..1, age (days), hgt (world height, set by renderer) }`
  Modules may attach extra fields (prefix them with the module name, e.g. `b.simJobsFilled`).
* `S.time {day, tod, speed}`, `S.money`, `S.tax {R:[low,mid,high] %,…}`, `S.budget {dept: 0..1.5}`,
  `S.policies {key:true}`, `S.loans[]`, `S.ledger {month:{cat:$}, last:{cat:$}}`, `S.demand {R,C,I: -1..1}`,
  `S.stats {...}`, `S.history {key: number[]}` (monthly samples), `S.mods {modKey: additive}`,
  `S.peakPop`, `S.milestone`, `S.achievements`, `S.weather {type, intensity, cloud, wet, fog, wind, windDir, lightning}`,
  `S.disastersEnabled`, `S.sandbox`, `S.ver {terrain, bld, trees, maps, flags}` (change counters).

### World API — `VC.world` (ALL tile/building mutations go through it)
`idx, inb, level, topY, isWater, isWaterI, groundY(wx,wz)`, `markDirty(x0,z0,x1,z1)` (coalesced; `flush()` emits
bus `'dirty' {x0,z0,x1,z1}` once per frame), `setHeight, setTerr, setRoad, setZone, setPowerLine, setTrees, flatten`,
`areaFree(x,z,w,d,{allowWater,allowPline,zone})`, `roadAdjacent`, `adjacentRoadDir(x,z,w,d)` (→ rot so the front faces
a road: 0 +Z, 1 +X, 2 -Z, 3 -X; -1 none), `buildingAt(x,z)`, `get(id)`, `count(key)`,
`addBuilding({key,x,z,w?,d?,rot,...}, {instant, noFlatten})` (emits `'bldAdd'`), `removeBuilding(id|b, reason)`
(emits `'bldRemove'`), `changed(b)` (emits `'bldChange'`, bumps `S.ver.bld`), `center(b)`, `isUnlocked(key)`.

### Money — `VC.money`
`costMul()`, `canAfford(n)`, `spend(n, cat, force)` (false + bus `'noMoney'` if unaffordable; sandbox = free),
`earn(n, cat)`. Categories: `'construction','roads','zoning','demolish','terraform','trees','upkeep:<dept>','roadUpkeep',
'tax:R','tax:C','tax:I','policy','loan','loanPayment','reward','income','tourism'`.

## 5. Event bus — `VC.bus.on/off/once/emit`

| event | payload | emitted by |
|---|---|---|
| `dirty` | `{x0,z0,x1,z1}` | world (coalesced per frame) |
| `bldAdd` / `bldRemove` / `bldChange` | building | world |
| `roadChange` | `{x,z,type}` | world |
| `money` | `{amount, cat, balance}` | money |
| `noMoney` | `{amount, cat}` | money |
| `day` / `month` / `year` | day index / `{month, year}` / year | sim |
| `mapsUpdated`, `flagsUpdated` | – | sim (after recomputing maps / networks) |
| `newGame`, `started` | S | main |
| `speed` | speed index | main |
| `settings` | settings | main (`VC.saveSettings()`) |
| `overlay` | overlay key | gfx (`VC.gfx.setOverlay`) |
| `tool` | `{key}` | tools |
| `select` | `{building, x, z}` or null | tools (inspector opens on this) |
| `built` | `{kind:'road'|'zone'|'building'|'bulldoze'|'terraform'|'trees'|'pline', x, z, w, d, key}` | actions |
| `toast` | `{text, type:'info'|'good'|'warn'|'bad', icon}` | anyone |
| `sfx` | `{name, x?, z?, vol?}` | anyone (audio plays it) |
| `advisor` | message object | advisors |
| `news` | `{text}` | advisors |
| `milestone` | `{index, milestone}` | advisors |
| `achievement` | `{key, name, icon}` | advisors |
| `disaster` | `{type, phase:'start'|'update'|'end', x, z, ...}` | disasters |
| `policyChanged`, `budgetChanged`, `loanChanged` | key / – | econ |
| `windowOpened`/`windowClosed` | id | ui |
| `unlock` | `{keys:[…]}` items newly unlocked between milestones | advisors |
| `saved` / `loaded` / `saveFailed` | `{slot, name, …}` | save |
| `audioStarted`, `boot` | – | audio / main |
| `econ` | `{type:'strike'|'emergencyLoan', …}` | econ |
| `cityRenamed` | name | hud |

Removal reasons (`removeBuilding(b, reason)`, stored in `b.removed`): see `VC.REMOVE` in core/state.js —
bulldoze, fire, abandon, upgrade, disaster, abduct, replace, undo, cleared.

## 6. Module lifecycle — `main.js`

`MODULE_ORDER`: audio, camera, shadows, post, sky, terrain, water, bldgfx, agents, particles, fx, worldgen, sim,
econ, disasters, advisors, actions, tools, input, save, ui, hud, panels, menu.
Each `VC.<name>` may implement `init()` (once, after WebGL exists), `reset(S)` (new game / load, after the state is
complete), `update(dt, rdt)` (every frame; `rdt` real seconds ≤0.1; `dt = rdt` or 0 when paused). Errors in one module
are caught and logged, never fatal. `VC.newGame(opts)`, `VC.startState(S)` (used by load), `VC.setSpeed(i)`,
`VC.togglePause()`, `VC.settings` + `VC.saveSettings()`, `VC.params` (URLSearchParams).

## 7. Rendering — `gfx/core.js`, `gfx/shaderlib.js`, `gfx/camera.js`, `gfx/voxel.js`

* `VC.gfx`: `gl, canvas, caps{floatRT,…}, program(name, vsBody, fsBody, {defines, attribs})`, `buffer, texture(o),
  framebuffer(colors, depth), fullscreen(), FS_VS` (fullscreen-triangle vertex body with `out vec2 vUv`),
  `quadIndexBuffer(quads)` (shared Uint32 quad index buffer: `v, v+1, v+2, v, v+2, v+3`), `addLayer(layer)`,
  `drawLayers(pass, ctx)`, `writeFrame(vpOverride)`, `setShadow(tex, mat)`, `setOverlay(key)`, `overlay`,
  `env` (lighting environment, recomputed each frame by `computeEnv`), `hdr {fbo, color, depth, w, h, float}`,
  `rw, rh` (internal render size), `W, H` (canvas size), `time`, `fps`, `gizmo {box, line, tile, footprint}`,
  `capture(maxW)` → Promise<dataURL>, `quality()` (current `VC.QUALITY` preset).
* **Layers**: `{name, order, shadow(ctx)?, opaque(ctx)?, transparent(ctx)?}`. GL state is reset before each call
  (see core.js header). ctx = `{gl, pass, S, time, dt, rdt, cam, env}`. In the shadow pass the Frame UBO's
  `uViewProj` is the light's matrix. Layer orders: terrain 0, buildings 100, props 150, agents 200, sky 900 (opaque,
  drawn last to fill empty pixels), water 500, particles 600, fx 700 (transparent).
* **Shader bodies** get `VC.shaderlib` prepended: `#version 300 es`, precision, the **Frame UBO** (see shaderlib.js
  header for every field), `uTileTex` (unit 6), `uNoiseTex` (unit 5), helpers (`hash*, vnoise, fbm2, tnoise, tileData,
  srgb2lin, rotQ`), and in fragment shaders `uShadowMap` (unit 7) + `shadowAt, cloudShadow, shade(albedo,n,wp,ao),
  specular(n,wp,gloss,strength), skyColor(dir), applyFog(col,wp), overlayRamp(v,kind)`. Macros: `TIME, NIGHT, SNOW,
  WET, SEA_Y`. Fragment shaders output **linear HDR** to `out vec4 fragColor`; post tonemaps. Emissive > 1 blooms.
  Units 0-4 are free per layer. Do not change the UBO layout.
* `uTileTex` texel = `(r: level/255, g: overlay value, b: flags bits [1 power, 2 water, 4 road, 8 building, 16 water tile,
  32 zoned], a: zone code/255)`. Overlay: `uMap.w` > 0 when on; `uHover.w` = ramp kind (0 good, 1 bad, 2 value, 3 net —
  for net, g=0 means n/a, 64 = unserved, 200 = network only, 255 = served).
* `VC.camera`: `tx,ty,tz,yaw,pitch,dist,goal{…}`, `pos, view, proj, viewProj, invViewProj`, `pan(dxPx,dyPx),
  panLocal(fwd,right), panWorld(dx,dz), orbit(dYaw,dPitch), zoom(f,px,py), focus(x,z,dist), snap(), shake(a)`,
  `screenRay(px,py)`, `worldToScreen(x,y,z)`, `raycast(px,py,{ignoreBuildings})` → `{x,z,wx,wy,wz,building,water}`,
  `pickGround`, `pickBuilding`, `cinematic` flag. Screen coords are CSS px relative to the canvas.
* `VC.voxel` / `VC.VoxelGrid` / `VC.models` / `VC.P` palette / `VC.MAT` flags: see `gfx/voxel.js` header
  (vertex format, model conventions, instance transform, parts, emitters, lights).

## 8. Module contracts (owner file → API others rely on)

### VC.sim — `sim/sim.js` (+ `sim/traffic.js`, `sim/names.js`)
`init, reset(S), update(dt,rdt)` (turns `rdt * C.SPEEDS[speed]` into whole days, ≤ 8 `tickDay()` per frame),
`tickDay()` (advance `S.time.day`, emit `day`; on month boundary do monthly sim work then emit `month {month, year}`;
on year boundary `year`). Maintains `S.flags`, `S.maps`, building runtime fields, `S.stats`, `S.demand`, `S.peakPop`.
Growth/level-up/abandonment of growables via `VC.world`. Everyday fires (ignite by risk, spread, burn down → rubble,
extinguished by fire coverage). API: `ignite(b)`, `extinguish(b)`, `recalcNetworks()`, `tileInfo(x,z)`,
`buildingInfo(b)` → `{name, subtitle, lines:[{label,value,cls?}], problems:[string], factors:[{label, value -1..1}]}`,
`buildingName(b)`, `demandFactors()` → `{R:[{label,value}],C:[],I:[]}`, `powerInfo()` → `{supply, demand, plants:[{b,output}]}`,
`waterInfo()` → `{supply, demand, sources:[{b,output}]}`, `serviceStats()` → `{police:{coverage 0..1, buildings, funding}, …}`.
Reads `VC.econ.effectiveness(dept)`, `VC.econ.taxEffect(zone)`, `S.mods`.

### VC.worldgen — `gen/worldgen.js`
`generate(S, opts)` fills height/terr/trees for `S.mapType` from `S.seed`. `previewCanvas({seed, mapType, size}, px)` →
HTMLCanvasElement (px×px) colored mini-map preview for the new-city dialog (fast, < 60 ms).

### Rubble
Burnt/destroyed buildings become `VC.world.addBuilding({key:'rubble', x, z, w, d, rot:0}, {instant:true})` (no catalog def;
model 'rubble' is `sized`). Rubble has pop/cap 0, blocks growth until bulldozed or cleared by sim after ~6 months.

### VC.econ — `sim/econ.js`
On `month`: taxes/income/upkeep/policy costs/loan payments via `VC.money`, `S.ledger.last`, `S.stats.income/expenses/net`,
`S.history` samples (pop, money, happiness, income, expenses, demandR/C/I, crime, pollution, traffic, power, water),
`computeMods()` (policies → `S.mods`). API: `setTax(zone, wealth|null, pct)`, `getTax(zone, wealth)`, `setFunding(dept, f)`,
`effectiveness(dept)` (0..~1.3, diminishing returns), `setPolicy(key, on)` → bool, `policyCost(key)`, `loanOptions()` →
`[{amount, rate, months, monthly}]`, `takeLoan(amount)`, `repayLoan(i)`, `deptUpkeep(dept)`, `forecast()` →
`{income:{cat:$}, expenses:{cat:$}, totalIncome, totalExpenses, net}`, `taxEffect(zone)` (demand/happiness penalty -1..1).

### VC.disasters — `sim/disasters.js`
`TYPES [{key,name,icon}]`, `active: [{type, x, z, y, t, dir, radius, …}]` (read by fx each frame), `trigger(type, x?, z?)`,
random disasters when `S.disastersEnabled && VC.settings.disasters`. Types: fire, tornado, meteor, earthquake, ufo, monster.

### VC.advisors — `sim/advisors.js`
`inbox [{id, advisor, title, text, severity:'info'|'warn'|'bad'|'good', day, read}]`, `news [string]`, `messages()`,
`markRead(id)`, `advice(advisorKey)`, `achievements()` → `[{key,name,icon,desc,done}]`. Emits `advisor`, `news`,
`milestone` (+ grants reward), `achievement`.

### VC.actions — `game/actions.js`
`roadPath(x0,z0,x1,z1)` → `[{x,z}]`, `canBuildRoad(tiles,type)`, `buildRoad(tiles,type)`, `zone(x0,z0,x1,z1,code)`
(0 = dezone), `canPlace(key,x,z,rot)` → `{ok, reason, cost, w, d}`, `placeBuilding(key,x,z,rot)` → `{ok, reason, b}`,
`bulldoze(x0,z0,x1,z1,opts)`, `terraform(x,z,radius,mode,level)`, `plantTrees(x0,z0,x1,z1)`, `powerLine(tiles)`.
All return `{ok, cost, reason?}`; charge via `VC.money`; emit `built` + `sfx`.

### VC.tools — `game/tools.js`
`current, select(key), hover {x,z}|null, selectedId, rotation, gridAlpha(), list(groupKey)` →
`[{key, name, icon, cost, desc, locked, unlock, group}]`, `info(key)`. Tool keys: `select, bulldoze, road_street,
road_avenue, road_highway, pline, <VC.ZONE_TOOLS key>, dezone, bld:<catalogKey>, trees, terrain_raise, terrain_lower,
terrain_level`. Previews: `VC.gfx.gizmo` + `VC.bldgfx.setGhost`.

### VC.input — `game/input.js`
Mouse/keyboard/touch → camera + tools. `KEYMAP: [{keys:'Space', action:'Pause'}, …]` (shown by the help window).

### VC.bldgfx — `gfx/buildings.js` (+ `gfx/props.js`)
Layer. `setGhost({key, x, z, rot, valid} | null)`, reads `VC.tools.selectedId` for highlight. Renders buildings,
trees, props (street lamps, traffic lights, power pylons + wires), glow sprites for model lights.

### VC.agents / VC.particles / VC.fx — `gfx/agents.js`, `gfx/particles.js`, `gfx/fx.js`
agents: `dispatch(kind, x, z)`, `count()`. particles: `emit(type,x,y,z,opts)`, `burst(type,x,y,z,n,opts)`
(types: smoke, steam, fire, dust, debris, sparkle, fountain, firework, spark, leaf, confetti). fx: weather state machine
writing `S.weather`, precipitation, lightning, disaster visuals from `VC.disasters.active`, `fireworks(x,z,n)`, `setWeather(type)`.

### VC.ui / VC.hud / VC.menu / VC.panels — `ui/*.js`
ui: see `ui/ui.js` header (windows, widgets, toast, modal, tooltips via `data-tip`). hud: `show, hide, toggleUI,
openSettings, openHelp`. menu: `show, hide`. panels: `list [{key,name,icon,hotkey}]`, `open(key)`, `toggle(key)`,
`inspect(building | {x,z})`. Panel keys: budget, policies, stats, population, services, utilities, advisors,
milestones, disasters, loans, inspector, save.
Hotkeys (KeyboardEvent.code; handled centrally in input.js): budget KeyM, policies KeyP, stats KeyG, population KeyU,
services KeyV, utilities KeyY, advisors KeyN, milestones KeyJ, disasters KeyX, save KeyK. Other keys: WASD/arrows pan,
Q/E rotate, R rotate building ghost, Space pause, Digit1..Digit0 + KeyT + KeyB tool groups (input emits bus
`toolGroup {key}`; hud opens that palette), KeyB bulldoze, Escape cancel tool / close top window / pause menu,
KeyH hide UI (photo mode), KeyC cinematic camera, KeyO cycle overlays, KeyL toggle grid?, F1 help, Equal/Minus zoom,
BracketLeft/BracketRight or comma/period for speed down/up.

### VC.audio / VC.save — `audio/audio.js`, `io/save.js`
audio: `play(name, {x,z,vol})`, listens to `sfx`, music + ambience from settings volumes. save: `serialize(S)`,
`deserialize(obj)` → S, `save(slot)`, `load(slot)` (calls `VC.startState`), `list()`, `remove(slot)`, `exportFile()`,
`importFile()`, autosave.

## 9. Style & quality rules

* Plain modern JS (ES2020), no dependencies, no network. Must work from `file://` in Chrome, Edge, Firefox, Safari.
* Performance matters: typed arrays, no per-frame allocations in hot loops, incremental updates, frustum culling,
  LOD. Target 60 fps on a mid-range laptop with a 128x128 city of ~5k buildings.
* Guard everything that can be missing (`VC.foo && VC.foo.bar`). Never throw from `update()`.
* Comment density: short header per file + comments on non-obvious logic.

## 10. Implemented extensions (post-merge reference)

Each module added APIs beyond the original contract. The file header of every module documents them in
full; this is the index.

* **Render core** (`gfx/core.js`, `shaderlib.js`, `shadows.js`, `post.js`): the shadow pass culls FRONT faces;
  `ctx.viewProj`, `ctx.frustum` (6 planes, cull against this — it is the light frustum in the shadow pass),
  `ctx.cascade` (-1 camera, 0/1 shadow cascades); `VC.gfx.depthProgram(name, vsBody)`,
  `boxVisible/sphereVisible/frustumPlanes`, `render(dt, rdt, force)` (may skip frames when the GPU lags),
  `profile()`, `caps.software` (`?soft=0|1`), `TOD_KEYS`, `sunDirection()`. UBO `uPad` is reserved.
  GLSL: `libLuma, libIgn, libSunDir, libMoonDir, libFogColor, libFogAmount`, `#define LIB_SOFT` on CPU GL.
  `VC.post.debugView`, `VC.post.tune`, settings `ssao`, `godRays`.
* **Terrain/worldgen**: `VC.terrain.roadY(wx,wz)`, `surfaceY`, `roadInfo(x,z)`, `lampSpots(x,z)`, `DECK_Y`, `CURB`,
  `SKIRT_Y`, `warmup()`; `VC.worldgen.previewCanvas(o, px)`, `startArea(S)`, `sample()`.
* **Water/sky**: `VC.sky.GLSL` + `VC.sky.attach(prog)` (SkyFrame UBO, binding 3), `moonPhase`, `moonIllum`,
  `forceAurora`, `forceRainbow`, `shootingStar()`; `VC.water.ocean`, `mode`, `depthAt`, `shoreDist`, `iceAt`, `flowAt`.
  Water writes no depth.
* **Buildings/props**: `VC.bldgfx.setGhost`, `handlesLift`, `warm()`, `inspect(id)`, `eng` (shared instancing engine);
  `VC.props`. Construction/fire/powered/disLift are polled per frame (no `changed()` needed).
* **Models**: `VC.growKit`, `VC.civicKit`, `VC.natureKit` (`treeFor`, `signalVariant`, `seasonPalette`, `toWorld`);
  `grid.meta.style`, `meta.rocket`, `meta.wire`, `meta.siren`, `meta.nav`, `meta.feet`; `def.lodMinFill`.
* **Sim**: `growReason(x,z)`, `issues()`, `trafficStats()`, `trafficVolume`, `trafficParent`, `cityTitle()`,
  `powerInfo().deficit/shortage/unpowered`, building fields `simJobs`, `simReplay`.
* **Econ**: `forecast()` (+ `taxDetail`, `dept`, `policies`, `venues`), `loanOptions()`, `takeLoan(amount|option, months)`,
  `debt()`, `creditLimit()`, `runway()`, `onStrike(dept)`, `effectivenessAt(f)`, `CATEGORIES`; bus `econ`.
  Temporary modifiers: `addTempMod({id?, source, label, icon?, mods, until|days})`, `removeTempMod(id)`,
  `tempMods()` (stored in `S.tempMods`, folded into `S.mods`). Policies carry a level 0..1 (`levels:false` = on/off).
* **Disasters**: `trigger(type,x,z,opts)`, `info`, `setEnabled`, `nextIn`, `focus`, `clear`, `S.disasterStats`;
  active entry fields documented in `sim/disasters.js`. Buildings being abducted carry `b.disLift`.
* **Advisors**: `adviceInfo(key)`, `milestoneInfo()`, `toastAchievements`.
* **Mayor's Goals** (`sim/goals.js`, HUD `ui/hud_goals.js`): `VC.goals.list()`, `claim(id)`, `swap(id)`,
  `focusOf(goal)`, `rewardText/rewardLong`, `refresh()`, `add(kind)` (debug); state `S.goals`; bus `goalDone`,
  `goalClaimed`, `goalRotated`. Anti-farming rules are documented in the file header.
* **Mayor's Desk** (`sim/desk.js`, HUD `ui/hud_desk.js`): `VC.desk.pending()`, `choose(i)`, `timeLeft()`,
  `history()`, `trigger(id)` (debug); state `S.desk` (recurring deals billed by econ as `deskDeal`); bus
  `deskEvent`, `deskResolved`. `VC.deskHud.layout()` lays out the shared left column (goals + desk).
* **Juice** (`ui/hud_notify.js`, `gfx/fx_celebrate.js`): `VC.hud.juice.pop(x, y, z, text, cls?)` world-anchored
  pills, month-end coin showers, milestone-progress celebrations; `VC.fxCel.fireworks/confetti/launch`.
  Everything obeys `VC.settings.juice === false`, never toasts, and is silent in the title-screen demo (`S.demo`).
* **Actions/tools/input**: `can*` validators, undo (`canUndo/undo`, 10 s), `beginGroup/endGroup`; `VC.tools.rotate`,
  `adjustBrush`, `cancel`, tools layer (order 990); `VC.input.KEYMAP [{group, keys, action}]`, `enabled()`.
* **Agents/particles/fx**: `VC.agents.signal(x,z)`, `vehicles()`; extra particle types (rainsplash, contrail, fog,
  wake, ember, flash, willow, crackle, firefly); `VC.fx.weatherInfo`, `confetti`, `launchRocket`, `isLaunching`,
  `lightning`; `VC.fxgl` helpers.
* **UI**: `VC.ui` extra widgets (`segmented, sparkline, cards, counter, input, kbd, badge, prompt, popover`),
  live tooltips (`el._tip`); `VC.hud` (`photoMode, openPanel, pushNews, showMilestone, startTutorial…`);
  `VC.menu` (`startGame, loadGame, newCity, pause, resume, fade`); `VC.panels.open(key, {tab})`, `close`, `isOpen`,
  `refresh`, `onSelectHook`.
* **Boot/debug** (`main.js`): `VC.showBootError(msg, err)`, `VC.bootFailed`, `VC.errors` (deduped, capped at 200);
  `VC.debug.newGame/cam/tod/run(days)/perf/errors/failures/sampleCity` (used by `tools/smoke.js` and `tools/shot.js`).
  `src/index.html` carries a 20 s boot watchdog that explains a stalled start instead of showing a blank page.
* **Audio/save**: `VC.audio.play(name, {x,z,vol,rate,delay})` + auto-handled bus events (see `audio/audio.js`);
  `VC.save.register(key, {save, load})`, `importText`, `exportBlob`, `selfTest()`; bus `saved`, `loaded`, `saveFailed`.
