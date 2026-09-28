// The thesis's (F, rho) panel figures as SVG: policy_map.png and
// benchmark_misfunding.png. Both are small multiples on one state space, sharing
// the log-rho axis and one colour bar, at the grid's full node resolution — the
// heatmaps go through heatImage (charts.js), one pixel per node.
//
// Needs charts.js (makeScale, niceTicks, pathFrom, VIRIDIS, RDBU, heatImage,
// colourBar, chartSvg).

// 736 units wide on purpose: at ~1 unit per pixel the 7-9px text stays legible, so
// the figure scrolls on a phone rather than scaling down (.chart-figure-full).
const PANEL_W = 736;

const RR_LEVELS = [0.5, 0.6, 0.8, 1.0, 1.5];   // policy_map's levels
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

/** Sparse [i, j, count, ...] cells (as the API sends them) to a dense nF x nR grid. */
function denseVisits(cells, nF, nR) {
  const V = Array.from({ length: nF }, () => new Array(nR).fill(0));
  for (const [i, j, n] of cells) V[i][j] = n;
  return V;
}

/** That year's occupancy at the 50/90/99th percentile of the occupied cells, as in
 *  the thesis's _contours. Early on essentially all mass sits in one cell and the
 *  quantiles coincide; a contour is then meaningless, so the modal cell is ringed. */
function occupancyContours(cells, nF, nR, xc, yc, cls) {
  if (!cells.length) return "";
  const pos = cells.map((c) => c[2]).sort((a, b) => a - b);
  const lv = [...new Set(OCC_QUANTILES.map((q) => quantile(pos, q)))];
  if (lv.length > 1) {
    const V = denseVisits(cells, nF, nR);
    return lv.map((L) => `<path d="${isoSegments(V, xc, yc, L)}" class="${cls}" />`).join("");
  }
  const [bi, bj] = cells.reduce((b, c) => (c[2] > b[2] ? c : b));
  return `<circle cx="${xc[bi].toFixed(1)}" cy="${yc[bj].toFixed(1)}" r="5" class="${cls}" />`;
}

/** Shared small-multiples frame: panel origins, per-panel x scale, shared log-rho
 *  y scale, ticks, clip paths. `xDom`/`yDom` are the DISPLAYED ranges, which the
 *  misfunding figure crops to the occupied ribbon. */
function panelGrid({ n, ncol, left, top, bottom, gap, rowGap, bar, plotH, xDom, yDom, idPrefix }) {
  const nrow = Math.ceil(n / ncol);
  const plotW = (PANEL_W - left - bar - (ncol - 1) * gap) / ncol;
  const height = top + nrow * plotH + (nrow - 1) * rowGap + bottom;
  const la = Math.log(yDom[0]);
  const lb = Math.log(yDom[1]);
  const yTicks = logTicks(yDom[0], yDom[1]);
  const xTickVals = niceTicks(xDom[0], xDom[1], 4);

  const cell = (p) => {
    const col = p % ncol;
    const row = Math.floor(p / ncol);
    const x0 = left + col * (plotW + gap);
    const y0 = top + row * (plotH + rowGap);
    const xs = makeScale(xDom, [x0, x0 + plotW]);
    const yOf = (r) => y0 + plotH - ((Math.log(r) - la) / (lb - la || 1)) * plotH;
    const clip = `${idPrefix}-${p}`;
    const lastInCol = p + ncol >= n;
    const frame = (inner) => `
      <clipPath id="${clip}"><rect x="${x0}" y="${y0}" width="${plotW}" height="${plotH}" /></clipPath>
      <g clip-path="url(#${clip})">${inner}</g>
      <rect x="${x0}" y="${y0}" width="${plotW}" height="${plotH}" fill="none" class="chart-axis" />
      ${yTicks.map((v) => {
        const y = yOf(v).toFixed(1);
        const lab = col === 0 ? `<text x="${x0 - 4}" y="${y}" class="chart-tick chart-tick-y">${fmtTick(v)}</text>` : "";
        return `<line x1="${x0 - 2}" y1="${y}" x2="${x0}" y2="${y}" class="chart-axis" />${lab}`;
      }).join("")}
      ${xTickVals
        // the right-end label would run into the next panel's left-end one
        .filter((_, k, all) => col === ncol - 1 || p === n - 1 || k < all.length - 1)
        .map((v) => `<text x="${xs(v).toFixed(1)}" y="${y0 + plotH + 11}" class="chart-tick chart-tick-x">${v.toFixed(1)}</text>`)
        .join("")}
      ${lastInCol ? `<text x="${x0 + plotW / 2}" y="${y0 + plotH + 24}" class="chart-axis-label" text-anchor="middle">F = R / L</text>` : ""}`;
    return { x0, y0, xs, yOf, frame, col, row };
  };
  return { cell, plotW, plotH, height, nrow };
}

