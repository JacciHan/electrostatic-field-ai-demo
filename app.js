const canvas = document.querySelector("#fieldCanvas");
const ctx = canvas.getContext("2d");

const state = {
  scene: "solid",
  prediction: false,
  showCharges: true,
  showLines: true,
  showLabels: true,
  chargeSign: 1,
  charge: { x: 0.23, y: 0.5 },
  dragging: false
};

const bemCache = {
  key: "",
  solution: null
};

let drawQueued = false;

const visualState = {
  scene: "",
  charges: [],
  fieldLineAlpha: 1,
  maxChargeDelta: 0
};

const fieldLineConfig = {
  maxLines: 30,
  maxLinesDragging: 20,
  minSourceLines: 8,
  maxSourceLines: 14,
  maxBoundaryLines: 24
};

const sceneMeta = {
  solid: {
    title: "实心导体靠近外部电荷",
    lead: "拖动点电荷，观察导体表面电荷重新分布与内部电场为零。",
    question: "如果外部正电荷靠近导体左侧，导体左、右两侧分别会出现什么电荷？导体内部还有电场吗？"
  },
  shield: {
    title: "带空腔导体：外部电荷靠近",
    lead: "观察外部电荷靠近金属壳时，空腔内部是否受到外部静电场影响。",
    question: "外部电荷靠近时，空腔内表面一定会带电吗？空腔内部和导体材料内部有什么区别？"
  },
  cavity: {
    title: "带空腔导体：电荷放入空腔",
    lead: "拖动腔内电荷，观察内表面电荷分布如何随位置变化。",
    question: "点电荷放在空腔内部时，金属壳还能让空腔内没有电场吗？内表面电荷会均匀分布吗？"
  },
  tip: {
    title: "尖端效应：电荷密度与电场强弱",
    lead: "观察尖端附近电荷更密、电场线更密的定性模型。",
    question: "为什么避雷针和尖端放电都和“尖端附近电场更强”有关？"
  }
};

const els = {
  sceneTitle: document.querySelector("#sceneTitle"),
  sceneLead: document.querySelector("#sceneLead"),
  statusPill: document.querySelector("#statusPill"),
  aiSummary: document.querySelector("#aiSummary"),
  studentChecks: document.querySelector("#studentChecks"),
  physicsChecks: document.querySelector("#physicsChecks"),
  modeToggle: document.querySelector("#modeToggle"),
  showCharges: document.querySelector("#showCharges"),
  showLines: document.querySelector("#showLines"),
  showLabels: document.querySelector("#showLabels"),
  positiveBtn: document.querySelector("#positiveBtn"),
  negativeBtn: document.querySelector("#negativeBtn")
};

function sx(x) {
  return x * canvas.width;
}

function sy(y) {
  return y * canvas.height;
}

function nxToNyRadius(r) {
  return (r * canvas.width) / canvas.height;
}

function circlePoint(cx, cy, r, angle, offset = 0) {
  const pixelRadius = sx(r + offset);
  return {
    x: (sx(cx) + Math.cos(angle) * pixelRadius) / canvas.width,
    y: (sy(cy) + Math.sin(angle) * pixelRadius) / canvas.height
  };
}

function circleNormal(angle) {
  return {
    x: Math.cos(angle),
    y: (Math.sin(angle) * canvas.width) / canvas.height
  };
}

function normalizedDistance(a, b) {
  const dx = sx(a.x) - sx(b.x);
  const dy = sy(a.y) - sy(b.y);
  return Math.hypot(dx, dy) / canvas.width;
}

function pixelAngle(cx, cy, point) {
  return Math.atan2(sy(point.y) - sy(cy), sx(point.x) - sx(cx));
}

