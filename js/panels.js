// The thesis's policy_map.png as one SVG: a row of (F, rho) panels, one per year,
// sharing the log-rho axis and a single colour bar. Three layers per panel, as in
// contribution_schedule_suite.policy_map:
//
//   colour   the optimal rule a*(t, F, rho), viridis on [0, 1];
//   white    iso TOTAL-replacement contours, RR_TARGET picked out in gold;
//   magenta  where the simulated cohort is that year (50/90/99th percentile of the
//            positive occupancy cells), traced by marching squares.
//
// The third layer is what keeps the first two honest: the rule is defined on the
// whole grid, but only a thin ribbon of it is ever reached.
//
// Needs charts.js (makeScale, niceTicks, pathFrom, VIRIDIS, colourBar, chartSvg).

// 736 units wide on purpose: at ~1 unit per pixel the 7-9px text stays legible, so
// the figure scrolls on a phone rather than scaling down (.chart-figure-full).
const PANEL_GEOM = { width: 736, height: 244, top: 24, bottom: 42, left: 46, gap: 10, bar: 60 };

const RR_LEVELS = [0.5, 0.6, 0.8, 1.0, 1.5];   // the thesis's levels
const OCC_QUANTILES = [0.5, 0.9, 0.99];

/** numpy.quantile's default (linear) interpolation. */
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

/** Marching squares: segments of the level-L isoline of V, sampled at the points
 *  (xc[i], yc[j]) — already in pixels, so interpolating there is interpolating in
 *  F and log-rho, the axes the panel draws. Saddles are resolved by the cell mean. */
function isoSegments(V, xc, yc, L) {
  const segs = [];
  for (let i = 0; i < V.length - 1; i++) {
    for (let j = 0; j < V[i].length - 1; j++) {
      // corners anticlockwise from bottom-left; edge e joins corner e to e+1
      const P = [[xc[i], yc[j]], [xc[i + 1], yc[j]], [xc[i + 1], yc[j + 1]], [xc[i], yc[j + 1]]];
      const v = [V[i][j], V[i + 1][j], V[i + 1][j + 1], V[i][j + 1]];
      const up = v.map((x) => x >= L);
      const cross = [];
      for (let e = 0; e < 4; e++) {
        const f = (e + 1) % 4;
        if (up[e] === up[f]) continue;
        const t = (L - v[e]) / (v[f] - v[e]);
        cross[e] = [P[e][0] + t * (P[f][0] - P[e][0]), P[e][1] + t * (P[f][1] - P[e][1])];
      }
      const es = [0, 1, 2, 3].filter((e) => cross[e]);
      if (es.length === 2) {
        segs.push([cross[es[0]], cross[es[1]]]);
      } else if (es.length === 4) {
        // saddle: if the centre sides with corners 0 and 2 they connect through it,
        // so the lines cut off corners 1 and 3 — and vice versa
        const centreUp = (v[0] + v[1] + v[2] + v[3]) / 4 >= L;
        if (centreUp === up[0]) segs.push([cross[0], cross[1]], [cross[2], cross[3]]);
        else segs.push([cross[3], cross[0]], [cross[1], cross[2]]);
      }
    }
  }
  return segs.map(([[x0, y0], [x1, y1]]) =>
    `M${x0.toFixed(1)},${y0.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)}`).join(" ");
}

/** Log-rho ticks: decades, plus 2 and 5 when the range spans too few of them. */
function logTicks(lo, hi) {
  const within = (mults) => {
    const out = [];
    for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
      for (const m of mults) {
        const v = m * 10 ** k;
        if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
      }
    }
    return out;
  };
  const dec = within([1]);
  return dec.length >= 3 ? dec : within([1, 2, 5]);
}

const fmtTick = (v) => (v >= 1 ? v.toFixed(0) : String(+v.toPrecision(1)));

/**
 * @param F, rho   cell edges from the API (policy_maps.F / .rho)
 * @param maps     [{ year, a, visits }], a and visits indexed [F cell][rho cell]
 */
