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

const surfaceChargeScales = {
  solid: 0.065,
  shield: 0.07,
  cavity: 0.095
};

const sceneMeta = {
  solid: {
    title: "实心导体靠近外部电荷",
    lead: "拖动点电荷，观察导体表面电荷重新分布与内部电场为零。",
    question: "如果外部正电荷靠近导体左侧，导体左、右两侧分别会出现什么电荷？导体内部还有电场吗？"
  },
  charged: {
    title: "带电球形导体：无外电场",
    lead: "观察孤立带电球形导体的高对称情形：电荷均匀分布在外表面，球内电场为零。",
    question: "没有外部电场时，为什么球形导体表面电荷可以均匀分布？球内部为什么没有电场？"
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
    lead: "通过边界元求解尖端导体表面电荷，观察尖端附近电荷密度和电场强度的增强。",
    question: "为什么避雷针和尖端放电都和“尖端附近电场更强”有关？"
  },
  dumbbell: {
    title: "哑铃形导体：两个相连球形导体",
    lead: "观察两个并排相连的圆钝导体，比较外侧凸起和连接区域的表面电荷密度。",
    question: "两个球形导体连成同一个等势体后，表面电荷会更集中在哪些外轮廓位置？"
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
    const normalSign = role === "inner" ? -1 : 1;
    points.push({
      ...circlePoint(cx, cy, r, angle),
      cx,
      cy,
      r,
      angle,
      role,
      nx: Math.cos(angle) * normalSign,
      ny: Math.sin(angle) * normalSign,
      order: i,
      segment: (Math.PI * 2 * r) / count
    });
  }
  return points;
}

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y
  };
}

function makePolygonBoundary(points, role = "outer") {
  const centroid = points.reduce((sum, point) => ({
    x: sum.x + point.x / points.length,
    y: sum.y + point.y / points.length
  }), { x: 0, y: 0 });
  return points.map((point, index) => {
    const prev = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const pp = toPhys(prev);
    const np = toPhys(next);
    const cp = toPhys(point);
    const tangent = { x: np.x - pp.x, y: np.y - pp.y };
    const candidates = [
      { x: -tangent.y, y: tangent.x },
      { x: tangent.y, y: -tangent.x }
    ];
    const away = { x: cp.x - toPhys(centroid).x, y: cp.y - toPhys(centroid).y };
    const selected = candidates[0].x * away.x + candidates[0].y * away.y >
      candidates[1].x * away.x + candidates[1].y * away.y
      ? candidates[0]
      : candidates[1];
    const len = Math.hypot(selected.x, selected.y) || 1;
    return {
      ...point,
      role,
      nx: selected.x / len,
      ny: selected.y / len,
      order: index,
      segment: (physDistance(point, prev) + physDistance(point, next)) / 2
    };
  });
}

function makeTipBoundary() {
  const upper = [
    { x: 0.72, y: 0.5 },
    { x: 0.56, y: 0.29 },
    { x: 0.36, y: 0.31 },
    { x: 0.34, y: 0.5 }
  ];
  const lower = [
    { x: 0.34, y: 0.5 },
    { x: 0.36, y: 0.69 },
    { x: 0.56, y: 0.71 },
    { x: 0.72, y: 0.5 }
  ];
  const points = [];
  const count = 52;
  for (let i = 0; i < count; i += 1) {
    points.push(cubicPoint(upper[0], upper[1], upper[2], upper[3], i / count));
  }
  for (let i = 0; i < count; i += 1) {
    points.push(cubicPoint(lower[0], lower[1], lower[2], lower[3], i / count));
  }
  return makePolygonBoundary(points, "outer");
}

function makeDumbbellBoundary() {
  const left = { x: 0.45, y: 0.5, r: 0.17 };
  const right = { x: 0.65, y: 0.5, r: 0.17 };
  const joinAngle = Math.acos((right.x - left.x) / (2 * left.r));
  const points = [];
  const perArc = 56;
  for (let i = 0; i < perArc; i += 1) {
    const t = i / perArc;
    const angle = joinAngle + (Math.PI * 2 - joinAngle * 2) * t;
    points.push(circlePoint(left.x, left.y, left.r, angle));
  }
  for (let i = 0; i < perArc; i += 1) {
    const t = i / perArc;
    const angle = Math.PI + joinAngle + (Math.PI * 2 - joinAngle * 2) * t;
    points.push(circlePoint(right.x, right.y, right.r, angle));
  }
  return makePolygonBoundary(points, "outer");
}

