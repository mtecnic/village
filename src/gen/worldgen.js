/*
 * VOXELPOLIS — world generation (BASIC FOUNDATION VERSION — to be replaced/extended).
 * VC.worldgen.generate(S, opts) fills S.height, S.terr, S.trees from S.seed / S.mapType.
 */
VC.worldgen = {
  generate(S, opts = {}) {
    const C = VC.C;
    const nz = VC.makeNoise(S.seed);
    const W = S.W, H = S.H;
    for (let z = 0; z < H; z++)
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        let n = nz.fbm(x * 0.018, z * 0.018, 5) * 0.5 + 0.5; // 0..1
        n = Math.pow(n, 1.3);
        // terraces for buildable plateaus
        let lv = n * 34;
        const t = Math.floor(lv / 3) * 3;
        lv = t + Math.min(3, (lv - t) * 2.2);
        let h = Math.round(lv) + 2;
        S.height[i] = VC.M.clamp(h, 0, C.MAXH);
      }
    for (let i = 0; i < S.N; i++) {
      const h = S.height[i];
      const x = i % W, z = (i / W) | 0;
      if (h < C.SEA) S.terr[i] = VC.TERR.SAND;
      else if (h <= C.SEA + 1) S.terr[i] = VC.TERR.SAND;
      else if (h > 30) S.terr[i] = VC.TERR.SNOW;
      else if (h > 24) S.terr[i] = VC.TERR.ROCK;
      else S.terr[i] = nz.n2(x * 0.05 + 50, z * 0.05) > 0.3 ? VC.TERR.MEADOW : VC.TERR.GRASS;
      const f = nz.fbm(x * 0.04 + 100, z * 0.04 - 40, 3);
      if (h > C.SEA + 1 && h <= 28 && f > 0.15) S.trees[i] = f > 0.35 ? 3 : f > 0.25 ? 2 : 1;
    }
    S.ver.terrain++;
    S.ver.trees++;
  },
};