function policyPanels({ F, rho, maps, legal, target, annuity }) {
  const g = PANEL_GEOM;
  const n = maps.length;
  const plotH = g.height - g.top - g.bottom;
  const plotW = (g.width - g.left - g.bar - (n - 1) * g.gap) / n;
  const la = Math.log(rho[0]);
  const lb = Math.log(rho[rho.length - 1]);
  const yOf = (r) => g.top + plotH - ((Math.log(r) - la) / (lb - la || 1)) * plotH;
  const yTicks = logTicks(rho[0], rho[rho.length - 1]);

  // cell centres for the occupancy contours; geometric in rho, the axis is log
  const Fc = F.slice(0, -1).map((f, i) => (f + F[i + 1]) / 2);
  const Rc = rho.slice(0, -1).map((r, j) => Math.sqrt(r * rho[j + 1]));

  // The RR surface does not depend on t, so the contour paths are the same in every
  // panel: sample densely, with F = 1 itself included — max(F, 1) kinks there.
  const Fs = Array.from({ length: 61 }, (_, k) => F[0] + (k / 60) * (F[F.length - 1] - F[0]));
  if (F[0] < 1 && F[F.length - 1] > 1) Fs.push(1);
  Fs.sort((p, q) => p - q);
  const levels = [...RR_LEVELS.filter((l) => Math.abs(l - target) > 1e-9), target]
    .filter((rr) => rr > legal);

  const panels = maps.map((m, p) => {
    const x0 = g.left + p * (plotW + g.gap);
    const xs = makeScale([F[0], F[F.length - 1]], [x0, x0 + plotW]);
    const clip = `pp-clip-${p}`;

    let cells = "";
    for (let i = 0; i < m.a.length; i++) {
      for (let j = 0; j < m.a[i].length; j++) {
        const v = m.a[i][j];
        if (v === null || v === undefined) continue;
        const cx = xs(F[i]);
        const cy = yOf(rho[j + 1]);
        cells += `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${(xs(F[i + 1]) - cx + 0.4).toFixed(1)}" height="${(yOf(rho[j]) - cy + 0.4).toFixed(1)}" fill="${VIRIDIS(v)}" />`;
      }
    }

    // iso total replacement: RR = legal + max(F,1)/(annuity*rho), exact, so no tracing
    const contours = levels
      .map((rr) => {
        const isTarget = rr === target;
        const pts = [];
        for (const f of Fs) {
          const r = Math.max(f, 1) / (annuity * (rr - legal));
          if (r >= rho[0] && r <= rho[rho.length - 1]) pts.push([xs(f), yOf(r)]);
        }
        if (pts.length < 2) return "";
        const cls = isTarget ? "chart-contour chart-contour-target" : "chart-contour";
        // labelled in the first panel only: the curves are identical in every one
        let label = "";
        if (p === 0) {
          const [lx, ly] = pts[Math.floor(pts.length * (isTarget ? 0.7 : 0.45))];
          label = `<text x="${lx.toFixed(1)}" y="${(ly - 2.5).toFixed(1)}" class="chart-contour-label${isTarget ? " chart-contour-label-target" : ""}">${isTarget ? `target ${rr.toFixed(2)}` : rr.toFixed(2)}</text>`;
        }
        return `<path d="${pathFrom(pts)}" class="${cls}" />${label}`;
      })
      .join("");

    // Occupancy. Early on essentially all mass sits in one cell and the quantiles
    // coincide; a contour is then meaningless, so ring the cell instead.
    const pos = m.visits.flat().filter((v) => v > 0).sort((p1, p2) => p1 - p2);
    let occ = "";
    let present = 0;
    for (const row of m.visits) for (const v of row) present += v;
    if (pos.length) {
      const lv = [...new Set(OCC_QUANTILES.map((q) => quantile(pos, q)))];
      if (lv.length > 1) {
        const xc = Fc.map(xs);
        const yc = Rc.map(yOf);
        occ = lv.map((L) => `<path d="${isoSegments(m.visits, xc, yc, L)}" class="chart-occ" />`).join("");
      } else {
        let bi = 0, bj = 0;
        m.visits.forEach((row, i) => row.forEach((v, j) => {
          if (v > m.visits[bi][bj]) { bi = i; bj = j; }
        }));
        occ = `<circle cx="${xs(Fc[bi]).toFixed(1)}" cy="${yOf(Rc[bj]).toFixed(1)}" r="5" class="chart-occ" />`;
      }
    }

    const par = F[0] <= 1 && F[F.length - 1] >= 1
      ? `<line x1="${xs(1).toFixed(1)}" y1="${g.top}" x2="${xs(1).toFixed(1)}" y2="${g.top + plotH}" class="chart-par" />`
      : "";

    // the right-end label would run into the next panel's left-end one
    const xTicks = niceTicks(F[0], F[F.length - 1], 4)
      .filter((_, k, all) => p === n - 1 || k < all.length - 1)
      .map((v) => `<text x="${xs(v).toFixed(1)}" y="${g.top + plotH + 12}" class="chart-tick chart-tick-x">${v.toFixed(1)}</text>`)
      .join("");
    const yAxis = yTicks
      .map((v) => {
        const y = yOf(v).toFixed(1);
        const lab = p === 0
          ? `<text x="${x0 - 4}" y="${y}" class="chart-tick chart-tick-y">${fmtTick(v)}</text>`
          : "";
        return `<line x1="${x0 - 2}" y1="${y}" x2="${x0}" y2="${y}" class="chart-axis" />${lab}`;
      })
      .join("");

    return `<clipPath id="${clip}"><rect x="${x0}" y="${g.top}" width="${plotW}" height="${plotH}" /></clipPath>
      <g clip-path="url(#${clip})">${cells}${contours}${occ}${par}</g>
      <rect x="${x0}" y="${g.top}" width="${plotW}" height="${plotH}" fill="none" class="chart-axis" />
      ${yAxis}${xTicks}
      <text x="${x0 + plotW / 2}" y="${g.top - 7}" class="chart-title" text-anchor="middle">t = ${m.year}  (${Math.round(present).toLocaleString()} present)</text>
      <text x="${x0 + plotW / 2}" y="${g.height - 6}" class="chart-axis-label" text-anchor="middle">F = R / L</text>`;
  });

  const yLabel = `<text transform="translate(11 ${g.top + plotH / 2}) rotate(-90)" class="chart-axis-label" text-anchor="middle">ρ = S / L   (log)</text>`;
  const bar = colourBar({
    x: g.width - g.bar + 14, y: g.top, w: 10, h: plotH, ramp: VIRIDIS,
    label: "optimal funding a*", ticks: [[0, "0"], [0.5, "0.5"], [1, "1"]],
  });

  return chartSvg(`${panels.join("")}${yLabel}${bar}`,
                  `Optimal funding rule a*(F, rho) in years ${maps.map((m) => m.year).join(", ")}, with iso-replacement contours and where the simulated cohort is`,
                  g.width, g.height);
}
