// Play Ground tool for the Rung-2 DP oracle. Charts use the shared SVG helpers in
// js/charts.js; the (F, rho) panel figures are in js/panels.js. Every figure here
// mirrors one in the thesis repo's tests/dynpro suites, named at each function.

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

// --- small shared pieces ------------------------------------------------------

/** A point marker. Shapes carry the series as well as the colour does, as in the
 *  thesis figures, so the charts survive greyscale and colour-blind reading. */
function marker(shape, x, y, cls, r = 3.4) {
  const X = x.toFixed(1);
  const Y = y.toFixed(1);
  if (shape === "square") {
    return `<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}" class="chart-mk ${cls}" />`;
  }
  if (shape === "diamond") {
    const k = r * 1.3;
    return `<path d="M${X},${(y - k).toFixed(1)} L${(x + k).toFixed(1)},${Y} L${X},${(y + k).toFixed(1)} L${(x - k).toFixed(1)},${Y} Z" class="chart-mk ${cls}" />`;
  }
  return `<circle cx="${X}" cy="${Y}" r="${r}" class="chart-mk ${cls}" />`;
}

const DESIGN_CLS = ["c-d0", "c-d1"];
const DESIGN_SHAPE = ["square", "diamond"];

const swatch = (cls, label) =>
  `<span class="legend-item"><i class="legend-swatch swatch-c ${cls}"></i>${label}</span>`;

/** A vertical reference line across the plot, with a label above it. */
function vRule(x, geom, cls, label) {
  return `<line x1="${x.toFixed(1)}" y1="${geom.m.top}" x2="${x.toFixed(1)}" y2="${geom.m.top + geom.plotH}" class="${cls}" />
    <text x="${x.toFixed(1)}" y="${geom.m.top - 4}" class="chart-tick" text-anchor="middle">${label}</text>`;
}

function hRule(y, geom, cls, label) {
  return `<line x1="${geom.m.left}" y1="${y.toFixed(1)}" x2="${geom.m.left + geom.plotW}" y2="${y.toFixed(1)}" class="${cls}" />
    <text x="${geom.m.left + geom.plotW - 3}" y="${(y - 3).toFixed(1)}" class="chart-tick" text-anchor="end">${label}</text>`;
}

/** Tick labels for a log10 axis from a list of candidate values. */
function logAxisLabels(dom, candidates, fmtv = (c) => `${c}`) {
  return candidates
    .filter((c) => Math.log10(c) >= dom[0] && Math.log10(c) <= dom[1])
    .map((c) => ({ v: Math.log10(c), label: fmtv(c) }));
}

// --- the lambda dial (from /dynpro/sweep) -------------------------------------

/** lambda_dial_suite.lambda_threshold: grid-mean and path-weighted a* against the
 *  employee weight, on the unconstrained action grid. The two differ because only
 *  a thin ribbon of the grid is ever visited. */
function thresholdChart(th, lamUser) {
  const lam = th.lambda;
  const hi = Math.max(...th.grid_mean, ...th.path);
  const { xs, ys, geom, svgHead } = chartFrame({
    ...LINE_GEOM,
    title: "Optimal funding rises smoothly in λ, then saturates",
    xDomain: padDomain(lam[0], lam[lam.length - 1], 0.04),
    yDomain: [0, hi * 1.08],
    xTickFormat: (v) => v.toFixed(2),
    yTickLabels: niceTicks(0, hi, 5).map((v) => ({ v, label: v.toFixed(2) })),
    xLabel: "employee weight λ",
    yLabel: "optimal funding a*",
  });
  const series = (vals, cls, shape) =>
    `<path d="${pathFrom(vals.map((v, k) => [xs(lam[k]), ys(v)]))}" class="chart-series ${cls}" />` +
    vals.map((v, k) => marker(shape, xs(lam[k]), ys(v), cls, 2.6)).join("");
  const you = lamUser >= lam[0] && lamUser <= lam[lam.length - 1]
    ? vRule(xs(lamUser), geom, "chart-refline", `your λ = ${lamUser.toFixed(2)}`)
    : "";
  return chartSvg(`${svgHead}${you}${series(th.grid_mean, "c-grid", "circle")}${series(th.path, "c-path", "square")}`,
                  "Grid-mean and path-weighted optimal funding against the employee weight",
                  LINE_GEOM.width, LINE_GEOM.height);
}