/**
 * policy_map.png: per year, the optimal rule a*(t, F, rho) in viridis, iso TOTAL
 * replacement contours in white with the target picked out in gold, and where
 * the simulated cohort is that year in magenta. The third layer is what keeps the
 * first two honest: the rule is defined on the whole grid, but only a thin ribbon
 * of it is ever reached.
 *
 * @param F, rho   grid NODES
 * @param maps     [{ year, a, visits, present }]: a is [F node][rho node], visits
 *                 sparse [i, j, count]
 */
function policyPanels({ F, rho, maps, legal, target, annuity }) {
  const nF = F.length;
  const nR = rho.length;
  const g = panelGrid({
    n: maps.length, ncol: 4, left: 46, top: 24, bottom: 30, gap: 10, rowGap: 46,
    bar: 60, plotH: 150, xDom: [F[0], F[nF - 1]], yDom: [rho[0], rho[nR - 1]],
    idPrefix: "pp-clip",
  });

  // The RR surface does not depend on t, so the contour paths are the same in every
  // panel: sample densely, with F = 1 itself included — max(F, 1) kinks there.
  const Fs = Array.from({ length: 61 }, (_, k) => F[0] + (k / 60) * (F[nF - 1] - F[0]));
  if (F[0] < 1 && F[nF - 1] > 1) Fs.push(1);
  Fs.sort((p, q) => p - q);
  const levels = [...RR_LEVELS.filter((l) => Math.abs(l - target) > 1e-9), target]
    .filter((rr) => rr > legal);

  const panels = maps.map((m, p) => {
    const c = g.cell(p);
    const dF = (F[nF - 1] - F[0]) / (nF - 1);
    const dl = Math.log(rho[nR - 1] / rho[0]) / (nR - 1);
    const xIdx = (i) => c.xs(F[0] + i * dF);
    const yIdx = (j) => c.yOf(Math.exp(Math.log(rho[0]) + j * dl));
    const heat = heatImage(nF, nR, (i, j) => VIRIDIS.rgb(m.a[i][j]), xIdx, yIdx);

    // iso total replacement: RR = legal + max(F,1)/(annuity*rho), exact, so no tracing
    const contours = levels
      .map((rr) => {
        const isTarget = rr === target;
        const pts = [];
        for (const f of Fs) {
          const r = Math.max(f, 1) / (annuity * (rr - legal));
          if (r >= rho[0] && r <= rho[nR - 1]) pts.push([c.xs(f), c.yOf(r)]);
        }
        if (pts.length < 2) return "";
        const d = pathFrom(pts);
        // the target is labelled in every panel (it is the level a reader looks for);
        // the others once, since the curves are identical in every panel
        let label = "";
        if (isTarget || p === 0) {
          const [lx, ly] = pts[Math.floor(pts.length * (isTarget ? 0.72 : 0.45))];
          label = `<text x="${lx.toFixed(1)}" y="${(ly - 3).toFixed(1)}" class="chart-contour-label${isTarget ? " chart-contour-label-target" : ""}">${isTarget ? `target ${rr.toFixed(2)}` : `RR=${rr.toFixed(2)}`}</text>`;
        }
        return isTarget
          ? `<path d="${d}" class="chart-contour-halo" /><path d="${d}" class="chart-contour chart-contour-target" />${label}`
          : `<path d="${d}" class="chart-contour" />${label}`;
      })
      .join("");

    const xc = F.map((f) => c.xs(f));
    const yc = rho.map((r) => c.yOf(r));
    const occ = occupancyContours(m.visits, nF, nR, xc, yc, "chart-occ");

    const par = F[0] <= 1 && F[nF - 1] >= 1
      ? `<line x1="${c.xs(1).toFixed(1)}" y1="${c.y0}" x2="${c.xs(1).toFixed(1)}" y2="${c.y0 + g.plotH}" class="chart-par" />`
      : "";

    return `${c.frame(`${heat}${contours}${occ}${par}`)}
      <text x="${c.x0 + g.plotW / 2}" y="${c.y0 - 7}" class="chart-title" text-anchor="middle">year t = ${m.year}   (${Math.round(m.present).toLocaleString()} present)</text>`;
  });

  const midY = 24 + (g.height - 24 - 30) / 2;
  const yLabel = `<text transform="translate(11 ${midY}) rotate(-90)" class="chart-axis-label" text-anchor="middle">ρ = S / L   (log)</text>`;
  const bar = colourBar({
    x: PANEL_W - 60 + 14, y: 24, w: 10, h: g.height - 24 - 30, ramp: VIRIDIS,
    label: "optimal funding a*", ticks: [[0, "0"], [0.5, "0.5"], [1, "1"]],
  });

  return chartSvg(`${panels.join("")}${yLabel}${bar}`,
                  `Optimal funding rule a*(F, rho) in years ${maps.map((m) => m.year).join(", ")}, with iso-replacement contours and where the simulated cohort is`,
                  PANEL_W, g.height);
}

