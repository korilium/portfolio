const form = document.getElementById("pension-form");
const planSelect = document.getElementById("plan-type");
const planFieldsets = document.querySelectorAll(".plan-fields");
const results = document.getElementById("playground-results");

function syncPlanFields() {
  const active = planSelect.value;
  planFieldsets.forEach((fs) => {
    fs.hidden = fs.dataset.plan !== active;
  });
}
planSelect.addEventListener("change", syncPlanFields);
syncPlanFields();

function formatNumber(x, digits = 3) {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "—";
}

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

// --- tiny SVG line-chart helpers -------------------------------------------
// No charting library, to stay consistent with the rest of this vanilla-JS
// site — these three charts mirror basicEnv.py's own plot_results() output
// (see toyEnv/tests/*/mc_*.png in the thesis repo) so the playground shows
// the same diagnostics the model's author already validated against.

const CHART_W = 320;
const CHART_H = 200;
const MARGIN = { top: 26, right: 14, bottom: 26, left: 38 };
const PLOT_W = CHART_W - MARGIN.left - MARGIN.right;
const PLOT_H = CHART_H - MARGIN.top - MARGIN.bottom;

function makeScale([d0, d1], [r0, r1]) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

function niceTicks(min, max, count = 4) {
  if (min === max) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + i * step);
}

function padDomain(min, max, frac = 0.1) {
  const span = max - min || 1;
  return [min - span * frac, max + span * frac];
}