/** benchmark_suite.frontier: the lambda-frontier, with the page's market designs on
 *  it (left), and the adequacy each design gives up at its own budget (right). The
 *  ring is the optimum at the lambda set in the form. */
function frontierCharts(sw, opt) {
  const fr = sw.frontier;
  const n = fr.cost.length;
  const costs = [...fr.cost, ...sw.designs.map((d) => d.cost), opt.cost.value].filter((v) => v > 0);
  const xDomain = [Math.log10(Math.min(...costs)) - 0.06, Math.log10(Math.max(...costs)) + 0.06];
  const xTickLabels = logAxisLabels(xDomain, [0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1]);
  const lx = (c) => Math.log10(c);

  const frame = (title, yVals, yLabel, xLabel, fmtY) => {
    const lo = Math.min(...yVals);
    const hi = Math.max(...yVals);
    return chartFrame({
      ...LINE_GEOM,
      title, xDomain, xTickLabels,
      yDomain: padDomain(lo, hi, 0.08),
      yTickLabels: niceTicks(lo, hi, 5).map((v) => ({ v, label: fmtY(v) })),
      xLabel, yLabel,
    });
  };
  const line = (xs, ys, yKey) =>
    `<path d="${pathFrom(fr.cost.map((c, k) => [xs(lx(c)), ys(fr[yKey][k])]))}" class="chart-series c-front" />` +
    fr.cost.map((c, k) => marker("circle", xs(lx(c)), ys(fr[yKey][k]), "c-front", 2.6)).join("");
  const designMarks = (xs, ys, yKey) =>
    sw.designs.map((d, i) => marker(DESIGN_SHAPE[i], xs(lx(d.cost)), ys(d[yKey]), DESIGN_CLS[i], 4.2)).join("");
  const ring = (xs, ys, y) =>
    `<circle cx="${xs(lx(opt.cost.value)).toFixed(1)}" cy="${ys(y).toFixed(1)}" r="6" class="chart-ring" />`;

  // left: employee value against employer cost
  const L = frame("Market designs against the optimised frontier",
                  [...fr.benefit, ...sw.designs.map((d) => d.benefit), opt.benefit.value],
                  "employee value E[u(RR)]  (better ↑)", "employer cost per unit final salary (log; cheaper ←)",
                  (v) => v.toFixed(2));
  // label a few lambdas, skipping any whose point coincides with one already drawn:
  // on the band-censored stretches several lambdas share one point
  const shown = [];
  const lamLabels = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]
    .filter((k) => {
      if (shown.some((j) => Math.abs(fr.cost[k] / fr.cost[j] - 1) < 0.02)) return false;
      shown.push(k);
      return true;
    })
    .map((k) => `<text x="${(L.xs(lx(fr.cost[k])) + 5).toFixed(1)}" y="${(L.ys(fr.benefit[k]) + 11).toFixed(1)}" class="chart-tick chart-tick-accent">λ = ${fr.lambda[k].toFixed(2)}</text>`)
    .join("");
  const left = chartSvg(`${L.svgHead}${line(L.xs, L.ys, "benefit")}${lamLabels}${designMarks(L.xs, L.ys, "benefit")}${ring(L.xs, L.ys, opt.benefit.value)}`,
                        "Employee value against employer cost: the optimised frontier and the market designs",
                        LINE_GEOM.width, LINE_GEOM.height);

  // right: stayer adequacy at the same budget, the arrow is the gap
  const target = sw.meta.target;
  const legal = sw.meta.legal;
  const R = frame("Adequacy at the same budget (arrow = the gap)",
                  [...fr.sty, ...sw.designs.flatMap((d) => [d.sty, d.dp_sty ?? d.sty]), target, legal],
                  "stayer replacement rate", "employer cost per unit final salary (log)",
                  (v) => v.toFixed(2));
  const arrows = sw.designs.map((d, i) => {
    if (d.dp_sty === null || d.dp_sty === undefined) return "";
    const x = R.xs(lx(d.cost));
    const y0 = R.ys(d.sty);
    const y1 = R.ys(d.dp_sty);
    const dir = y1 < y0 ? 1 : -1;               // +1: arrow points up the page
    const head = `M${x.toFixed(1)},${y1.toFixed(1)} L${(x - 3).toFixed(1)},${(y1 + 6 * dir).toFixed(1)} L${(x + 3).toFixed(1)},${(y1 + 6 * dir).toFixed(1)} Z`;
    return `<line x1="${x.toFixed(1)}" y1="${(y0 - 5 * dir).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y1 + 5 * dir).toFixed(1)}" class="chart-arrow ${DESIGN_CLS[i]}" />
            <path d="${head}" class="chart-mk ${DESIGN_CLS[i]}" />`;
  }).join("");
  const right = chartSvg(`${R.svgHead}${hRule(R.ys(target), R.geom, "chart-refline", `target ${target.toFixed(2)}`)}${hRule(R.ys(legal), R.geom, "chart-zeroline", `legal ${legal.toFixed(2)}`)}${line(R.xs, R.ys, "sty")}${arrows}${designMarks(R.xs, R.ys, "sty")}${ring(R.xs, R.ys, opt.sty.value)}`,
                         "Stayer replacement rate against employer cost, with the gap each design leaves",
                         LINE_GEOM.width, LINE_GEOM.height);
  return { left, right };
}