function pointFromPixelVector(origin, angle, pixelDistance) {
  return {
    x: (sx(origin.x) + Math.cos(angle) * pixelDistance) / canvas.width,
    y: (sy(origin.y) + Math.sin(angle) * pixelDistance) / canvas.height
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toPhys(point) {
  return { x: point.x, y: point.y * canvas.height / canvas.width };
}

function fromPhys(point) {
  return { x: point.x, y: point.y * canvas.width / canvas.height };
}

function physDistance(a, b) {
  const pa = toPhys(a);
  const pb = toPhys(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

function makeBoundaryCircle(cx, cy, r, count, role) {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count;
    points.push({
      ...circlePoint(cx, cy, r, angle),
      cx,
      cy,
      r,
      angle,
      role,
      segment: (Math.PI * 2 * r) / count
    });
  }
  return points;
}

function makeBemGeometry() {
  if (state.scene === "solid") {
    return {
      boundaries: makeBoundaryCircle(0.56, 0.5, 0.2, 56, "outer"),
      conductors: [{ cx: 0.56, cy: 0.5, inner: 0, outer: 0.2, type: "solid" }]
    };
  }
  if (state.scene === "shield" || state.scene === "cavity") {
    return {
      boundaries: [
        ...makeBoundaryCircle(0.56, 0.5, 0.24, 60, "outer"),
        ...makeBoundaryCircle(0.56, 0.5, 0.112, 40, "inner")
      ],
      conductors: [{ cx: 0.56, cy: 0.5, inner: 0.112, outer: 0.24, type: "shell" }]
    };
  }
  return null;
}

function sourceCharges() {
  return [{ x: state.charge.x, y: state.charge.y, q: state.chargeSign }];
}

function green(a, b, selfSegment = 0) {
  if (selfSegment) return -Math.log(Math.max(0.002, selfSegment * 0.45));
  const d = Math.max(0.003, physDistance(a, b));
  return -Math.log(d);
}

function sourcePotential(point, sources) {
  return sources.reduce((sum, source) => sum + source.q * green(point, source), 0);
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) throw new Error("BEM matrix is singular");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let k = col; k <= n; k += 1) a[col][k] /= scale;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map(row => row[n]);
}

function getBemSolution() {
  if (!["solid", "shield", "cavity"].includes(state.scene)) return null;
  const key = [
    state.scene,
    state.chargeSign,
    state.charge.x.toFixed(3),
    state.charge.y.toFixed(3),
    canvas.width,
    canvas.height
  ].join("|");
  if (bemCache.key === key) return bemCache.solution;

  const geometry = makeBemGeometry();
  const boundaries = geometry.boundaries;
  const sources = sourceCharges();
  const n = boundaries.length;
  const matrix = Array.from({ length: n + 1 }, () => Array(n + 1).fill(0));
  const vector = Array(n + 1).fill(0);

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      matrix[i][j] = green(boundaries[i], boundaries[j], i === j ? boundaries[j].segment : 0);
    }
    matrix[i][n] = -1;
    vector[i] = -sourcePotential(boundaries[i], sources);
  }
  for (let j = 0; j < n; j += 1) matrix[n][j] = 1;
  vector[n] = 0;

  const solved = solveLinearSystem(matrix, vector);
  const charges = solved.slice(0, n);
  const conductorPotential = solved[n];
  const solution = { boundaries, charges, conductorPotential, sources, geometry };
  bemCache.key = key;
  bemCache.solution = solution;
  return solution;
}

function fieldAt(point, solution) {
  const p = toPhys(point);
  let ex = 0;
  let ey = 0;
  const addCharge = (chargePoint, q) => {
    const cp = toPhys(chargePoint);
    const dx = p.x - cp.x;
    const dy = p.y - cp.y;
    const r2 = Math.max(0.00002, dx * dx + dy * dy);
    ex += q * dx / r2;
    ey += q * dy / r2;
  };
  solution.sources.forEach(source => addCharge(source, source.q));
  solution.boundaries.forEach((boundary, i) => addCharge(boundary, solution.charges[i]));
  return { x: ex, y: ey };
}

function isInConductor(point, solution) {
  const conductor = solution.geometry.conductors[0];
  const center = { x: conductor.cx, y: conductor.cy };
  const d = physDistance(point, center);
  if (conductor.type === "solid") return d < conductor.outer;
  return d > conductor.inner && d < conductor.outer;
}

function setScene(scene) {
  state.scene = scene;
  if (location.hash.slice(1) !== scene) {
    history.replaceState(null, "", `#${scene}`);
  }
  if (scene === "cavity") state.charge = { x: 0.5, y: 0.48 };
  if (scene === "tip") state.charge = { x: 0.26, y: 0.5 };
  if (scene === "solid" || scene === "shield") state.charge = { x: 0.23, y: 0.5 };
  document.querySelectorAll(".segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.scene === scene);
  });
  updateText();
  draw();
}