/**
 * benchmark_misfunding.png: for each market design (rows) and year (columns),
 *     Delta = a_design(t) - a*(t, F, rho)
 * on the cells the DESIGN's own simulation visits — what it contributes minus what
 * the optimum would contribute there. A calendar design's policy is flat over
 * (F, rho), so plotting it would colour a flat sheet; Delta is the informative
 * quantity. Blank = never visited. a* is read off-policy on those cells.
 *
 * @param mis   the API's `misfunding`: { F, rho, designs: [{ name, panels: [{ year,
 *              cells: [i, j, count, Delta], mean_delta }] }] }
 */
function misfundingPanels(mis) {
  const { F, rho, designs } = mis;
  const nF = F.length;
  const nR = rho.length;
  const ncol = designs[0].panels.length;

  // Careers occupy a thin ribbon of the grid, so the full extent would leave every
  // panel mostly blank and hide the variation of Delta ACROSS F. Crop to the cells
  // shown, with a margin, as the thesis figure does.
  let iLo = Infinity, iHi = -Infinity, jLo = Infinity, jHi = -Infinity, lim = 0;
  for (const d of designs) {
    for (const p of d.panels) {
      for (const [i, j, , D] of p.cells) {
        iLo = Math.min(iLo, i); iHi = Math.max(iHi, i);
        jLo = Math.min(jLo, j); jHi = Math.max(jHi, j);
        lim = Math.max(lim, Math.abs(D));
      }
    }
  }
  if (!Number.isFinite(iLo)) return "";
  lim = lim || 1;
  const xpad = 0.05 * (F[iHi] - F[iLo] || 1);
  const xDom = [Math.max(F[0], F[iLo] - xpad), Math.min(F[nF - 1], F[iHi] + xpad)];
  const yDom = [Math.max(rho[0], rho[jLo] / 1.6), Math.min(rho[nR - 1], rho[jHi] * 1.6)];

  const g = panelGrid({
    n: designs.length * ncol, ncol, left: 60, top: 24, bottom: 30, gap: 10, rowGap: 46,
    bar: 76, plotH: 165, xDom, yDom, idPrefix: "mf-clip",
  });

  const dF = (F[nF - 1] - F[0]) / (nF - 1);
  const dl = Math.log(rho[nR - 1] / rho[0]) / (nR - 1);
  const panels = [];
  designs.forEach((d, r) => {
    d.panels.forEach((pn, k) => {
      const c = g.cell(r * ncol + k);
      const Dgrid = new Map(pn.cells.map(([i, j, , D]) => [i * nR + j, D]));
      const heat = heatImage(nF, nR, (i, j) => {
        const D = Dgrid.get(i * nR + j);
        return D === undefined ? null : RDBU.rgb(0.5 + D / (2 * lim));
      }, (i) => c.xs(F[0] + i * dF), (j) => c.yOf(Math.exp(Math.log(rho[0]) + j * dl)));
      const xc = F.map((f) => c.xs(f));
      const yc = rho.map((v) => c.yOf(v));
      const occ = occupancyContours(pn.cells, nF, nR, xc, yc, "chart-occ-dark");
      const par = xDom[0] <= 1 && xDom[1] >= 1
        ? `<line x1="${c.xs(1).toFixed(1)}" y1="${c.y0}" x2="${c.xs(1).toFixed(1)}" y2="${c.y0 + g.plotH}" class="chart-par-muted" />`
        : "";
      const md = pn.mean_delta === null ? "—" : `${pn.mean_delta >= 0 ? "+" : "−"}${Math.abs(pn.mean_delta).toFixed(2)}`;
      panels.push(`${c.frame(`${par}${heat}${occ}`)}
        <text x="${c.x0 + g.plotW / 2}" y="${c.y0 - 7}" class="chart-title" text-anchor="middle">t = ${pn.year}   mean Δ ${md}</text>`);
    });
    // row label: the design, over the shared rho axis name
    const yMid = 24 + r * (g.plotH + 46) + g.plotH / 2;
    panels.push(`<text transform="translate(12 ${yMid}) rotate(-90)" class="chart-row-label" text-anchor="middle">${d.name}</text>
      <text transform="translate(24 ${yMid}) rotate(-90)" class="chart-axis-label" text-anchor="middle">ρ = S / L (log)</text>`);
  });

  const barH = g.height - 24 - 30;
  const bar = colourBar({
    x: PANEL_W - 76 + 12, y: 24, w: 10, h: barH, ramp: RDBU,
    label: "Δ = a_design − a*", ticks: [[0, `−${lim.toFixed(2)}`], [0.5, "0"], [1, `+${lim.toFixed(2)}`]],
  });
  return chartSvg(`${panels.join("")}${bar}`,
                  "Where each market design departs from the optimum, on the states it actually visits",
                  PANEL_W, g.height);
}