function makeBemGeometry() {
  if (state.scene === "solid") {
    return {
      boundaries: makeBoundaryCircle(0.56, 0.5, 0.2, 56, "outer"),
      conductors: [{ cx: 0.56, cy: 0.5, inner: 0, outer: 0.2, type: "solid" }],
      netCharge: 0
    };
  }
  if (state.scene === "charged") {
    return {
      boundaries: makeBoundaryCircle(0.56, 0.5, 0.2, 72, "outer"),
      conductors: [{ cx: 0.56, cy: 0.5, inner: 0, outer: 0.2, type: "solid" }],
      netCharge: state.chargeSign
    };
  }
  if (state.scene === "shield" || state.scene === "cavity") {
    return {
      boundaries: [
        ...makeBoundaryCircle(0.56, 0.5, 0.24, 60, "outer"),
        ...makeBoundaryCircle(0.56, 0.5, 0.112, 40, "inner")
      ],
      conductors: [{ cx: 0.56, cy: 0.5, inner: 0.112, outer: 0.24, type: "shell" }],
      netCharge: 0
    };
  }
  if (state.scene === "tip") {
    const boundaries = makeTipBoundary();
    return {
      boundaries,
      conductors: [{ type: "polygon", polygon: boundaries.map(({ x, y }) => ({ x, y })) }],
      netCharge: state.chargeSign
    };
  }
  if (state.scene === "dumbbell") {
    const boundaries = makeDumbbellBoundary();
    return {
      boundaries,
      conductors: [{ type: "polygon", polygon: boundaries.map(({ x, y }) => ({ x, y })) }],
      netCharge: state.chargeSign
    };
  }
  throw new Error(`Unknown scene: ${state.scene}`);
}

function sourceCharges() {
  if (["charged", "tip", "dumbbell"].includes(state.scene)) return [];
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
  vector[n] = geometry.netCharge;

  const solved = solveLinearSystem(matrix, vector);
  const charges = applyPhysicalChargeCorrections(boundaries, solved.slice(0, n));
  const conductorPotential = solved[n];
  const solution = { boundaries, charges, conductorPotential, sources, geometry, netCharge: geometry.netCharge };
  bemCache.key = key;
  bemCache.solution = solution;
  return solution;
}