// --- the signal readout ----------------------------------------------------------

/** An integer as superscript digits, for 10⁻⁴-style log-axis labels. */
const sup = (n) => String(n).split("").map((ch) => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(ch)]).join("");

const SIGNAL_GEOM = { ...LINE_GEOM, margin: { ...LINE_GEOM.margin, right: 56 } };
const betaColour = (k, n) => VIRIDIS(0.15 + (0.65 * k) / Math.max(1, n - 1));

/** contribution_schedule_suite.signal_schedule: the contribution read off the same
 *  value function at each temperature beta (left), and what that legibility costs
 *  in joint value against how much smoother it makes the schedule (right). */
function signalCharts(sig) {
  const soft = sig.soft;
  const T = sig.hard.c_by.length;
  const hi = Math.max(...sig.hard.c_by, ...soft.flatMap((s) => s.c_by));
  const A = chartFrame({
    ...LINE_GEOM,
    title: "Contribution read off the value function as a signal",
    xDomain: [0, T - 1],
    yDomain: [0, hi * 1.05],
    xTickFormat: (v) => `${Math.round(v)}`,
    yTickLabels: niceTicks(0, hi, 5).map((v) => ({ v, label: v.toFixed(0) })),
    xLabel: "career year t",
    yLabel: "contribution (% of salary)",
  });
  const sched = (c_by) => pathFrom(c_by.map((v, t) => [A.xs(t), A.ys(v)]));
  const leftSvg = `${A.svgHead}<path d="${sched(sig.hard.c_by)}" class="chart-series chart-series-bold c-hard" />` +
    soft.map((s, k) => `<path d="${sched(s.c_by)}" class="chart-series" style="stroke:${betaColour(k, soft.length)}" />`).join("");
  const left = chartSvg(leftSvg, "Contribution schedule read off the value function at each temperature",
                        LINE_GEOM.width, LINE_GEOM.height);

  const betas = soft.map((s) => s.beta);
  const gaps = soft.map((s) => s.gap);
  const roughs = soft.map((s) => s.rough);
  const xDomain = [Math.log10(betas[0]) - 0.25, Math.log10(betas[betas.length - 1]) + 0.25];
  const gLo = Math.min(0, ...gaps);
  const gHi = Math.max(...gaps);
  const B = chartFrame({
    ...SIGNAL_GEOM,
    title: "Price of legibility: a smoother schedule costs joint value",
    xDomain,
    xTickLabels: logAxisLabels(xDomain, [1e-4, 1e-3, 1e-2, 1e-1, 1],
                               (c) => `10${sup(Math.round(Math.log10(c)))}`),
    yDomain: padDomain(gLo, gHi, 0.08),
    yTickLabels: niceTicks(gLo, gHi, 5).map((v) => ({ v, label: (Math.abs(v) < 0.05 ? 0 : v).toFixed(1) })),
    xLabel: "readout temperature β (fraction of local Q-range, log)",
    yLabel: "value gap vs argmax (% of joint)",
  });
  // right-hand axis for roughness, as the thesis's twinx
  const rAll = [...roughs, sig.hard.rough];
  const rDom = padDomain(Math.min(...rAll), Math.max(...rAll), 0.08);
  const yr = makeScale(rDom, [B.geom.m.top + B.geom.plotH, B.geom.m.top]);
  const xr = B.geom.m.left + B.geom.plotW;
  const rAxis = niceTicks(Math.min(...rAll), Math.max(...rAll), 5)
    .map((v) => `<line x1="${xr}" y1="${yr(v).toFixed(1)}" x2="${xr + 3}" y2="${yr(v).toFixed(1)}" class="chart-axis" />
                 <text x="${xr + 5}" y="${yr(v).toFixed(1)}" class="chart-tick chart-tick-y" text-anchor="start">${v.toFixed(2)}</text>`)
    .join("") +
    `<line x1="${xr}" y1="${B.geom.m.top}" x2="${xr}" y2="${B.geom.m.top + B.geom.plotH}" class="chart-axis" />
     <text transform="translate(${SIGNAL_GEOM.width - 6} ${B.geom.m.top + B.geom.plotH / 2}) rotate(-90)" class="chart-axis-label" text-anchor="middle">roughness (mean sq. yr-on-yr change)</text>`;
  const bx = (b) => B.xs(Math.log10(b));
  const gapLine = `<path d="${pathFrom(betas.map((b, k) => [bx(b), B.ys(gaps[k])]))}" class="chart-series c-hard" />` +
    betas.map((b, k) => marker("circle", bx(b), B.ys(gaps[k]), "c-hard", 3)).join("");
  const roughLine = `<path d="${pathFrom(betas.map((b, k) => [bx(b), yr(roughs[k])]))}" class="chart-series c-path" />` +
    betas.map((b, k) => marker("square", bx(b), yr(roughs[k]), "c-path", 3)).join("");
  const hardRough = `<line x1="${B.geom.m.left}" y1="${yr(sig.hard.rough).toFixed(1)}" x2="${xr}" y2="${yr(sig.hard.rough).toFixed(1)}" class="chart-series chart-series-dotted c-path" />`;
  const you = sig.beta > 0 && Math.log10(sig.beta) >= xDomain[0] && Math.log10(sig.beta) <= xDomain[1]
    ? vRule(bx(sig.beta), B.geom, "chart-refline", `your β = ${sig.beta}`)
    : "";
  const right = chartSvg(`${B.svgHead}${rAxis}${you}${hardRough}${gapLine}${roughLine}`,
                         "Value gap and schedule roughness against the readout temperature",
                         SIGNAL_GEOM.width, SIGNAL_GEOM.height);

  const legend = swatch("c-hard", `argmax (hard, avg ${sig.hard.avg.toFixed(1)}%)`) +
    soft.map((s, k) => `<span class="legend-item"><i class="legend-swatch" style="background:${betaColour(k, soft.length)}"></i>β=${s.beta} (avg ${s.avg.toFixed(1)}%)</span>`).join("");
  return { left, right, legend };
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
  // five columns of value + range do not fit a phone; scroll the table, not the page
  return `<div class="table-scroll"><table class="metrics-table result-table">
      <caption>Value shown with the [min–max] range across seeds.</caption>
      <thead><tr><th scope="col">Plan</th><th scope="col">Avg contribution %</th>
        <th scope="col">Employer cost</th><th scope="col">Stayer RR</th>
        <th scope="col">Leaver RR</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
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
  const sig = signalCharts(d.signal);
  const mis = d.misfunding.designs
    .map((m) => `${m.name} over-funds ${Math.round(100 * m.over_share)}% of the path-years it reaches (mean Δ ${m.mean_delta >= 0 ? "+" : "−"}${Math.abs(m.mean_delta).toFixed(2)})`)
    .join("; ");

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

    <h3 class="chart-section">What the λ dial buys
      <span class="chart-subnote">the optimum re-solved across the employee weight λ, every other assumption as set above</span></h3>
    <div id="dynpro-sweep"><p class="playground-placeholder">Sweeping λ… 32 more solves, about ten seconds.</p></div>

    <h3 class="chart-section">Optimal funding rule, and where careers actually are
      <span class="chart-subnote">a*(F, ρ) in colour; white: iso total replacement, <span class="subnote-target">gold: the ${fmt(d.adequacy.target, 2)} target</span>; magenta: the simulated cohort that year (50/90/99th pct of occupancy); dotted: F = 1</span></h3>
    <div class="chart-scroll">
      <figure class="chart-figure-full">${policyPanels({
        F: d.policy_maps.F, rho: d.policy_maps.rho, maps: d.policy_maps.maps,
        legal: d.adequacy.legal, target: d.adequacy.target, annuity: d.meta.annuity,
      })}</figure>
    </div>

    <h3 class="chart-section">Where each market design departs from the optimum
      <span class="chart-subnote">Δ = a_design − a* on the states the design's own careers visit: red over-funds, blue under-funds; contours: 50/90/99th pct of that year's occupancy; blank: never visited</span></h3>
    <div class="chart-scroll">
      <figure class="chart-figure-full">${misfundingPanels(d.misfunding)}
        <figcaption class="chart-caption">${mis}. a* is read off-policy on these cells: the design steers careers to states the optimum's own simulation may rarely reach.</figcaption></figure>
    </div>

    <h3 class="chart-section">The contribution as a signal
      <span class="chart-subnote">the same V read out at temperature β; β = 0 is the hard argmax, and your β = ${d.signal.beta} is the readout used everywhere above</span></h3>
    <div class="chart-row">
      <figure class="chart-figure">${sig.left}
        <figcaption class="chart-legend chart-legend-wrap">${sig.legend}</figcaption></figure>
      <figure class="chart-figure">${sig.right}
        <figcaption class="chart-legend">
          ${swatch("c-hard", "value gap vs argmax (%)")}
          ${swatch("c-path", "schedule roughness")}
          <span class="legend-item"><i class="legend-swatch swatch-dotted c-path"></i>argmax roughness</span>
        </figcaption></figure>
    </div>
    ${renderNotes(d)}
  `;
}