function updateText() {
  const meta = sceneMeta[state.scene];
  els.sceneTitle.textContent = meta.title;
  els.sceneLead.textContent = meta.lead;
  els.statusPill.textContent = state.prediction ? "预测模式" : "模型显示中";
  els.statusPill.style.background = state.prediction ? "#fff6df" : "#e6f5f2";
  els.statusPill.style.color = state.prediction ? "#7a4b00" : "#095d56";
  els.modeToggle.textContent = state.prediction ? "显示模型结果" : "进入预测模式";

  const signWord = state.chargeSign > 0 ? "正电荷" : "负电荷";
  const summaries = {
    solid: `当前外部${signWord}靠近实心导体。模型实时重算表面感应电荷，使导体内部合电场保持为零。`,
    shield: `当前外部${signWord}靠近带空腔导体。模型区分导体材料内部 E=0 与空腔区域是否受影响。`,
    cavity: `当前${signWord}位于空腔内。内表面出现异号感应电荷，分布随电荷位置连续改变。`,
    tip: "当前为尖端效应定性模型，用于展示尖端附近电荷密度更高、电场更强。"
  };
  els.aiSummary.textContent = state.prediction
    ? "预测模式：隐藏模型结果，先判断感应电荷位置、导体内部电场和空腔区域电场。"
    : summaries[state.scene];

  renderList(els.studentChecks, getStudentChecks());
}

function getStudentChecks() {
  if (state.prediction) {
    return ["先判断近侧/远侧感应电荷符号。", "先判断导体材料内部电场是否为零。", "再显示模型结果进行对照。"];
  }
  if (state.scene === "cavity") {
    return ["空腔内部可以有电场。", "导体材料内部保持 E=0。", "内表面异号电荷在靠近处更密。"];
  }
  if (state.scene === "shield") {
    return ["外部电荷只改变外表面分布。", "空腔内部不出现外部电场线。", "导体材料内部保持 E=0。"];
  }
  if (state.scene === "tip") {
    return ["尖端附近电荷点更密。", "电场线在尖端附近更集中。", "该场景用于定性解释尖端效应。"];
  }
  return ["近侧出现异号感应电荷。", "远侧出现同号感应电荷。", "导体内部保持 E=0。"];
}

function renderList(root, items) {
  root.innerHTML = "";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    root.appendChild(li);
  });
}

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fcfdfe";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(117, 132, 143, 0.075)";
  ctx.lineWidth = 1;
  for (let x = 80; x < canvas.width; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 70; y < canvas.height; y += 70) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function draw() {
  const startedAt = performance.now();
  try {
    let solution = null;
    if (["solid", "shield", "cavity"].includes(state.scene)) {
      solution = getBemSolution();
      advanceVisualState(solution);
    }
    clearCanvas();
    if (!state.prediction && state.showLines) drawFieldLines();
    drawConductor();
    if (!state.prediction && state.showCharges) drawSurfaceCharges();
    drawPointCharge();
    if (state.showLabels) drawLabels();
    updatePhysicsDiagnostics(performance.now() - startedAt);
    if (needsVisualAnimation()) requestDraw();
  } catch (error) {
    console.error(error);
    ctx.save();
    ctx.fillStyle = "#7f1d1d";
    ctx.font = "700 24px sans-serif";
    ctx.fillText(`绘制错误：${error.message}`, 48, 76);
    ctx.restore();
  }
}

function advanceVisualState(solution) {
  if (visualState.scene !== state.scene || visualState.charges.length !== solution.charges.length) {
    visualState.scene = state.scene;
    visualState.charges = [...solution.charges];
    visualState.fieldLineAlpha = 1;
    visualState.maxChargeDelta = 0;
    return;
  }

  const chargeEase = state.dragging ? 0.42 : 0.24;
  let maxDelta = 0;
  visualState.charges = visualState.charges.map((displayed, index) => {
    const target = solution.charges[index];
    const next = displayed + (target - displayed) * chargeEase;
    maxDelta = Math.max(maxDelta, Math.abs(target - next));
    return next;
  });
  visualState.maxChargeDelta = maxDelta;

  const targetAlpha = state.dragging ? 0.58 : 1;
  const alphaEase = state.dragging ? 0.45 : 0.18;
  visualState.fieldLineAlpha += (targetAlpha - visualState.fieldLineAlpha) * alphaEase;
}

