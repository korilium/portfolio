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
  xTickLabels = null,
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
  // explicit x labels are for axes whose even spacing is not in data units (log cost)
  const xTicks = xTickLabels
    ? xTickLabels
    : niceTicks(xDomain[0], xDomain[1], 4).map((v) => ({ v, label: xTickFormat(v) }));

  const yGrid = yTicks
    .map(
      ({ v, label }) => `
      <line x1="${m.left}" y1="${ys(v)}" x2="${m.left + plotW}" y2="${ys(v)}" class="chart-gridline" />
      <text x="${m.left - 6}" y="${ys(v)}" class="chart-tick chart-tick-y">${label}</text>`
    )
    .join("");

  const xTicksSvg = xTicks
    .map(
      ({ v, label }) => `<text x="${xs(v)}" y="${m.top + plotH + 16}" class="chart-tick chart-tick-x">${label}</text>`
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

/** A ramp is a function t in [0, 1] -> CSS colour; `.rgb(t)` gives the same colour
 *  as [r, g, b], which is what a canvas heatmap writes. */
function rampOf(stops) {
  const rgb = (t) => {
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    return stops[i].map((v, k) => Math.round(v + f * (stops[i + 1][k] - v)));
  };
  const css = (t) => {
    const c = rgb(t);
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  css.rgb = rgb;
  return css;
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

// matplotlib's RdBu_r: blue (t = 0) through white (0.5) to red (1), for a signed
// quantity centred on zero
const RDBU = rampOf([
  [5, 48, 97], [33, 102, 172], [67, 147, 195], [146, 197, 222], [209, 229, 240],
  [247, 247, 247], [253, 219, 199], [244, 165, 130], [214, 96, 77], [178, 24, 43],
  [103, 0, 31],
]);

/** A heatmap as an <image>, one pixel per grid node, drawn through a canvas.
 *
 *  The (F, log rho) grids are uniform in plot coordinates, so node (i, j) is one
 *  pixel and the image only has to be stretched over the node CELLS: half a step
 *  beyond the first and last node on each axis, as pcolormesh(shading="auto")
 *  does. At 73x71 that is one element instead of ~5,000 SVG rects.
 *
 *  `colourAt(i, j)` returns [r, g, b] or null (transparent). `xOf`/`yOf` map a node
 *  INDEX (fractional allowed) to plot coordinates. */
function heatImage(nx, ny, colourAt, xOf, yOf) {
  const canvas = document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(nx, ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = colourAt(i, j);
      if (!c) continue;
      const k = 4 * ((ny - 1 - j) * nx + i);          // row 0 is the TOP, i.e. rho max
      img.data[k] = c[0];
      img.data[k + 1] = c[1];
      img.data[k + 2] = c[2];
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const x0 = xOf(-0.5);
  const x1 = xOf(nx - 0.5);
  const yTop = yOf(ny - 0.5);
  const yBot = yOf(-0.5);
  return `<image href="${canvas.toDataURL()}" x="${x0.toFixed(2)}" y="${yTop.toFixed(2)}" width="${(x1 - x0).toFixed(2)}" height="${(yBot - yTop).toFixed(2)}" preserveAspectRatio="none" class="chart-heat" />`;
}

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
