/*
 * VOXELPOLIS — orbit camera: smooth RTS-style camera around a ground target point,
 * matrices, screen<->world conversion and ray picking (tiles + buildings).
 *
 * All screen coordinates are CSS pixels relative to the canvas' top-left.
 * yaw: radians around Y (0 = camera on +Z side looking toward -Z)
 * pitch: radians above horizon (clamped 0.35..1.5)
 */
const M = VC.M, Mat4 = VC.Mat4;
const cam = (VC.camera = {
  // current (smoothed) values
  tx: 64, ty: 1.5, tz: 64,
  yaw: Math.PI * 0.25,
  pitch: 0.85,
  dist: 45,
  // goal values
  goal: { tx: 64, tz: 64, yaw: Math.PI * 0.25, pitch: 0.85, dist: 45 },
  fov: 34 * M.DEG,
  aspect: 16 / 9,
  near: 0.3,
  far: 1500,
  minDist: 4,
  maxDist: 260,
  minPitch: 0.3,
  maxPitch: 1.5,
  pos: [0, 0, 0],
  view: Mat4.create(),
  proj: Mat4.create(),
  viewProj: Mat4.create(),
  invViewProj: Mat4.create(),
  shakeAmt: 0,
  cinematic: false,
  _shake: [0, 0, 0],

  reset(S) {
    const g = cam.goal;
    g.tx = cam.tx = S.W / 2;
    g.tz = cam.tz = S.H / 2;
    g.yaw = cam.yaw = Math.PI * 0.25;
    g.pitch = cam.pitch = 0.82;
    g.dist = cam.dist = Math.min(70, S.W * 0.45);
    cam.maxDist = Math.max(120, S.W * 1.3);
    cam.ty = VC.world.groundY(cam.tx, cam.tz);
  },

  update(dt, rdt) {
    const g = cam.goal, S = VC.state;
    if (cam.cinematic) {
      g.yaw += rdt * 0.06;
    }
    if (S) {
      g.tx = M.clamp(g.tx, -8, S.W + 8);
      g.tz = M.clamp(g.tz, -8, S.H + 8);
    }
    g.dist = M.clamp(g.dist, cam.minDist, cam.maxDist);
    g.pitch = M.clamp(g.pitch, cam.minPitch, cam.maxPitch);
    const r = 12;
    cam.tx = M.damp(cam.tx, g.tx, r, rdt);
    cam.tz = M.damp(cam.tz, g.tz, r, rdt);
    cam.yaw = M.damp(cam.yaw, g.yaw, r, rdt);
    cam.pitch = M.damp(cam.pitch, g.pitch, r, rdt);
    cam.dist = Math.exp(M.damp(Math.log(cam.dist), Math.log(g.dist), r, rdt));
    if (S) cam.ty = M.damp(cam.ty, sampleGround(cam.tx, cam.tz), 4, rdt);
    if (cam.shakeAmt > 0.001) {
      const a = cam.shakeAmt;
      cam._shake = [(Math.random() - 0.5) * a, (Math.random() - 0.5) * a * 0.5, (Math.random() - 0.5) * a];
      cam.shakeAmt *= Math.exp(-rdt * 4);
    } else cam._shake = [0, 0, 0];
  },

  computeMatrices() {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const sh = cam._shake;
    const t = [cam.tx + sh[0], cam.ty + sh[1], cam.tz + sh[2]];
    cam.pos = [t[0] + cam.dist * cp * Math.sin(cam.yaw), t[1] + cam.dist * sp, t[2] + cam.dist * cp * Math.cos(cam.yaw)];
    // keep the eye above terrain
    if (VC.state) {
      const gy = sampleGround(cam.pos[0], cam.pos[2]) + 0.6;
      if (cam.pos[1] < gy) cam.pos[1] = gy;
    }
    cam.near = Math.max(0.15, cam.dist * 0.02);
    cam.far = cam.dist * 6 + 500;
    Mat4.lookAt(cam.view, cam.pos, t, [0, 1, 0]);
    Mat4.perspective(cam.proj, cam.fov, cam.aspect, cam.near, cam.far);
    Mat4.mul(cam.viewProj, cam.proj, cam.view);
    Mat4.invert(cam.invViewProj, cam.viewProj);
  },

  /* ---------------- controls ---------------- */
  /** Pan by a screen-space drag delta in CSS pixels (drag the ground). */
  pan(dxPx, dyPx) {
    const h = VC.gfx.canvas ? VC.gfx.canvas.clientHeight : 800;
    const worldPerPx = (2 * cam.goal.dist * Math.tan(cam.fov / 2)) / h;
    const s = Math.sin(cam.goal.yaw), c = Math.cos(cam.goal.yaw);
    const fwdScale = 1 / Math.max(0.35, Math.sin(cam.goal.pitch));
    cam.goal.tx -= (dxPx * c + dyPx * s * fwdScale) * worldPerPx;
    cam.goal.tz -= (-dxPx * s + dyPx * c * fwdScale) * worldPerPx;
  },
  /** Pan relative to the view direction, in world units. forward > 0 moves away from camera. */
  panLocal(forward, right) {
    const s = Math.sin(cam.goal.yaw), c = Math.cos(cam.goal.yaw);
    cam.goal.tx += -s * forward + c * right;
    cam.goal.tz += -c * forward - s * right;
  },
  panWorld(dx, dz) {
    cam.goal.tx += dx;
    cam.goal.tz += dz;
  },
  orbit(dYaw, dPitch) {
    cam.goal.yaw += dYaw;
    cam.goal.pitch = M.clamp(cam.goal.pitch + dPitch, cam.minPitch, cam.maxPitch);
  },
  /** Multiplies distance by f (<1 zooms in). If px/py given, zooms toward that screen point. */
  zoom(f, px, py) {
    const g = cam.goal;
    const nd = M.clamp(g.dist * f, cam.minDist, cam.maxDist);
    const realF = nd / g.dist;
    if (px != null) {
      const hit = cam.pickGround(px, py);
      if (hit) {
        g.tx += (hit.wx - g.tx) * (1 - realF);
        g.tz += (hit.wz - g.tz) * (1 - realF);
      }
    }
    g.dist = nd;
  },
  /** Smoothly moves to look at world (x,z). */
  focus(x, z, dist) {
    cam.goal.tx = x;
    cam.goal.tz = z;
    if (dist) cam.goal.dist = dist;
  },
  /** Instantly jumps (no smoothing). */
  snap() {
    const g = cam.goal;
    cam.tx = g.tx; cam.tz = g.tz; cam.yaw = g.yaw; cam.pitch = g.pitch; cam.dist = g.dist;
    if (VC.state) cam.ty = sampleGround(cam.tx, cam.tz);
  },
  shake(amount) {
    cam.shakeAmt = Math.max(cam.shakeAmt, amount);
  },

  /* ---------------- projection helpers ---------------- */
  /** Screen (CSS px) -> world ray {o:[x,y,z], d:[x,y,z] normalized}. */
  screenRay(px, py) {
    const cv = VC.gfx.canvas;
    const nx = (px / cv.clientWidth) * 2 - 1;
    const ny = 1 - (py / cv.clientHeight) * 2;
    const a = Mat4.xform4(cam.invViewProj, nx, ny, -1, 1);
    const b = Mat4.xform4(cam.invViewProj, nx, ny, 1, 1);
    const o = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    const e = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    return { o, d: VC.V3.norm([e[0] - o[0], e[1] - o[1], e[2] - o[2]]) };
  },
  /** World -> screen CSS px. Returns [x, y, depthNdc] or null if behind camera. */
  worldToScreen(x, y, z) {
    const cv = VC.gfx.canvas;
    const p = Mat4.xform4(cam.viewProj, x, y, z, 1);
    if (p[3] <= 0) return null;
    return [((p[0] / p[3]) * 0.5 + 0.5) * cv.clientWidth, (1 - ((p[1] / p[3]) * 0.5 + 0.5)) * cv.clientHeight, p[2] / p[3]];
  },
  /**
   * Casts a ray through the heightmap (and buildings). Returns
   * { x, z (tile), wx, wy, wz (hit point), building (or null), water (bool) } or null.
   */
  raycast(px, py, opts = {}) {
    const S = VC.state;
    if (!S) return null;
    const { o, d } = cam.screenRay(px, py);
    return raycastWorld(o, d, opts);
  },
  /** Ground hit ignoring buildings. */
  pickGround(px, py) {
    return cam.raycast(px, py, { ignoreBuildings: true });
  },
  pickBuilding(px, py) {
    const r = cam.raycast(px, py);
    return r ? r.building : null;
  },
});

