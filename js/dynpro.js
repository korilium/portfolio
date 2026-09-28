// Play Ground tool for the Rung-2 DP oracle. Charts use the shared SVG helpers in
// js/charts.js; the heatmap below is the one piece those don't cover, since they
// are line-only.

const form = document.getElementById("dynpro-form");
const results = document.getElementById("dynpro-results");

// Reuse the line and swatch classes stylePlayground.css already defines for the
// other tool; only "muted" is new.
const SERIES = ["chart-line-ink", "chart-line-accent", "chart-line-muted"];
const SWATCH = ["swatch-ink", "swatch-accent", "swatch-muted"];

function fmt(x, digits = 3) {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "—";
}

/** value with its across-seed range — every simulated number carries one. */
function fmtRange(m, digits = 3) {
  if (!m || m.value === null) return "—";
  return `${fmt(m.value, digits)} <span class="range">[${fmt(m.lo, digits)}–${fmt(m.hi, digits)}]</span>`;
}

// --- charts ------------------------------------------------------------------
// These mirror the thesis's matplotlib figures, including the axis names: an
// (F, rho) plane with unlabelled ticks is unreadable without the paper open.

// Room for a rotated y-label on the left and a colour bar on the right.
const LINE_GEOM = { width: 420, height: 300, margin: { top: 26, right: 18, bottom: 46, left: 62 } };
const MAP_GEOM = { width: 420, height: 300, margin: { top: 26, right: 84, bottom: 46, left: 62 } };

const AX_F = "F = R / L   (funding ratio)";
const AX_RHO = "ρ = S / L   (log)";

function scheduleChart(years, schedules) {
  const all = schedules.flatMap((s) => s.c_by);
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all);
  const { xs, ys, svgHead } = chartFrame({
    ...LINE_GEOM,
    title: "Optimal funding vs market plans",
    xDomain: [0, years.length - 1],
    yDomain: padDomain(lo, hi),
    xTickFormat: (v) => `${Math.round(v)}`,
    yTickLabels: niceTicks(lo, hi, 5).map((v) => ({ v, label: v.toFixed(0) })),
    xLabel: "career year t",
    yLabel: "contribution (% of salary)",
  });
  const lines = schedules
    .map((s, i) => `<path d="${pathFrom(s.c_by.map((v, t) => [xs(t), ys(v)]))}" class="chart-line ${SERIES[i % SERIES.length]}" />`)
    .join("");
  return chartSvg(`${svgHead}${lines}`, "Contribution schedule by career year",
                  LINE_GEOM.width, LINE_GEOM.height);
}

function adequacyChart(ad) {
  const { edges, stayers, leavers, target, legal } = ad;
  const maxN = Math.max(1, ...stayers, ...leavers);
  const { xs, ys, geom, svgHead } = chartFrame({
    ...LINE_GEOM,
    title: "Replacement rate at retirement",
    xDomain: [edges[0], edges[edges.length - 1]],
    yDomain: [0, maxN],
    xTickFormat: (v) => v.toFixed(2),
    yTickLabels: niceTicks(0, maxN, 4).map((v) => ({ v, label: `${Math.round(v)}` })),
    xLabel: "total annual replacement (1st + 2nd pillar)",
    yLabel: "careers",
  });
  const bars = (counts, cls) =>
    counts
      .map((n, i) => {
        if (n <= 0) return "";
        const x0 = xs(edges[i]);
        const w = Math.max(1, xs(edges[i + 1]) - x0 - 0.5);
        const y = ys(n);
        return `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(ys(0) - y).toFixed(1)}" class="${cls}" />`;
      })
      .join("");
  const rule = (v, cls, lab) => {
    if (!(v >= edges[0] && v <= edges[edges.length - 1])) return "";
    const x = xs(v).toFixed(1);
    return `<line x1="${x}" y1="${geom.m.top}" x2="${x}" y2="${geom.m.top + geom.plotH}" class="${cls}" />
            <text x="${x}" y="${geom.m.top - 4}" class="chart-tick" text-anchor="middle">${lab}</text>`;
  };
  return chartSvg(
    `${svgHead}${bars(leavers, "chart-bar-alt")}${bars(stayers, "chart-bar")}` +
      `${rule(target, "chart-refline", "target")}${rule(legal, "chart-zeroline", "legal")}`,
    "Distribution of replacement rates for stayers and leavers",
    LINE_GEOM.width, LINE_GEOM.height
  );
}