function renderSweep(sw, d) {
  const box = document.getElementById("dynpro-sweep");
  if (!box) return;
  const fr = frontierCharts(sw, d.table[0]);
  const designs = sw.designs.map((x, i) =>
    `<span class="legend-item"><svg class="legend-mk" viewBox="-6 -6 12 12">${marker(DESIGN_SHAPE[i], 0, 0, DESIGN_CLS[i], 4)}</svg>${x.name}</span>`).join("");
  const gaps = sw.designs
    .filter((x) => x.dp_sty !== null)
    .map((x) => `${x.name} reaches ${fmt(x.sty, 2)}; the optimum reaches ${fmt(x.dp_sty, 2)} on the same budget`)
    .join(". ");
  box.innerHTML = `
    <div class="chart-row">
      <figure class="chart-figure">${fr.left}</figure>
      <figure class="chart-figure">${fr.right}</figure>
    </div>
    <p class="chart-legend chart-legend-wrap">
      ${swatch("c-front", "optimised frontier (swept λ)")}${designs}
      <span class="legend-item"><i class="legend-ring"></i>your λ = ${d.meta.lambda.toFixed(2)}</span>
    </p>
    <p class="chart-caption">${gaps ? `${gaps}.` : ""} The frontier is censored by the contribution band at both ends, so its points sit between λ = 0.15 and 0.60.</p>
    <div class="chart-row">
      <figure class="chart-figure">${thresholdChart(sw.threshold, d.meta.lambda)}
        <figcaption class="chart-legend">
          ${swatch("c-grid", "grid-mean a*")}${swatch("c-path", "path-weighted a*")}
        </figcaption></figure>
      <figure class="chart-figure chart-figure-text">
        <p>The <strong>grid-mean</strong> averages the rule over every state of the grid; the <strong>path-weighted</strong> mean averages what the simulated careers actually pay, per career-year, counting zero once a member has left. They differ because careers reach only a thin ribbon of the grid — the magenta contours below — and because most members leave before retirement.</p>
        <p>Funding rises smoothly with λ and saturates once the optimum is pinned at the top of the action grid; there is no kink. This sweep is unconstrained (no band), as in the thesis, since the band would censor the very rise it shows.</p>
        <p class="chart-subnote">${sw.threshold.lambda.length + sw.frontier.lambda.length} solves on a ${sw.meta.grid.nF}×${sw.meta.grid.nR} grid in ${sw.meta.seconds}s across ${sw.meta.threads} threads.</p>
      </figure>
    </div>`;
}