function needsVisualAnimation() {
  if (!["solid", "shield", "cavity"].includes(state.scene)) return false;
  if (visualState.maxChargeDelta > 0.00035) return true;
  const targetAlpha = state.dragging ? 0.58 : 1;
  return Math.abs(visualState.fieldLineAlpha - targetAlpha) > 0.012;
}

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function updatePhysicsDiagnostics(elapsedMs = 0) {
  if (!els.physicsChecks) return;
  if (!["solid", "shield", "cavity"].includes(state.scene)) {
    renderList(els.physicsChecks, ["当前场景使用定性尖端模型。", "不作为边界电荷数值求解场景。"]);
    return;
  }
  const solution = getBemSolution();
  const potentials = solution.boundaries.map((boundary) => {
    let value = sourcePotential(boundary, solution.sources);
    solution.boundaries.forEach((other, index) => {
      value += solution.charges[index] * green(boundary, other, boundary === other ? other.segment : 0);
    });
    return value;
  });
  const mean = potentials.reduce((sum, value) => sum + value, 0) / potentials.length;
  const maxError = Math.max(...potentials.map(value => Math.abs(value - mean)));
  const total = solution.charges.reduce((sum, value) => sum + value, 0);
  const outer = solution.charges.reduce((sum, value, index) => sum + (solution.boundaries[index].role === "outer" ? value : 0), 0);
  const inner = solution.charges.reduce((sum, value, index) => sum + (solution.boundaries[index].role === "inner" ? value : 0), 0);
  const items = [
    `边界等势最大误差：${maxError.toExponential(2)}`,
    `导体净电荷约束：${total.toExponential(2)}`,
    `求解与绘制耗时：${elapsedMs.toFixed(1)} ms`
  ];
  if (state.scene !== "solid") {
    items.push(`外表面总电荷：${outer.toFixed(3)}`);
    items.push(`内表面总电荷：${inner.toFixed(3)}`);
  }
  renderList(els.physicsChecks, items);
}

function drawConductor() {
  if (state.scene === "solid") {
    drawDisk(0.56, 0.5, 0.2);
  } else if (state.scene === "shield" || state.scene === "cavity") {
    drawShell();
  } else {
    drawTipConductor();
  }
}

function drawDisk(cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx(cx), sy(cy), sx(r), 0, Math.PI * 2);
  const grad = ctx.createRadialGradient(sx(cx - 0.08), sy(cy - 0.1), sx(0.02), sx(cx), sy(cy), sx(r));
  grad.addColorStop(0, "#f2f6f8");
  grad.addColorStop(0.62, "#d9e1e6");
  grad.addColorStop(1, "#c7d1d8");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "#7f8e99";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();
}