function sampleGround(x, z) {
  const S = VC.state;
  if (!S) return 0;
  const xi = M.clamp(Math.floor(x), 0, S.W - 1), zi = M.clamp(Math.floor(z), 0, S.H - 1);
  return Math.max(S.height[zi * S.W + xi] * VC.C.STEP, VC.C.SEA_Y);
}

function rayBox(o, d, x0, y0, z0, x1, y1, z1) {
  let tmin = -Infinity, tmax = Infinity;
  const lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return -1;
    } else {
      let t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  if (tmax < 0) return -1;
  return tmin >= 0 ? tmin : 0;
}

/** Grid DDA through tile columns. */
function raycastWorld(o, d, opts) {
  const S = VC.state;
  const STEP = VC.C.STEP, SEA_Y = VC.C.SEA_Y;
  const top = (x, z) => Math.max(S.height[z * S.W + x] * STEP, SEA_Y);
  // enter the map box (y range generous)
  let t0 = rayBox(o, d, 0, -1, 0, S.W, VC.C.MAXH * STEP + 40, S.H);
  if (t0 < 0) {
    // off-map: intersect the sea plane for approximate result
    if (d[1] >= 0) return null;
    const t = (SEA_Y - o[1]) / d[1];
    const wx = o[0] + d[0] * t, wz = o[2] + d[2] * t;
    return { x: Math.floor(wx), z: Math.floor(wz), wx, wy: SEA_Y, wz, building: null, water: true, offMap: true };
  }
  t0 += 1e-4;
  let x = Math.floor(o[0] + d[0] * t0), z = Math.floor(o[2] + d[2] * t0);
  x = M.clamp(x, 0, S.W - 1);
  z = M.clamp(z, 0, S.H - 1);
  const stepX = d[0] > 0 ? 1 : -1, stepZ = d[2] > 0 ? 1 : -1;
  const px = o[0] + d[0] * t0, pz = o[2] + d[2] * t0;
  const tDX = Math.abs(1 / (d[0] || 1e-9)), tDZ = Math.abs(1 / (d[2] || 1e-9));
  let tMX = t0 + (d[0] > 0 ? x + 1 - px : px - x) * tDX;
  let tMZ = t0 + (d[2] > 0 ? z + 1 - pz : pz - z) * tDZ;
  let tEnter = t0;
  const checked = new Set();
  for (let iter = 0; iter < S.W + S.H + 4; iter++) {
    if (x < 0 || z < 0 || x >= S.W || z >= S.H) break;
    const tExit = Math.min(tMX, tMZ);
    // buildings
    if (!opts.ignoreBuildings) {
      const id = S.bld[z * S.W + x];
      if (id && !checked.has(id)) {
        checked.add(id);
        const b = S.buildings.get(id);
        if (b) {
          const by = S.height[b.z * S.W + b.x] * STEP;
          const tb = rayBox(o, d, b.x, by - 0.01, b.z, b.x + b.w, by + Math.max(0.3, b.hgt || 1), b.z + b.d);
          if (tb >= 0) {
            const wx = o[0] + d[0] * tb, wy = o[1] + d[1] * tb, wz = o[2] + d[2] * tb;
            return { x: M.clamp(Math.floor(wx), b.x, b.x + b.w - 1), z: M.clamp(Math.floor(wz), b.z, b.z + b.d - 1), wx, wy, wz, building: b, water: false };
          }
        }
      }
    }
    // terrain column
    const h = top(x, z);
    const yEnter = o[1] + d[1] * tEnter, yExit = o[1] + d[1] * tExit;
    if (yEnter <= h + 1e-4) {
      return { x, z, wx: o[0] + d[0] * tEnter, wy: yEnter, wz: o[2] + d[2] * tEnter, building: null, water: S.height[z * S.W + x] < VC.C.SEA, side: true };
    }
    if (yExit <= h) {
      const th = (h - o[1]) / d[1];
      return { x, z, wx: o[0] + d[0] * th, wy: h, wz: o[2] + d[2] * th, building: null, water: S.height[z * S.W + x] < VC.C.SEA };
    }
    tEnter = tExit;
    if (tMX < tMZ) { tMX += tDX; x += stepX; }
    else { tMZ += tDZ; z += stepZ; }
  }
  return null;
}
VC.camera.raycastWorld = raycastWorld;