function applyPhysicalChargeCorrections(boundaries, charges) {
  const corrected = [...charges];
  if (state.scene === "shield") {
    boundaries.forEach((boundary, index) => {
      if (boundary.role === "inner") corrected[index] = 0;
    });
  }
  if (state.scene === "cavity") {
    const outerIndices = boundaries
      .map((boundary, index) => boundary.role === "outer" ? index : -1)
      .filter(index => index >= 0);
    const outerMean = outerIndices.reduce((sum, index) => sum + corrected[index], 0) / outerIndices.length;
    outerIndices.forEach((index) => {
      corrected[index] = outerMean;
    });
  }
  return corrected;
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
  if (conductor.type === "polygon") return pointInPolygon(point, conductor.polygon);
  const center = { x: conductor.cx, y: conductor.cy };
  const d = physDistance(point, center);
  if (conductor.type === "solid") return d < conductor.outer;
  return d > conductor.inner && d < conductor.outer;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects = ((pi.y > point.y) !== (pj.y > point.y)) &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / ((pj.y - pi.y) || 1e-9) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function setScene(scene) {
  state.scene = scene;
  if (location.hash.slice(1) !== scene) {
    history.replaceState(null, "", `#${scene}`);
  }
  if (scene === "cavity") state.charge = { x: 0.5, y: 0.48 };
  if (scene === "charged") state.charge = { x: 0.56, y: 0.5 };
  if (scene === "tip" || scene === "dumbbell") state.charge = { x: 0.26, y: 0.5 };
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
    charged: `当前孤立球形导体带${signWord}。由于球面对称，净电荷均匀分布在外表面，内部合电场为零。`,
    shield: `当前外部${signWord}靠近带空腔导体。模型区分导体材料内部 E=0 与空腔区域是否受影响。`,
    cavity: `当前${signWord}位于空腔内。内表面出现异号感应电荷，分布随电荷位置连续改变。`,
    tip: "当前为尖端导体边界元求解模型，表面电荷与电场线均由等势边界条件和净电荷约束计算得到。",
    dumbbell: "当前为哑铃形导体边界元求解模型，用两个相连球形导体对比外侧凸起和连接区域的表面电荷密度差异。"
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
  if (state.scene === "charged") {
    return ["球面对称使表面电荷均匀分布。", "导体内部保持 E=0。", "外部电场线沿半径方向分布。"];
  }
  if (state.scene === "shield") {
    return ["外部电荷只改变外表面分布。", "空腔内部不出现外部电场线。", "导体材料内部保持 E=0。"];
  }
  if (state.scene === "tip") {
    return ["尖端附近求解出的电荷点更密。", "电场线由合电场积分追踪。", "导体边界满足等势条件。"];
  }
  if (state.scene === "dumbbell") {
    return ["外侧凸起处电荷较密。", "两球连接附近电荷较少。", "整体仍是同一个等势导体。"];
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
    const solution = getBemSolution();
    advanceVisualState(solution);
    clearCanvas();
    if (!state.prediction && state.showLines) drawFieldLines();
    drawConductor();
    if (!state.prediction && state.showCharges) drawSurfaceCharges();
    if (hasPointCharge()) drawPointCharge();
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
  const items = [];
  if (state.scene === "solid") {
    items.push(`边界等势最大误差：${maxError.toExponential(2)}`);
    items.push(`导体净电荷约束：${total.toExponential(2)}`);
  } else if (state.scene === "shield") {
    const innerMax = Math.max(...solution.charges.map((value, index) => (
      solution.boundaries[index].role === "inner" ? Math.abs(value) : 0
    )));
    items.push(`屏蔽约束：内表面最大电荷 ${innerMax.toExponential(2)}`);
    items.push(`导体净电荷约束：${total.toExponential(2)}`);
  } else if (state.scene === "cavity") {
    const outerCharges = solution.charges.filter((value, index) => solution.boundaries[index].role === "outer");
    const outerMean = outerCharges.reduce((sum, value) => sum + value, 0) / outerCharges.length;
    const outerDeviation = Math.max(...outerCharges.map(value => Math.abs(value - outerMean)));
    items.push(`外表面均匀偏差：${outerDeviation.toExponential(2)}`);
    items.push(`导体净电荷约束：${total.toExponential(2)}`);
  } else {
    items.push(`边界等势最大误差：${maxError.toExponential(2)}`);
    items.push(`导体净电荷：${total.toFixed(3)}`);
  }
  items.push(`求解与绘制耗时：${elapsedMs.toFixed(1)} ms`);
  if (state.scene === "shield" || state.scene === "cavity") {
    items.push(`外表面总电荷：${outer.toFixed(3)}`);
    items.push(`内表面总电荷：${inner.toFixed(3)}`);
  }
  renderList(els.physicsChecks, items);
}

function drawConductor() {
  if (state.scene === "solid" || state.scene === "charged") {
    drawDisk(0.56, 0.5, 0.2);
  } else if (state.scene === "shield" || state.scene === "cavity") {
    drawShell();
  } else if (state.scene === "dumbbell") {
    drawDumbbellConductor();
  } else {
    drawPolygonConductor(getBemSolution().geometry.conductors[0].polygon);
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

function drawDumbbellConductor() {
  drawPolygonConductor(getBemSolution().geometry.conductors[0].polygon);
}

function drawPolygonConductor(points) {
  ctx.save();
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const grad = ctx.createLinearGradient(sx(Math.min(...xs)), sy(Math.min(...ys)), sx(Math.max(...xs)), sy(Math.max(...ys)));
  grad.addColorStop(0, "#f2f6f8");
  grad.addColorStop(0.62, "#d9e1e6");
  grad.addColorStop(1, "#c4ced6");
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(sx(point.x), sy(point.y));
    else ctx.lineTo(sx(point.x), sy(point.y));
  });
  ctx.closePath();
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
  drawBemSurfaceCharges();
}

function drawBemSurfaceCharges() {
  const solution = getBemSolution();
  const charges = visualState.charges.length === solution.charges.length ? visualState.charges : solution.charges;
  const scale = surfaceChargeScales[state.scene] || Math.max(...solution.charges.map(charge => Math.abs(charge)), 1e-6);
  solution.boundaries.forEach((boundary, index) => {
    const q = charges[index];
    const strength = clamp(Math.abs(q) / scale, 0, 1.15);
    if (strength < 0.055) return;
    const point = offsetBoundaryPoint(boundary, 0.009);
    drawSurfaceDot(point.x, point.y, q > 0 ? 1 : -1, 2.4 + strength * 6.2);
  });
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
  const lineAlpha = 0.34 + visualState.fieldLineAlpha * 0.42;
  ctx.globalAlpha = lineAlpha;
  ctx.strokeStyle = "rgba(31, 97, 125, 0.55)";
  ctx.lineWidth = 1.65;
  ctx.lineCap = "round";
  drawBemFieldLines();
  ctx.restore();
}

function drawBemFieldLines() {
  const solution = getBemSolution();
  const lineSolution = makeLineSolution(solution);
  const reverseArrows = fieldDirectionSign(solution) < 0;
  const seeds = makeFieldSeeds(lineSolution);
  if (hasAxisymmetricBoundarySeeds() && solution.sources.length) {
    drawSymmetricFieldPaths(seeds, lineSolution, reverseArrows);
  } else {
    seeds.forEach(seed => traceFieldLine(seed.point, lineSolution, seed.direction, reverseArrows));
  }
}

function drawSymmetricFieldPaths(seeds, solution, reverseArrows) {
  const axis = pixelAngle(0.56, 0.5, state.charge);
  const epsilon = 0.0008;
  seeds.forEach((seed) => {
    const side = sideOfAxis(seed.point, axis);
    if (side < -epsilon) return;
    const path = traceFieldPath(seed.point, solution, seed.direction);
    if (side <= epsilon) {
      drawFieldPath(path.map(point => projectOntoAxis(point, axis)), reverseArrows);
    } else {
      drawFieldPath(path, reverseArrows);
      drawFieldPath(path.map(point => reflectAcrossAxis(point, axis)), reverseArrows);
    }
  });
}

function makeLineSolution(solution) {
  const sign = fieldDirectionSign(solution);
  if (sign > 0) return solution;
  return {
    ...solution,
    sources: solution.sources.map(source => ({ ...source, q: source.q * sign })),
    charges: solution.charges.map(charge => charge * sign)
  };
}

function fieldDirectionSign(solution) {
  if (solution.sources.length) return solution.sources[0].q < 0 ? -1 : 1;
  return solution.netCharge < 0 ? -1 : 1;
}

function makeFieldSeeds(solution) {
  const seeds = [];
  const source = solution.sources[0] || { q: 0 };
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

  const boundaryBudget = Math.min(fieldLineConfig.maxBoundaryLines, Math.max(0, lineBudget - seeds.length));
  seeds.push(...makeBoundaryFluxSeeds(solution, boundaryBudget));

  return seeds.slice(0, lineBudget);
}

function makeBoundaryFluxSeeds(solution, budget) {
  if (budget <= 0) return [];
  if (hasAxisymmetricBoundarySeeds()) return makeSymmetricBoundaryFluxSeeds(solution, budget);
  const entries = solution.boundaries
    .map((boundary, index) => ({ boundary, flux: Math.max(0, solution.charges[index]) }))
    .filter(entry => entry.flux > 0)
    .sort((a, b) => a.boundary.order - b.boundary.order);
  const totalFlux = entries.reduce((sum, entry) => sum + entry.flux, 0);
  if (totalFlux <= 0 || !entries.length) return [];
  const seeds = [];
  let cursor = 0;
  let accumulated = entries[0].flux;
  for (let i = 0; i < budget; i += 1) {
    const target = ((i + 0.5) / budget) * totalFlux;
    while (cursor < entries.length - 1 && accumulated < target) {
      cursor += 1;
      accumulated += entries[cursor].flux;
    }
    seeds.push({
      point: offsetBoundaryPoint(entries[cursor].boundary, 0.022),
      direction: 1
    });
  }
  return seeds;
}

function hasAxisymmetricBoundarySeeds() {
  return ["solid", "shield", "cavity"].includes(state.scene);
}

function makeSymmetricBoundaryFluxSeeds(solution, budget) {
  const center = { x: 0.56, y: 0.5 };
  const axisAngle = pixelAngle(center.x, center.y, state.charge);
  const roles = ["outer", "inner"]
    .map(role => makeSymmetricRoleSeedPlan(solution, role, axisAngle))
    .filter(plan => plan && plan.flux > 0)
    .sort((a, b) => b.flux - a.flux);
  if (!roles.length) return [];
  const seeds = [];
  let remaining = budget;
  const totalFlux = roles.reduce((sum, role) => sum + role.flux, 0);
  roles.forEach((role, index) => {
    const target = index === roles.length - 1
      ? remaining
      : Math.max(0, Math.round((role.flux / totalFlux) * budget));
    const count = Math.min(remaining, target);
    seeds.push(...makeSymmetricRoleSeeds(role, count));
    remaining = budget - seeds.length;
  });
  return seeds
    .sort((a, b) => angularDistance(pixelAngle(0.56, 0.5, a.point), axisAngle) - angularDistance(pixelAngle(0.56, 0.5, b.point), axisAngle))
    .slice(0, budget);
}

function makeSymmetricRoleSeedPlan(solution, role, axisAngle) {
  const entries = solution.boundaries
    .map((boundary, index) => ({ boundary, index, flux: Math.max(0, solution.charges[index]) }))
    .filter(entry => entry.boundary.role === role && entry.flux > 0);
  if (!entries.length) return null;
  const flux = entries.reduce((sum, entry) => sum + entry.flux, 0);
  const strongest = entries.reduce((best, entry) => entry.flux > best.flux ? entry : best, entries[0]);
  const oppositeAxis = normalizeAngle(axisAngle + Math.PI);
  const centerAngle = angularDistance(strongest.boundary.angle, axisAngle) <= angularDistance(strongest.boundary.angle, oppositeAxis)
    ? axisAngle
    : oppositeAxis;
  return {
    role,
    flux,
    centerAngle,
    template: entries[0].boundary
  };
}

function makeSymmetricRoleSeeds(plan, requestedCount) {
  if (requestedCount <= 0) return [];
  const seeds = [makeBoundarySeedAtAngle(plan.template, plan.centerAngle)];
  const pairCount = Math.floor((requestedCount - 1) / 2);
  const spread = Math.PI * 0.62;
  for (let i = 1; i <= pairCount; i += 1) {
    const delta = (spread * i) / (pairCount + 0.5);
    seeds.push(makeBoundarySeedAtAngle(plan.template, plan.centerAngle + delta));
    seeds.push(makeBoundarySeedAtAngle(plan.template, plan.centerAngle - delta));
  }
  return seeds;
}

function makeBoundarySeedAtAngle(boundary, angle) {
  const outward = boundary.role === "outer" ? 1 : -1;
  const offset = boundary.role === "outer" ? 0.02 : -0.014;
  return {
    point: circlePoint(boundary.cx, boundary.cy, boundary.r, angle, offset),
    direction: outward
  };
}

function offsetBoundaryPoint(boundary, offset) {
  if (boundary.cx !== undefined && boundary.r !== undefined && boundary.angle !== undefined) {
    const signedOffset = boundary.role === "inner" ? -offset : offset;
    return circlePoint(boundary.cx, boundary.cy, boundary.r, boundary.angle, signedOffset);
  }
  const p = toPhys(boundary);
  return fromPhys({
    x: p.x + boundary.nx * offset,
    y: p.y + boundary.ny * offset
  });
}

function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

function angularDistance(a, b) {
  const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(diff, Math.PI * 2 - diff);
}

function traceFieldLine(seed, solution, direction, reverseArrow = false) {
  drawFieldPath(traceFieldPath(seed, solution, direction), reverseArrow);
}

function traceFieldPath(seed, solution, direction) {
  let point = { ...seed };
  const path = [point];
  let last = point;
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
    path.push(next);
    last = next;
    point = next;
    if (solution.sources.some(source => physDistance(point, source) < 0.018)) break;
  }
  return path;
}

function drawFieldPath(path, reverseArrow = false) {
  if (path.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(sx(path[0].x), sy(path[0].y));
  for (let i = 1; i < path.length; i += 1) {
    ctx.lineTo(sx(path[i].x), sy(path[i].y));
  }
  ctx.stroke();
  const arrowIndex = Math.min(28, path.length - 1);
  if (arrowIndex < 1) return;
  const arrowPoint = path[arrowIndex];
  const before = path[arrowIndex - 1];
  const arrowAngle = Math.atan2(sy(arrowPoint.y) - sy(before.y), sx(arrowPoint.x) - sx(before.x));
  drawArrowhead(arrowPoint.x, arrowPoint.y, arrowAngle + (reverseArrow ? Math.PI : 0));
}

function sideOfAxis(point, axisAngle) {
  const origin = { x: sx(0.56), y: sy(0.5) };
  const px = sx(point.x) - origin.x;
  const py = sy(point.y) - origin.y;
  return Math.cos(axisAngle) * py - Math.sin(axisAngle) * px;
}

function reflectAcrossAxis(point, axisAngle) {
  const origin = { x: sx(0.56), y: sy(0.5) };
  const px = sx(point.x) - origin.x;
  const py = sy(point.y) - origin.y;
  const ux = Math.cos(axisAngle);
  const uy = Math.sin(axisAngle);
  const projection = px * ux + py * uy;
  const rx = 2 * projection * ux - px;
  const ry = 2 * projection * uy - py;
  return {
    x: (origin.x + rx) / canvas.width,
    y: (origin.y + ry) / canvas.height
  };
}

function projectOntoAxis(point, axisAngle) {
  const origin = { x: sx(0.56), y: sy(0.5) };
  const px = sx(point.x) - origin.x;
  const py = sy(point.y) - origin.y;
  const ux = Math.cos(axisAngle);
  const uy = Math.sin(axisAngle);
  const projection = px * ux + py * uy;
  return {
    x: (origin.x + projection * ux) / canvas.width,
    y: (origin.y + projection * uy) / canvas.height
  };
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
  } else if (state.scene === "charged") {
    drawBadge(0.56, 0.5, "球内 E = 0", "#334155");
    drawBadge(0.56, 0.25, "表面电荷均匀分布", "#334155");
  } else if (state.scene === "shield") {
    drawBadge(0.56, 0.5, "空腔内不受外部静电场影响", "#334155");
    drawBadge(0.56, 0.29, "外表面重新分布", "#334155");
  } else if (state.scene === "cavity") {
    drawBadge(0.56, 0.28, "导体材料内部 E = 0", "#334155");
    drawBadge(0.56, 0.69, "内表面：异号感应电荷", "#334155");
  } else if (state.scene === "tip") {
    drawBadge(0.76, 0.42, "尖端附近电场更强", "#334155");
    drawBadge(0.5, 0.68, "同一导体表面电荷不均匀", "#334155");
  } else if (state.scene === "dumbbell") {
    drawBadge(0.31, 0.42, "左侧外凸面", "#334155");
    drawBadge(0.74, 0.42, "右侧外凸面", "#334155");
    drawBadge(0.55, 0.66, "相连等势整体", "#334155");
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
  if (!hasPointCharge()) return false;
  const dx = point.x - state.charge.x;
  const dy = point.y - state.charge.y;
  return Math.hypot(dx, dy) < 0.055;
}

function hasPointCharge() {
  return state.scene === "solid" || state.scene === "shield" || state.scene === "cavity";
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
  if (state.scene === "charged") {
    return { x: 0.56, y: 0.5 };
  }
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

const initialScene = ["solid", "charged", "shield", "cavity", "tip", "dumbbell"].includes(location.hash.slice(1))
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