function drawShell() {
  ctx.save();
  const cx = sx(0.56);
  const cy = sy(0.5);
  const outer = sx(0.24);
  const inner = sx(0.112);
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.arc(cx, cy, inner, 0, Math.PI * 2, true);
  const grad = ctx.createRadialGradient(sx(0.47), sy(0.35), sx(0.04), cx, cy, outer);
  grad.addColorStop(0, "#f4f7f9");
  grad.addColorStop(0.58, "#d9e1e6");
  grad.addColorStop(1, "#c7d1d8");
  ctx.fillStyle = grad;
  ctx.fill("evenodd");
  ctx.strokeStyle = "#7f8e99";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawTipConductor() {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(sx(0.72), sy(0.5));
  ctx.bezierCurveTo(sx(0.56), sy(0.29), sx(0.36), sy(0.31), sx(0.34), sy(0.5));
  ctx.bezierCurveTo(sx(0.36), sy(0.69), sx(0.56), sy(0.71), sx(0.72), sy(0.5));
  ctx.closePath();
  const grad = ctx.createLinearGradient(sx(0.34), sy(0.36), sx(0.72), sy(0.5));
  grad.addColorStop(0, "#f1f5f7");
  grad.addColorStop(0.62, "#d8e1e6");
  grad.addColorStop(1, "#c2cdd5");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "#7f8e99";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();
}

function drawPointCharge() {
  const x = sx(state.charge.x);
  const y = sy(state.charge.y);
  const color = state.chargeSign > 0 ? "#c2413f" : "#2563a9";
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 22, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowColor = "rgba(0,0,0,0.22)";
  ctx.shadowBlur = 12;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#fff";
  ctx.font = "700 28px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(state.chargeSign > 0 ? "+" : "-", x, y - 1);
  ctx.restore();
}

function drawSurfaceCharges() {
  if (["solid", "shield", "cavity"].includes(state.scene)) {
    drawBemSurfaceCharges();
  } else {
    drawTipCharges();
  }
}

function drawBemSurfaceCharges() {
  const solution = getBemSolution();
  const charges = visualState.charges.length === solution.charges.length ? visualState.charges : solution.charges;
  const maxAbs = Math.max(...charges.map(charge => Math.abs(charge)), 1e-6);
  solution.boundaries.forEach((boundary, index) => {
    const q = charges[index];
    const strength = Math.abs(q) / maxAbs;
    if (strength < 0.055) return;
    const offset = boundary.role === "inner" ? 0.012 : 0.008;
    const point = circlePoint(boundary.cx, boundary.cy, boundary.r, boundary.angle, offset);
    drawSurfaceDot(point.x, point.y, q > 0 ? 1 : -1, 2.4 + strength * 6.2);
  });
}

function drawCircularCharges(cx, cy, r, inner, uniformOuter = false) {
  const count = inner ? 32 : 40;
  const chargeAngle = Math.atan2(state.charge.y - cy, state.charge.x - cx);
  for (let i = 0; i < count; i += 1) {
    const a = (Math.PI * 2 * i) / count;
    const alignment = Math.cos(a - chargeAngle);
    const near = Math.max(0, alignment);
    const far = Math.max(0, -alignment);
    const offset = inner ? 0.014 : 0.008;
    const p = circlePoint(cx, cy, r, a, offset);
    const distanceWeight = clamp(0.09 / Math.max(0.022, normalizedDistance(state.charge, p)), 0, 1.8);
    const density = uniformOuter
      ? 0.6
      : (inner ? 0.16 + distanceWeight : 0.24 + near * 0.98 + far * 0.34);
    if (density < 0.48 && i % 2) continue;
    const sign = uniformOuter
      ? state.chargeSign
      : (inner ? -state.chargeSign : (near >= far ? -state.chargeSign : state.chargeSign));
    drawSurfaceDot(p.x, p.y, sign, 2.6 + density * 4.2);
  }
}

function drawTipCharges() {
  const points = [
    [0.70, 0.5, 1.4], [0.66, 0.45, 1.1], [0.66, 0.55, 1.1],
    [0.58, 0.38, 0.8], [0.58, 0.62, 0.8], [0.47, 0.34, 0.6],
    [0.47, 0.66, 0.6], [0.37, 0.46, 0.55], [0.37, 0.54, 0.55]
  ];
  points.forEach(([x, y, size]) => drawSurfaceDot(x, y, state.chargeSign, 4 + size * 3.2));
}

function drawSurfaceDot(x, y, sign, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx(x), sy(y), radius, 0, Math.PI * 2);
  ctx.fillStyle = sign > 0 ? "#c2413f" : "#2563a9";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.82)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

function drawFieldLines() {
  ctx.save();
  const lineAlpha = ["solid", "shield", "cavity"].includes(state.scene)
    ? 0.34 + visualState.fieldLineAlpha * 0.42
    : 0.76;
  ctx.globalAlpha = lineAlpha;
  ctx.strokeStyle = "rgba(31, 97, 125, 0.55)";
  ctx.lineWidth = 1.65;
  ctx.lineCap = "round";
  if (["solid", "shield", "cavity"].includes(state.scene)) {
    drawBemFieldLines();
  } else {
    for (let i = -3; i <= 3; i += 1) {
      drawCubic({ x: 0.72, y: 0.5 }, { x: 0.82, y: 0.5 + i * 0.055 }, { x: 0.93, y: 0.5 + i * 0.095 }, { x: 1.03, y: 0.5 + i * 0.13 }, true);
    }
  }
  ctx.restore();
}