/** Shared (F, rho) plane: log-rho axis, the F = 1 guide, and a colour bar. */
function planeChart({ title, F, rho, M, ramp, barLabel, barTicks, extra = "" }) {
  const { xs, geom, svgHead } = chartFrame({
    ...MAP_GEOM,
    title,
    xDomain: [F[0], F[F.length - 1]],
    yDomain: [0, 1],
    xTickFormat: (v) => v.toFixed(1),
    yTickLabels: [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const a = Math.log(rho[0]);
      const b = Math.log(rho[rho.length - 1]);
      const val = Math.exp(a + f * (b - a));
      return { v: f, label: val >= 10 ? val.toFixed(0) : val.toFixed(2) };
    }),
    xLabel: AX_F,
    yLabel: AX_RHO,
  });
  const a = Math.log(rho[0]);
  const b = Math.log(rho[rho.length - 1]);
  const yOf = (r) => geom.m.top + geom.plotH - ((Math.log(r) - a) / (b - a || 1)) * geom.plotH;

  let cells = "";
  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < M[i].length; j++) {
      const v = M[i][j];
      if (v === null || v === undefined) continue;
      const col = ramp(v);
      if (col === null) continue;
      const x0 = xs(F[i]);
      const w = Math.max(0.8, xs(F[i + 1]) - x0);
      const y0 = yOf(rho[j + 1]);
      const h = Math.max(0.8, yOf(rho[j]) - y0);
      cells += `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" />`;
    }
  }
  const par = `<line x1="${xs(1).toFixed(1)}" y1="${geom.m.top}" x2="${xs(1).toFixed(1)}" y2="${geom.m.top + geom.plotH}" class="chart-par" />`;
  const bar = colourBar({
    x: geom.m.left + geom.plotW + 12, y: geom.m.top, w: 10, h: geom.plotH,
    ramp: ramp.base || ramp, label: barLabel, ticks: barTicks,
  });
  return { svg: `${cells}${svgHead}${par}${extra(xs, yOf, geom)}${bar}`, xs, yOf, geom };
}

/** Optimal funding rule for one year, with iso-replacement contours.
 *
 *  The contours are exact rather than traced: total replacement is
 *      RR = RR_legal + max(F, 1) / (annuity * rho),
 *  so the RR level curve is just rho = max(F,1) / (annuity * (RR - RR_legal)).
 *
 *  Note these are TOTAL replacement rates. The thesis's policy_map.png contours
 *  max(F,1)/rho and labels it "RR", which is the annuity factor times the second
 *  pillar's rate — a different quantity. */
function policyMap(F, rho, M, year, legal, annuity) {
  const ramp = (v) => VIRIDIS(v);
  ramp.base = VIRIDIS;
  const contours = (xs, yOf, geom) =>
    [0.5, 0.7, 1.0]
      .filter((rr) => rr > legal)
      .map((rr) => {
        const pts = [];
        for (let k = 0; k <= 24; k++) {
          const f = F[0] + (k / 24) * (F[F.length - 1] - F[0]);
          const r = Math.max(f, 1) / (annuity * (rr - legal));
          if (r >= rho[0] && r <= rho[rho.length - 1]) pts.push([xs(f), yOf(r)]);
        }
        if (pts.length < 2) return "";
        const [lx, ly] = pts[Math.floor(pts.length / 2)];
        return `<path d="${pathFrom(pts)}" class="chart-contour" />
                <text x="${lx.toFixed(1)}" y="${(ly - 3).toFixed(1)}" class="chart-contour-label">RR ${rr.toFixed(2)}</text>`;
      })
      .join("");
  const { svg } = planeChart({
    title: `Optimal funding a* — year ${year}`,
    F, rho, M, ramp,
    barLabel: "a*  (share of capacity)",
    barTicks: [[0, "0"], [0.5, "0.5"], [1, "1"]],
    extra: contours,
  });
  return chartSvg(svg, `Optimal funding rule in year ${year}`, MAP_GEOM.width, MAP_GEOM.height);
}

/** Occupancy of the same plane, on a log colour scale as in the thesis figure. */
function visitMap(F, rho, M, year, maxV) {
  const ramp = (v) => (v > 0 ? MAGMA(Math.log1p(v) / Math.log1p(maxV || 1)) : null);
  ramp.base = MAGMA;
  const { svg } = planeChart({
    title: `Careers present — year ${year}`,
    F, rho, M, ramp,
    barLabel: "path-years (log)",
    barTicks: [[0, "1"], [1, `${Math.round(maxV)}`]],
    extra: () => "",
  });
  return chartSvg(svg, `Where careers are in year ${year}`, MAP_GEOM.width, MAP_GEOM.height);
}

/** The simulation drawn ON the state space: pooled occupancy behind, and the
    cohort's median path through (F, rho) over the career on top. Quantiles come
    from the occupancy histogram, so the path is a staircase at node resolution. */
