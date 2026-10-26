// Home page Δ/t panel: draws a handful of Vasicek short-rate paths,
//   dr = κ(θ − r) dt + σ dW,
// simulated fresh on every load (and on "Simulate"). One path is highlighted;
// the dashed line is the long-run mean θ the paths revert to.
(function () {
  const svg = document.getElementById("delta-t-chart");
  if (!svg) return;

  const NS = "http://www.w3.org/2000/svg";
  const W = svg.viewBox.baseVal.width, H = svg.viewBox.baseVal.height;
  const STEPS = 240, PATHS = 8;
  const KAPPA = 1.1, THETA = 0.5, SIGMA = 0.2, DT = 1 / 40;   // rates in [0, 1] = chart height

  function gauss() {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }

  const LO = 0.06, HI = 0.94;      // keep paths inside the frame by reflecting at the edges
  const reflect = (r) => (r > HI ? 2 * HI - r : r < LO ? 2 * LO - r : r);
  const y = (r) => H * (1 - r);

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    svg.appendChild(node);
    return node;
  }

  function draw() {
    svg.textContent = "";

    for (let i = 1; i < 6; i++) el("line", { class: "grid", x1: 0, x2: W, y1: (H * i) / 6, y2: (H * i) / 6 });
    for (let i = 1; i < 8; i++) el("line", { class: "grid", y1: 0, y2: H, x1: (W * i) / 8, x2: (W * i) / 8 });
    el("line", { class: "mean", x1: 0, x2: W, y1: y(THETA), y2: y(THETA) });

    for (let p = PATHS - 1; p >= 0; p--) {       // highlighted path (p = 0) last, so it is on top
      let r = 0.12 + 0.76 * Math.random();
      let d = `M0 ${y(r).toFixed(1)}`;
      for (let i = 1; i <= STEPS; i++) {
        r = reflect(r + KAPPA * (THETA - r) * DT + SIGMA * Math.sqrt(DT) * gauss());
        d += ` L${((W * i) / STEPS).toFixed(1)} ${y(r).toFixed(1)}`;
      }
      el("path", {
        d,
        class: p === 0 ? "path path--hi" : "path",
        pathLength: 1,
        style: `animation-delay:${(p * 0.12).toFixed(2)}s`,
      });
    }
  }

  draw();
  const redraw = document.getElementById("delta-t-redraw");
  if (redraw) redraw.addEventListener("click", draw);
})();