function drawBemFieldLines() {
  const solution = getBemSolution();
  const lineSolution = makeLineSolution(solution);
  const reverseArrows = solution.sources[0].q < 0;
  const seeds = makeFieldSeeds(lineSolution);
  seeds.forEach(seed => traceFieldLine(seed.point, lineSolution, seed.direction, reverseArrows));
  if (state.scene === "cavity") {
    const outerCharge = solution.charges.reduce((sum, value, index) => (
      solution.boundaries[index].role === "outer" ? sum + value : sum
    ), 0);
    const count = state.dragging ? 8 : 12;
    drawOuterRadialLines(0.56, 0.5, 0.24, count, outerCharge >= 0);
  }
}

function makeLineSolution(solution) {
  const sign = solution.sources[0].q < 0 ? -1 : 1;
  if (sign > 0) return solution;
  return {
    ...solution,
    sources: solution.sources.map(source => ({ ...source, q: source.q * sign })),
    charges: solution.charges.map(charge => charge * sign)
  };
}

function makeFieldSeeds(solution) {
  const seeds = [];
  const source = solution.sources[0];
  const positiveBoundaryFlux = solution.charges.reduce((sum, charge) => sum + Math.max(0, charge), 0);
  const sourceFlux = Math.max(0, source.q);
  const fluxTotal = sourceFlux + positiveBoundaryFlux;
  const lineBudget = state.dragging ? fieldLineConfig.maxLinesDragging : fieldLineConfig.maxLines;
  const sourceSeedCount = sourceFlux > 0
    ? clamp(
      Math.round((sourceFlux / Math.max(fluxTotal, sourceFlux)) * lineBudget),
      fieldLineConfig.minSourceLines,
      fieldLineConfig.maxSourceLines
    )
    : 0;
  if (source.q > 0) {
    for (let i = 0; i < sourceSeedCount; i += 1) {
      const angle = (Math.PI * 2 * i) / sourceSeedCount;
      seeds.push({ point: pointFromPixelVector(source, angle, 28), direction: 1 });
    }
  }
  if (state.scene === "cavity") return seeds.slice(0, lineBudget);

  const boundaryBudget = Math.min(fieldLineConfig.maxBoundaryLines, Math.max(0, lineBudget - seeds.length));
  seeds.push(...makeBoundaryFluxSeeds(solution, boundaryBudget));

  return seeds.slice(0, lineBudget);
}

function makeBoundaryFluxSeeds(solution, budget) {
  if (budget <= 0) return [];
  const candidates = [];
  solution.boundaries.forEach((boundary, index) => {
    const q = solution.charges[index];
    const flux = Math.max(0, q);
    if (flux <= 0) return;
    const outward = boundary.role === "outer" ? 1 : -1;
    const offset = boundary.role === "outer" ? 0.055 : -0.018;
    candidates.push({ boundary, direction: outward, offset, flux, quota: 0, count: 0 });
  });
  const totalFlux = candidates.reduce((sum, candidate) => sum + candidate.flux, 0);
  if (totalFlux <= 0) return [];

  candidates.forEach((candidate) => {
    candidate.quota = (candidate.flux / totalFlux) * budget;
    candidate.count = Math.floor(candidate.quota);
  });
  let used = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
  candidates
    .sort((a, b) => (b.quota - b.count) - (a.quota - a.count))
    .slice(0, budget - used)
    .forEach((candidate) => {
      candidate.count += 1;
      used += 1;
    });

  const seeds = [];
  candidates.forEach((candidate) => {
    for (let i = 0; i < candidate.count; i += 1) {
      const jitter = candidate.count === 1 ? 0 : ((i + 0.5) / candidate.count - 0.5) * (Math.PI * 2 / solution.boundaries.length);
      const point = circlePoint(
        candidate.boundary.cx,
        candidate.boundary.cy,
        candidate.boundary.r,
        candidate.boundary.angle + jitter,
        candidate.offset
      );
      seeds.push({ point, direction: candidate.direction });
    }
  });
  return seeds
    .sort((a, b) => Math.atan2(a.point.y - 0.5, a.point.x - 0.56) - Math.atan2(b.point.y - 0.5, b.point.x - 0.56))
    .slice(0, budget);
}