async function postJSON(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Accepted ranges. The inputs carry min/max (mirrored server-side in DYNPRO_BOUNDS,
// which clamps whatever arrives); here they are shown beside each label, and the
// two constraints that span fields are checked before a run.
for (const el of form.querySelectorAll("input[type=number][min][max]")) {
  const hint = document.createElement("span");
  hint.className = "field-range";
  hint.textContent = `${el.min} – ${el.max}`;
  el.before(hint);
}

function crossCheck() {
  const f = form.elements;
  const pairs = [
    [f.RR_TARGET, +f.RR_TARGET.value > +f.RR_LEGAL.value,
     "The total target must be above the 1st-pillar replacement."],
    [f.band_hi, +f.band_hi.value > +f.band_lo.value,
     "The band maximum must be above its minimum."],
  ];
  for (const [el, ok, msg] of pairs) el.setCustomValidity(ok ? "" : msg);
}
form.addEventListener("input", crossCheck);
crossCheck();

// A second click while a run is in flight must not let the older run's slower
// sweep land on the newer run's page.
let runId = 0;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const run = ++runId;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  results.innerHTML = `<p class="playground-placeholder">Solving… the DP takes a few seconds.</p>`;

  const payload = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    payload[el.name] = el.type === "checkbox" ? el.checked : Number(el.value);
  }

  // The sweep is requested only once the main result is in. Sent together, they
  // share the server's cores and the main result (the one being waited on) took
  // ~7s instead of ~4s; in sequence it lands first and the lambda section follows.
  try {
    const d = await postJSON("/dynpro/evaluate", payload);
    if (run !== runId) return;
    render(d);
    postJSON("/dynpro/sweep", payload)
      .then((sw) => { if (run === runId) renderSweep(sw, d); })
      .catch((err) => {
        const box = document.getElementById("dynpro-sweep");
        if (run === runId && box) box.innerHTML = `<p class="playground-error">The λ sweep failed: ${err.message}</p>`;
      });
  } catch (err) {
    if (run === runId) results.innerHTML = `<p class="playground-error">Couldn't reach the model backend: ${err.message}</p>`;
  } finally {
    if (run === runId) button.disabled = false;
  }
});