function stateSpaceChart(F, rho, pooled, traj) {
  // The axes are set by the TRAJECTORY, not by where the occupancy mass is. Those
  // differ sharply: the cohort starts at rho ~ 22 for one year then spends 44 years
  // below 2, so cropping to 99% of path-years would cut off the start of the very
  // path being drawn.
  const span = (q) => [
    Math.min(...traj[q].p10.filter(Number.isFinite)),
    Math.max(...traj[q].p90.filter(Number.isFinite)),
  ];
  const [fLo, fHi] = span("F");
  const [rLo, rHi] = span("rho");
  if (!(fHi > fLo) || !(rHi > rLo)) return "";

  let maxV = 0;
  for (const row of pooled) for (const v of row) if (v > maxV) maxV = v;

  const xDomain = padDomain(fLo, fHi, 0.08);
  const loR = Math.log(rLo) - 0.2;
  const hiR = Math.log(rHi) + 0.2;

  const { xs, geom, svgHead } = chartFrame({
    ...MAP_GEOM,
    title: "Where the simulated cohort travels",
    xDomain,
    yDomain: [0, 1],
    xTickFormat: (v) => v.toFixed(2),
    yTickLabels: [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const val = Math.exp(loR + f * (hiR - loR));
      return { v: f, label: val >= 10 ? val.toFixed(0) : val.toFixed(2) };
    }),
    xLabel: AX_F,
    yLabel: AX_RHO,
  });
  const yOf = (r) => geom.m.top + geom.plotH - ((Math.log(r) - loR) / (hiR - loR || 1)) * geom.plotH;

  let cells = "";
  for (let i = 0; i < pooled.length; i++) {
    for (let j = 0; j < pooled[i].length; j++) {
      const v = pooled[i][j];
      if (!v) continue;
      const x0 = xs(F[i]);
      const w = Math.max(0.8, xs(F[i + 1]) - x0);
      const y0 = yOf(rho[j + 1]);
      const h = Math.max(0.8, yOf(rho[j]) - y0);
      cells += `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${MAGMA(Math.log1p(v) / Math.log1p(maxV))}" opacity="0.55" />`;
    }
  }

  const pts = traj.F.p50.map((f, t) => [xs(f), yOf(traj.rho.p50[t])]);
  const path = `<path d="${pathFrom(pts)}" class="chart-line chart-traj" />`;

  const marks = [0, 10, 22, 44]
    .filter((t) => t < pts.length)
    .map((t) => {
      const [cx, cy] = pts[t];
      const xlo = xs(traj.F.p10[t]);
      const xhi = xs(traj.F.p90[t]);
      const ylo = yOf(traj.rho.p10[t]);
      const yhi = yOf(traj.rho.p90[t]);
      return `<line x1="${xlo.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${xhi.toFixed(1)}" y2="${cy.toFixed(1)}" class="chart-whisker" />
              <line x1="${cx.toFixed(1)}" y1="${ylo.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yhi.toFixed(1)}" class="chart-whisker" />
              <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.2" class="chart-marker" />
              <text x="${(cx + 6).toFixed(1)}" y="${(cy - 5).toFixed(1)}" class="chart-tick">t = ${t}</text>`;
    })
    .join("");

  const par =
    xDomain[0] <= 1 && xDomain[1] >= 1
      ? `<line x1="${xs(1).toFixed(1)}" y1="${geom.m.top}" x2="${xs(1).toFixed(1)}" y2="${geom.m.top + geom.plotH}" class="chart-par" />
         <text x="${(xs(1) + 3).toFixed(1)}" y="${(geom.m.top + 9).toFixed(1)}" class="chart-tick">F = 1</text>`
      : "";

  const bar = colourBar({
    x: geom.m.left + geom.plotW + 12, y: geom.m.top, w: 10, h: geom.plotH,
    ramp: MAGMA, label: "path-years (log)",
    ticks: [[0, "1"], [1, `${Math.round(maxV)}`]],
  });

  return chartSvg(`${cells}${svgHead}${par}${path}${marks}${bar}`,
                  "Median path of the simulated cohort through the funding and salary ratios",
                  MAP_GEOM.width, MAP_GEOM.height);
}

// --- render ------------------------------------------------------------------

function renderTable(rows) {
  const body = rows
    .map(
      (r) => `<tr>
        <th scope="row">${r.name}</th>
        <td>${fmtRange(r.avg, 1)}</td>
        <td>${fmtRange(r.cost)}</td>
        <td>${fmtRange(r.sty)}</td>
        <td>${fmtRange(r.lea)}</td>
      </tr>`
    )
    .join("");
  return `<table class="metrics-table result-table">
      <caption>Value shown with the [min–max] range across seeds.</caption>
      <thead><tr><th scope="col">Plan</th><th scope="col">Avg contribution %</th>
        <th scope="col">Employer cost</th><th scope="col">Stayer RR</th>
        <th scope="col">Leaver RR</th></tr></thead>
      <tbody>${body}</tbody></table>`;
}