function traceFieldLine(seed, solution, direction, reverseArrow = false) {
  let point = { ...seed };
  ctx.beginPath();
  ctx.moveTo(sx(point.x), sy(point.y));
  let last = point;
  let arrowPoint = null;
  let arrowAngle = 0;
  for (let step = 0; step < 260; step += 1) {
    const field = fieldAt(point, solution);
    const mag = Math.hypot(field.x, field.y);
    if (!Number.isFinite(mag) || mag < 1e-5) break;
    const ux = (field.x / mag) * direction;
    const uy = (field.y / mag) * direction;
    const phys = toPhys(point);
    const nextPhys = { x: phys.x + ux * 0.0048, y: phys.y + uy * 0.0048 };
    const next = fromPhys(nextPhys);
    if (next.x < 0.01 || next.x > 0.99 || next.y < 0.02 || next.y > 0.98) break;
    if (isInConductor(next, solution)) break;
    ctx.lineTo(sx(next.x), sy(next.y));
    if (step === 28) {
      arrowPoint = next;
      arrowAngle = Math.atan2(sy(next.y) - sy(last.y), sx(next.x) - sx(last.x));
    }
    last = next;
    point = next;
    if (physDistance(point, solution.sources[0]) < 0.018) break;
  }
  ctx.stroke();
  if (arrowPoint) drawArrowhead(arrowPoint.x, arrowPoint.y, arrowAngle + (reverseArrow ? Math.PI : 0));
}

function drawOuterRadialLines(cx, cy, r, count, outward = true) {
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count;
    const start = circlePoint(cx, cy, r, angle, 0.006);
    const end = circlePoint(cx, cy, r, angle, 0.066);
    drawStraight(outward ? start : end, outward ? end : start);
  }
}

function drawStraight(start, end) {
  ctx.beginPath();
  ctx.moveTo(sx(start.x), sy(start.y));
  ctx.lineTo(sx(end.x), sy(end.y));
  ctx.stroke();
  const t = 0.78;
  const x = start.x + (end.x - start.x) * t;
  const y = start.y + (end.y - start.y) * t;
  const angle = Math.atan2(sy(end.y) - sy(start.y), sx(end.x) - sx(start.x));
  drawArrowhead(x, y, angle);
}

function drawCubic(start, c1, c2, end, forward = true) {
  ctx.beginPath();
  ctx.moveTo(sx(start.x), sy(start.y));
  ctx.bezierCurveTo(sx(c1.x), sy(c1.y), sx(c2.x), sy(c2.y), sx(end.x), sy(end.y));
  ctx.stroke();
  const t = 0.78;
  const mt = 1 - t;
  const x = mt ** 3 * start.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * end.x;
  const y = mt ** 3 * start.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * end.y;
  const dx = 3 * mt ** 2 * (c1.x - start.x) + 6 * mt * t * (c2.x - c1.x) + 3 * t ** 2 * (end.x - c2.x);
  const dy = 3 * mt ** 2 * (c1.y - start.y) + 6 * mt * t * (c2.y - c1.y) + 3 * t ** 2 * (end.y - c2.y);
  drawArrowhead(x, y, Math.atan2(dy, dx) + (forward ? 0 : Math.PI));
}

function drawArrowhead(x, y, angle) {
  const size = 9;
  ctx.save();
  ctx.translate(sx(x), sy(y));
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.55, -size * 0.55);
  ctx.lineTo(-size * 0.55, size * 0.55);
  ctx.closePath();
  ctx.fillStyle = "rgba(33, 101, 126, 0.52)";
  ctx.fill();
  ctx.restore();
}

function drawLabels() {
  if (state.prediction) {
    drawBadge(0.5, 0.1, "预测：先判断电荷分布与 E=0 区域", "#7a4b00");
    return;
  }
  if (state.scene === "solid") {
    drawBadge(0.56, 0.5, "导体内部 E = 0", "#334155");
  } else if (state.scene === "shield") {
    drawBadge(0.56, 0.5, "空腔内不受外部静电场影响", "#334155");
    drawBadge(0.56, 0.29, "外表面重新分布", "#334155");
  } else if (state.scene === "cavity") {
    drawBadge(0.56, 0.28, "导体材料内部 E = 0", "#334155");
    drawBadge(0.56, 0.69, "内表面：异号感应电荷", "#334155");
  } else {
    drawBadge(0.74, 0.42, "尖端附近电场更强", "#334155");
  }
}

