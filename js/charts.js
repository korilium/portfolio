// Tiny SVG chart helpers, shared by the Play Ground tools.
//
// No charting library, to stay consistent with the rest of this vanilla-JS site.
// Extracted from playground.js when the DP oracle tool needed the same frame, so
// there is one copy of the axes/scales rather than two that drift apart.

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

/** Frame shared by every chart: axes, y-ticks, x-ticks, title.
 *
 * `xLabel`/`yLabel` and the geometry overrides are opt-in, so callers that pass
 * neither (the tabular-agent tool) render exactly as before. The DP tool passes
 * both, because its figures mirror the thesis's matplotlib ones and those carry
 * named axes — an unlabelled F/rho plane is unreadable without the paper.
 *
 * Returns the geometry it used as `geom`, so callers stop reaching for the
 * module-level MARGIN/PLOT_* when they have overridden them. */
function chartFrame({
  title,
  xDomain,
  yDomain,
  xTickFormat = String,
  yTickLabels = null,
  xLabel = null,
  yLabel = null,
  width = CHART_W,
  height = CHART_H,
  margin = MARGIN,
}) {
  const m = margin;
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const xs = makeScale(xDomain, [m.left, m.left + plotW]);
  const ys = makeScale(yDomain, [m.top + plotH, m.top]);

  const yTicks = yTickLabels
    ? yTickLabels
    : niceTicks(yDomain[0], yDomain[1], 4).map((v) => ({ v, label: v.toFixed(2) }));
  const xTickVals = niceTicks(xDomain[0], xDomain[1], 4);

  const yGrid = yTicks
    .map(
      ({ v, label }) => `
      <line x1="${m.left}" y1="${ys(v)}" x2="${m.left + plotW}" y2="${ys(v)}" class="chart-gridline" />
      <text x="${m.left - 6}" y="${ys(v)}" class="chart-tick chart-tick-y">${label}</text>`
    )
    .join("");

  const xTicksSvg = xTickVals
    .map(
      (v) => `<text x="${xs(v)}" y="${m.top + plotH + 16}" class="chart-tick chart-tick-x">${xTickFormat(v)}</text>`
    )
    .join("");

  const axes = `
    <line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${m.top + plotH}" class="chart-axis" />
    <line x1="${m.left}" y1="${m.top + plotH}" x2="${m.left + plotW}" y2="${m.top + plotH}" class="chart-axis" />`;

  const titleSvg = `<text x="${m.left}" y="14" class="chart-title">${title}</text>`;

  const xLabelSvg = xLabel
    ? `<text x="${m.left + plotW / 2}" y="${height - 4}" class="chart-axis-label" text-anchor="middle">${xLabel}</text>`
    : "";
  const yLabelSvg = yLabel
    ? `<text transform="translate(11 ${m.top + plotH / 2}) rotate(-90)" class="chart-axis-label" text-anchor="middle">${yLabel}</text>`
    : "";

  return {
    xs,
    ys,
    geom: { width, height, m, plotW, plotH },
    svgHead: `${titleSvg}${yGrid}${xTicksSvg}${axes}${xLabelSvg}${yLabelSvg}`,
  };
}

/** Wrap chart body markup in the standard svg element. */
function chartSvg(body, label, width = CHART_W, height = CHART_H) {
  return `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="${label}">${body}</svg>`;
}

// --- colour ramps ------------------------------------------------------------
// Piecewise-linear stops through matplotlib's viridis and magma, so the heatmaps
// read the same way as the thesis figures they mirror. Approximations, not the
// exact 256-entry tables — close enough that the two are recognisably the same
// colour scheme side by side.

function rampOf(stops) {
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const c = stops[i].map((v, k) => Math.round(v + f * (stops[i + 1][k] - v)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
}

const VIRIDIS = rampOf([
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
  [38, 130, 142], [31, 158, 137], [53, 183, 121], [110, 206, 88],
  [181, 222, 43], [253, 231, 37],
]);

const MAGMA = rampOf([
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129],
  [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135],
  [252, 253, 191],
]);

/** Vertical colour bar with a label, mirroring matplotlib's colorbar.
 *  `ticks` are [position 0..1, label] pairs, bottom to top. */
function colourBar({ x, y, w, h, ramp, label, ticks, steps = 32 }) {
  let cells = "";
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const yy = y + h - ((i + 1) * h) / steps;
    cells += `<rect x="${x}" y="${yy.toFixed(1)}" width="${w}" height="${(h / steps + 0.6).toFixed(2)}" fill="${ramp(t)}" />`;
  }
  const tickSvg = (ticks || [])
    .map(
      ([t, lab]) =>
        `<text x="${x + w + 3}" y="${(y + h - t * h).toFixed(1)}" class="chart-tick chart-tick-y" text-anchor="start">${lab}</text>`
    )
    .join("");
  const labSvg = label
    ? `<text transform="translate(${x + w + 30} ${y + h / 2}) rotate(-90)" class="chart-axis-label" text-anchor="middle">${label}</text>`
    : "";
  return `${cells}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" class="chart-axis" />${tickSvg}${labSvg}`;
}
