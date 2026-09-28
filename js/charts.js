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

/** Frame shared by every chart: axes, y-ticks, x-ticks, title. */
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

/** Wrap chart body markup in the standard svg element. */
function chartSvg(body, label) {
  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="chart-svg" role="img" aria-label="${label}">${body}</svg>`;
}