function drawBadge(x, y, text, color) {
  ctx.save();
  ctx.font = "700 24px sans-serif";
  const paddingX = 14;
  const metrics = ctx.measureText(text);
  const w = metrics.width + paddingX * 2;
  const h = 42;
  const px = sx(x) - w / 2;
  const py = sy(y) - h / 2;
  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.strokeStyle = "rgba(139, 152, 162, 0.42)";
  ctx.lineWidth = 1;
  ctx.fillRect(px, py, w, h);
  ctx.strokeRect(px, py, w, h);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, sx(x), sy(y) + 1);
  ctx.restore();
}

function pointerToCanvas(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  };
}

function isNearCharge(point) {
  const dx = point.x - state.charge.x;
  const dy = point.y - state.charge.y;
  return Math.hypot(dx, dy) < 0.055;
}

canvas.addEventListener("pointerdown", (event) => {
  const point = pointerToCanvas(event);
  if (isNearCharge(point)) {
    state.dragging = true;
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.dragging) return;
  const point = pointerToCanvas(event);
  const constrained = constrainCharge(point);
  state.charge.x = constrained.x;
  state.charge.y = constrained.y;
  requestDraw();
});

canvas.addEventListener("pointerup", () => {
  state.dragging = false;
  requestDraw();
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => setScene(button.dataset.scene));
});

els.modeToggle.addEventListener("click", () => {
  state.prediction = !state.prediction;
  updateText();
  draw();
});

els.showCharges.addEventListener("change", () => {
  state.showCharges = els.showCharges.checked;
  draw();
});

els.showLines.addEventListener("change", () => {
  state.showLines = els.showLines.checked;
  draw();
});

els.showLabels.addEventListener("change", () => {
  state.showLabels = els.showLabels.checked;
  draw();
});

els.positiveBtn.addEventListener("click", () => {
  state.chargeSign = 1;
  els.positiveBtn.classList.add("active");
  els.negativeBtn.classList.remove("active");
  updateText();
  draw();
});

els.negativeBtn.addEventListener("click", () => {
  state.chargeSign = -1;
  els.negativeBtn.classList.add("active");
  els.positiveBtn.classList.remove("active");
  updateText();
  draw();
});

document.querySelector("#resetBtn").addEventListener("click", () => setScene(state.scene));

function constrainCharge(point) {
  if (state.scene === "cavity") {
    const cx = 0.56;
    const cy = 0.5;
    const rx = 0.086;
    const ry = nxToNyRadius(rx);
    const dx = point.x - cx;
    const dy = point.y - cy;
    const ratio = Math.hypot(dx / rx, dy / ry);
    if (ratio <= 1) return { x: point.x, y: point.y };
    return {
      x: cx + dx / ratio,
      y: cy + dy / ratio
    };
  }
  if (state.scene === "solid" || state.scene === "shield") {
    const cx = 0.56;
    const cy = 0.5;
    const outer = state.scene === "solid" ? 0.2 : 0.24;
    const margin = 0.055;
    const pp = toPhys(point);
    const cp = toPhys({ x: cx, y: cy });
    const dx = pp.x - cp.x;
    const dy = pp.y - cp.y;
    const dist = Math.hypot(dx, dy);
    const minDist = outer + margin;
    if (dist < minDist) {
      const angle = Math.atan2(dy, dx || -1);
      return fromPhys({
        x: cp.x + Math.cos(angle) * minDist,
        y: cp.y + Math.sin(angle) * minDist
      });
    }
  }
  return {
    x: clamp(point.x, 0.04, 0.96),
    y: clamp(point.y, 0.08, 0.92)
  };
}

const initialScene = ["solid", "shield", "cavity", "tip"].includes(location.hash.slice(1))
  ? location.hash.slice(1)
  : state.scene;
setScene(initialScene);

const params = new URLSearchParams(location.search);
if (params.get("sign") === "-1") {
  state.chargeSign = -1;
  els.negativeBtn.classList.add("active");
  els.positiveBtn.classList.remove("active");
  updateText();
  draw();
}
const queryX = Number(params.get("x"));
const queryY = Number(params.get("y"));
if (params.has("x") && params.has("y") && Number.isFinite(queryX) && Number.isFinite(queryY)) {
  state.charge = constrainCharge({ x: queryX, y: queryY });
  draw();
}
