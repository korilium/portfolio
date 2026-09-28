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

function scheduleChart(years, schedules) {
  const all = schedules.flatMap((s) => s.c_by);
  const { xs, ys, svgHead } = chartFrame({
    title: "Contribution by career year (% of salary)",
    xDomain: [0, years.length - 1],
    yDomain: padDomain(Math.min(0, ...all), Math.max(...all)),
    xTickFormat: (v) => `${Math.round(v)}`,
    yTickLabels: niceTicks(Math.min(0, ...all), Math.max(...all), 4).map((v) => ({
      v,
      label: v.toFixed(0),
    })),
  });
  const lines = schedules
    .map((s, i) => `<path d="${pathFrom(s.c_by.map((v, t) => [xs(t), ys(v)]))}" class="chart-line ${SERIES[i % SERIES.length]}" />`)
    .join("");
  return chartSvg(`${svgHead}${lines}`, "Contribution schedule by career year");
}

function adequacyChart(ad) {
  const { edges, stayers, leavers, target, legal } = ad;
  const maxN = Math.max(1, ...stayers, ...leavers);
  const { xs, ys, svgHead } = chartFrame({
    title: "Replacement rate at retirement",
    xDomain: [edges[0], edges[edges.length - 1]],
    yDomain: [0, maxN],
    xTickFormat: (v) => v.toFixed(2),
    yTickLabels: niceTicks(0, maxN, 4).map((v) => ({ v, label: `${Math.round(v)}` })),
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
  const rule = (v, cls) =>
    v >= edges[0] && v <= edges[edges.length - 1]
      ? `<line x1="${xs(v).toFixed(1)}" y1="${MARGIN.top}" x2="${xs(v).toFixed(1)}" y2="${MARGIN.top + PLOT_H}" class="${cls}" />`
      : "";
  return chartSvg(
    `${svgHead}${bars(leavers, "chart-bar-alt")}${bars(stayers, "chart-bar")}${rule(target, "chart-refline")}${rule(legal, "chart-zeroline")}`,
    "Distribution of replacement rates for stayers and leavers"
  );
}

/** Policy heatmap: a*(F, rho) for one year, with rho on a log axis.
    Grid cells are drawn as rects — the shared helpers are line-only. */
function policyHeatmap(F, rho, M, year, colour) {
  const { xs, svgHead } = chartFrame({
    title: `Year ${year}`,
    xDomain: [F[0], F[F.length - 1]],
    yDomain: [0, 1],
    xTickFormat: (v) => v.toFixed(1),
    yTickLabels: [0, 0.5, 1].map((f) => {
      const lo = Math.log(rho[0]);
      const hi = Math.log(rho[rho.length - 1]);
      return { v: f, label: Math.exp(lo + f * (hi - lo)).toFixed(1) };
    }),
  });
  const lo = Math.log(rho[0]);
  const hi = Math.log(rho[rho.length - 1]);
  const yOf = (r) => MARGIN.top + PLOT_H - ((Math.log(r) - lo) / (hi - lo)) * PLOT_H;
  let cells = "";
  for (let i = 0; i < F.length - 1; i++) {
    for (let j = 0; j < rho.length - 1; j++) {
      const v = M[i][j];
      if (v === null || v === undefined) continue;
      const x0 = xs(F[i]);
      const x1 = xs(F[i + 1]);
      const y1 = yOf(rho[j]);
      const y0 = yOf(rho[j + 1]);
      cells += `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${Math.max(0.6, x1 - x0).toFixed(1)}" height="${Math.max(0.6, y1 - y0).toFixed(1)}" fill="${colour(v)}" />`;
    }
  }
  const parLine = `<line x1="${xs(1).toFixed(1)}" y1="${MARGIN.top}" x2="${xs(1).toFixed(1)}" y2="${MARGIN.top + PLOT_H}" class="chart-refline" />`;
  return chartSvg(`${cells}${svgHead}${parLine}`, `Optimal funding rule in year ${year}`);
}

const viridisish = (v) => {
  const t = Math.max(0, Math.min(1, v));
  const r = Math.round(30 + 200 * Math.pow(t, 1.6));
  const g = Math.round(40 + 180 * t);
  const b = Math.round(120 - 80 * t);
  return `rgb(${r},${g},${b})`;
};

const visitColour = (maxV) => (v) => {
  if (v <= 0) return "transparent";
  const t = Math.log1p(v) / Math.log1p(maxV || 1);
  return `rgba(193,18,31,${(0.15 + 0.85 * t).toFixed(3)})`;
};

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
  const vc = visitColour(maxVisit);

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
    <h3 class="chart-section">Optimal funding rule <span class="chart-subnote">a*(F, ρ) — dotted line is full funding, F = 1</span></h3>
    <div class="chart-row">
      ${d.policy_maps.maps
        .map((m) => `<figure class="chart-figure">${policyHeatmap(d.policy_maps.F, d.policy_maps.rho, m.a, m.year, viridisish)}</figure>`)
        .join("")}
    </div>
    <h3 class="chart-section">Where careers actually go <span class="chart-subnote">occupancy of the same state space</span></h3>
    <div class="chart-row">
      ${d.policy_maps.maps
        .map((m) => `<figure class="chart-figure">${policyHeatmap(d.policy_maps.F, d.policy_maps.rho, m.visits, m.year, vc)}</figure>`)
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