function pathFrom(points) {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

/** Frame shared by all three charts: axes, y-ticks, x-ticks, title. */
function chartFrame({ title, xDomain, yDomain, xTickFormat = String, yTickLabels = null }) {
  const xs = makeScale(xDomain, [MARGIN.left, MARGIN.left + PLOT_W]);
  const ys = makeScale(yDomain, [MARGIN.top + PLOT_H, MARGIN.top]);

  const yTicks = yTickLabels
    ? yTickLabels
    : niceTicks(yDomain[0], yDomain[1], 4).map((v) => ({ v, label: v.toFixed(2) }));
  const xTickVals = niceTicks(xDomain[0], xDomain[1], 4);

  const yGrid = yTicks
    .map(
      ({ v, label }) => `
      <line x1="${MARGIN.left}" y1="${ys(v)}" x2="${MARGIN.left + PLOT_W}" y2="${ys(v)}" class="chart-gridline" />
      <text x="${MARGIN.left - 6}" y="${ys(v)}" class="chart-tick chart-tick-y">${label}</text>`
    )
    .join("");

  const xTicksSvg = xTickVals
    .map(
      (v) => `<text x="${xs(v)}" y="${MARGIN.top + PLOT_H + 16}" class="chart-tick chart-tick-x">${xTickFormat(v)}</text>`
    )
    .join("");

  const axes = `
    <line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${MARGIN.top + PLOT_H}" class="chart-axis" />
    <line x1="${MARGIN.left}" y1="${MARGIN.top + PLOT_H}" x2="${MARGIN.left + PLOT_W}" y2="${MARGIN.top + PLOT_H}" class="chart-axis" />`;

  const titleSvg = `<text x="${MARGIN.left}" y="14" class="chart-title">${title}</text>`;

  return { xs, ys, svgHead: `${titleSvg}${yGrid}${xTicksSvg}${axes}` };
}

function marginalGapChart(gaps, mcGaps, benchmarkSwitch, T) {
  const allVals = [...gaps, ...mcGaps, 0];
  const yDomain = padDomain(Math.min(...allVals), Math.max(...allVals));
  const { xs, ys, svgHead } = chartFrame({
    title: "Marginal value of contributing",
    xDomain: [0, T - 1],
    yDomain,
    xTickFormat: (v) => `${Math.round(v)}`,
  });

  const zeroY = ys(0);
  const zeroLine =
    yDomain[0] < 0 && yDomain[1] > 0
      ? `<line x1="${MARGIN.left}" y1="${zeroY.toFixed(1)}" x2="${MARGIN.left + PLOT_W}" y2="${zeroY.toFixed(1)}" class="chart-zeroline" />`
      : "";

  const benchX = xs(benchmarkSwitch);
  const benchLine = `<line x1="${benchX.toFixed(1)}" y1="${MARGIN.top}" x2="${benchX.toFixed(1)}" y2="${MARGIN.top + PLOT_H}" class="chart-refline" />`;

  const gapPath = pathFrom(gaps.map((v, t) => [xs(t), ys(v)]));
  const mcPath = pathFrom(mcGaps.map((v, t) => [xs(t), ys(v)]));
  const mcMarkers = mcGaps
    .map((v, t) => `<circle cx="${xs(t).toFixed(1)}" cy="${ys(v).toFixed(1)}" r="2.6" class="chart-marker" />`)
    .join("");

  return `
    <svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="chart-svg" role="img" aria-label="Marginal value of contributing by year">
      ${svgHead}
      ${zeroLine}
      ${benchLine}
      <path d="${gapPath}" class="chart-line chart-line-ink" />
      <path d="${mcPath}" class="chart-line chart-line-accent" />
      ${mcMarkers}
    </svg>
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-swatch swatch-ink"></span>numeric marginal gap</span>
      <span class="legend-item"><span class="legend-swatch swatch-accent"></span>MC estimate</span>
    </div>
  `;
}

function policyStepChart(policy, benchmarkSwitch, T) {
  const { xs, ys, svgHead } = chartFrame({
    title: "Learned greedy policy",
    xDomain: [0, T - 1],
    yDomain: [-0.15, 1.15],
    yTickLabels: [
      { v: 0, label: "don't" },
      { v: 1, label: "contribute" },
    ],
    xTickFormat: (v) => `${Math.round(v)}`,
  });

  // step(where="mid"): each year's value holds from t-0.5 to t+0.5
  const points = [];
  policy.forEach((a, t) => {
    points.push([xs(t - 0.5), ys(a)]);
    points.push([xs(t + 0.5), ys(a)]);
  });
  const stepPath = pathFrom(points);

  const benchX = xs(benchmarkSwitch);
  const benchLine = `<line x1="${benchX.toFixed(1)}" y1="${MARGIN.top}" x2="${benchX.toFixed(1)}" y2="${MARGIN.top + PLOT_H}" class="chart-refline" />`;

  return `
    <svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="chart-svg" role="img" aria-label="Learned contribution policy by year">
      ${svgHead}
      ${benchLine}
      <path d="${stepPath}" class="chart-line chart-line-accent" />
    </svg>
    <p class="chart-caption">year t — dashed line marks the benchmark switch (year ${benchmarkSwitch})</p>
  `;
}

function rewardChart(trace, nEpisodes) {
  const yDomain = padDomain(Math.min(...trace), Math.max(...trace));
  const { xs, ys, svgHead } = chartFrame({
    title: "Episode reward (smoothed)",
    xDomain: [0, nEpisodes],
    yDomain,
    xTickFormat: formatCount,
  });

  const path = pathFrom(trace.map((v, i) => [xs((i / (trace.length - 1)) * nEpisodes), ys(v)]));

  return `
    <svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="chart-svg" role="img" aria-label="Smoothed episode reward during training">
      ${svgHead}
      <path d="${path}" class="chart-line chart-line-accent" />
    </svg>
    <p class="chart-caption">episode</p>
  `;
}

function renderResults(data) {
  const m = data.metrics;
  const T = data.policy.length;
  results.innerHTML = `
    <div class="diagnostics-grid">
      <div class="chart-panel">${marginalGapChart(data.q_gaps, data.mc_gaps, data.benchmark_switch, T)}</div>
      <div class="chart-panel">${policyStepChart(data.policy, data.benchmark_switch, T)}</div>
      <div class="chart-panel">${rewardChart(data.reward_trace, data.n_episodes)}</div>
    </div>
    <table class="metrics-table">
      <tbody>
        <tr><th>PV contributions</th><td>${formatNumber(m.pv_contrib)}</td></tr>
        <tr><th>PV payout</th><td>${formatNumber(m.pv_payout)}</td></tr>
        <tr><th>Efficiency (payout / contrib)</th><td>${formatNumber(m.efficiency)}</td></tr>
        <tr><th>Duration (years)</th><td>${formatNumber(m.duration, 1)}</td></tr>
        <tr><th>Replacement ratio</th><td>${formatNumber(m.replacement)}</td></tr>
      </tbody>
    </table>
  `;
}

function renderError(message) {
  results.innerHTML = `<p class="playground-error">Couldn't reach the model: ${message}</p>`;
}

function renderLoading() {
  results.innerHTML = `<p class="playground-placeholder">Training the agent…</p>`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const body = {};
  for (const [key, value] of formData.entries()) {
    body[key] = key === "plan" ? value : Number(value);
  }

  renderLoading();
  try {
    const response = await fetch(`${API_BASE}/pension/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${response.status}`);
    }
    renderResults(await response.json());
  } catch (err) {
    renderError(err.message);
  }
});