/** Notes that keep the output honest — each answers something a reader would
    otherwise read as a bug. */
function renderNotes(d) {
  const notes = [];
  const m = d.meta;
  const T = d.years.length;
  if (m.years_at_cap > 0 || m.years_at_floor > 0) {
    notes.push(
      `The optimal schedule sits at the band <strong>ceiling</strong> in ${m.years_at_cap} of ${T} years and at the <strong>floor</strong> in ${m.years_at_floor}. Where it is pinned, the band is setting the contribution, not the trade-off — so λ and the other dials will barely move it.`
    );
  }
  const opt = d.table[0];
  if (opt.sty.value !== null && opt.sty.value > d.adequacy.target + 0.02) {
    notes.push(
      `Stayers land at ${fmt(opt.sty.value, 2)} against a ${fmt(d.adequacy.target, 2)} target. That overshoot is the objective, not a defect: nothing stops rewarding replacement above the target unless you tick <em>Stop rewarding above the target</em>.`
    );
  }
  notes.push(
    `Solved on a ${m.grid.nF}×${m.grid.nR} grid in ${m.solve_seconds}s, then simulated over ${m.n_seeds} seeds × ${m.n_paths.toLocaleString()} careers. Aggregate figures are stable at this resolution; the schedule shape and the policy maps are the parts that move most with it.`
  );
  return `<ul class="tool-notes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>`;
}

function render(d) {
  const legend = d.schedules
    .map((s, i) => `<span class="legend-item"><i class="legend-swatch ${SWATCH[i % SWATCH.length]}"></i>${s.name}</span>`)
    .join("");

  const maxVisit = Math.max(
    1,
    ...d.policy_maps.maps.flatMap((m) => m.visits.flatMap((row) => row))
  );

  results.innerHTML = `
    <div class="chart-row">
      <figure class="chart-figure">${scheduleChart(d.years, d.schedules)}
        <figcaption class="chart-legend">${legend}</figcaption></figure>
      <figure class="chart-figure">${adequacyChart(d.adequacy)}
        <figcaption class="chart-legend">
          <span class="legend-item"><i class="legend-swatch swatch-bar"></i>stayers</span>
          <span class="legend-item"><i class="legend-swatch swatch-bar-alt"></i>leavers</span>
          <span class="legend-item"><i class="legend-swatch swatch-target"></i>target</span>
        </figcaption></figure>
    </div>
    ${renderTable(d.table)}
    <h3 class="chart-section">The simulation on the state space
      <span class="chart-subnote">median path through (F, ρ); crosses are the 10th–90th percentile spread; shading is total occupancy</span></h3>
    <div class="chart-row">
      <figure class="chart-figure chart-figure-wide">
        ${stateSpaceChart(d.policy_maps.F, d.policy_maps.rho, d.policy_maps.pooled_visits, d.trajectory)}
        <figcaption class="chart-caption">Contributions enter the reserve and the guarantee equally, so they carry F = 1 and pull the plan towards par: F stays near 1 while ρ = S/L falls as the liability builds against salary.</figcaption>
      </figure>
    </div>
    <h3 class="chart-section">Optimal funding rule <span class="chart-subnote">a*(F, ρ) — dotted line is full funding, F = 1</span></h3>
    <div class="chart-row">
      ${d.policy_maps.maps
        .map((m) => `<figure class="chart-figure">${policyMap(d.policy_maps.F, d.policy_maps.rho, m.a, m.year, d.adequacy.legal, d.meta.annuity)}</figure>`)
        .join("")}
    </div>
    <h3 class="chart-section">Where careers actually go <span class="chart-subnote">occupancy of the same state space</span></h3>
    <div class="chart-row">
      ${d.policy_maps.maps
        .map((m) => `<figure class="chart-figure">${visitMap(d.policy_maps.F, d.policy_maps.rho, m.visits, m.year, maxVisit)}</figure>`)
        .join("")}
    </div>
    ${renderNotes(d)}
  `;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  results.innerHTML = `<p class="playground-placeholder">Solving… the DP takes a couple of seconds.</p>`;

  const payload = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    payload[el.name] = el.type === "checkbox" ? el.checked : Number(el.value);
  }

  try {
    const response = await fetch(`${API_BASE}/dynpro/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (err) {
    results.innerHTML = `<p class="playground-error">Couldn't reach the model backend: ${err.message}</p>`;
  } finally {
    button.disabled = false;
  }
});
