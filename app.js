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
    lead: "观察尖端附近电荷更密、电场线更密的定性模型。",
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
  const charges = applyPhysicalChargeCorrections(boundaries, solved.slice(0, n));
  const conductorPotential = solved[n];
  const solution = { boundaries, charges, conductorPotential, sources, geometry };
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
    tip: "当前为尖端效应定性模型，用于展示尖端附近电荷密度更高、电场更强。",
    dumbbell: "当前为哑铃形导体定性模型，用两个相连球形导体对比外侧凸起和连接区域的表面电荷密度差异。"
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
    return ["尖端附近电荷点更密。", "电场线在尖端附近更集中。", "该场景用于定性解释尖端效应。"];
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
    let solution = null;
    if (["solid", "shield", "cavity"].includes(state.scene)) {
      solution = getBemSolution();
      advanceVisualState(solution);
    }
    clearCanvas();
    if (!state.prediction && state.showLines) drawFieldLines();
    drawConductor();
    if (!state.prediction && state.showCharges) drawSurfaceCharges();
    if (!["charged", "tip", "dumbbell"].includes(state.scene)) drawPointCharge();
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
    const items = state.scene === "charged"
      ? ["高对称解析图像：球面等势。", "表面电荷密度均匀。", "导体内部 E = 0。"]
      : ["当前场景使用定性复杂导体模型。", "重点展示曲率、凸起与电场强弱关系。"];
    renderList(els.physicsChecks, items);
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
  }
  items.push(`求解与绘制耗时：${elapsedMs.toFixed(1)} ms`);
  if (state.scene !== "solid") {
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

function drawDumbbellConductor() {
  ctx.save();
  const left = { x: 0.45, y: 0.5, r: 0.17 };
  const right = { x: 0.65, y: 0.5, r: 0.17 };
  const joinAngle = Math.acos((right.x - left.x) / (2 * left.r));
  const grad = ctx.createLinearGradient(sx(0.28), sy(0.36), sx(0.82), sy(0.5));
  grad.addColorStop(0, "#f2f6f8");
  grad.addColorStop(0.62, "#d9e1e6");
  grad.addColorStop(1, "#c4ced6");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sx(left.x), sy(left.y), sx(left.r), 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(sx(right.x), sy(right.y), sx(right.r), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#7f8e99";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(sx(left.x), sy(left.y), sx(left.r), joinAngle, Math.PI * 2 - joinAngle);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx(right.x), sy(right.y), sx(right.r), Math.PI + joinAngle, Math.PI - joinAngle);
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
  } else if (state.scene === "charged") {
    drawChargedSphereCharges();
  } else if (state.scene === "dumbbell") {
    drawDumbbellCharges();
  } else {
    drawTipCharges();
  }
}

function drawChargedSphereCharges() {
  const count = 36;
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count;
    const point = circlePoint(0.56, 0.5, 0.2, angle, 0.009);
    drawSurfaceDot(point.x, point.y, state.chargeSign, 4.6);
  }
}

function drawBemSurfaceCharges() {
  const solution = getBemSolution();
  const charges = visualState.charges.length === solution.charges.length ? visualState.charges : solution.charges;
  const scale = surfaceChargeScales[state.scene] || Math.max(...solution.charges.map(charge => Math.abs(charge)), 1e-6);
  solution.boundaries.forEach((boundary, index) => {
    const q = charges[index];
    const strength = clamp(Math.abs(q) / scale, 0, 1.15);
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
    [0.705, 0.5, 1.85], [0.682, 0.47, 1.48], [0.682, 0.53, 1.48],
    [0.646, 0.435, 1.12], [0.646, 0.565, 1.12],
    [0.59, 0.385, 0.78], [0.59, 0.615, 0.78],
    [0.515, 0.345, 0.58], [0.515, 0.655, 0.58],
    [0.435, 0.355, 0.46], [0.435, 0.645, 0.46],
    [0.36, 0.45, 0.42], [0.36, 0.55, 0.42]
  ];
  points.forEach(([x, y, size]) => drawSurfaceDot(x, y, state.chargeSign, 4 + size * 3.2));
}

function drawDumbbellCharges() {
  const left = { x: 0.45, y: 0.5, r: 0.17 };
  const right = { x: 0.65, y: 0.5, r: 0.17 };
  const joinAngle = Math.acos((right.x - left.x) / (2 * left.r));
  const seamGap = 0.075;
  const drawArcCharges = (center, start, end, densityFn) => {
    const count = 17;
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0 : i / (count - 1);
      const angle = start + (end - start) * t;
      const p = circlePoint(center.x, center.y, center.r, angle, 0.009);
      const density = densityFn(angle);
      drawSurfaceDot(p.x, p.y, state.chargeSign, 3.2 + density * 4.6);
    }
  };
  drawArcCharges(left, joinAngle + seamGap, Math.PI * 2 - joinAngle - seamGap, angle => 0.28 + 0.85 * Math.max(0, -Math.cos(angle)));
  drawArcCharges(right, -Math.PI + joinAngle + seamGap, Math.PI - joinAngle - seamGap, angle => 0.28 + 0.85 * Math.max(0, Math.cos(angle)));
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
  } else if (state.scene === "charged") {
    drawChargedSphereFieldLines();
  } else if (state.scene === "dumbbell") {
    drawDumbbellFieldLines();
  } else {
    drawTipFieldLines();
  }
  ctx.restore();
}

function drawChargedSphereFieldLines() {
  const outward = state.chargeSign > 0;
  const count = 18;
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count;
    const start = circlePoint(0.56, 0.5, 0.2, angle, 0.016);
    const end = circlePoint(0.56, 0.5, 0.2, angle, 0.19);
    drawStraight(outward ? start : end, outward ? end : start);
  }
}

function drawTipFieldLines() {
  const outward = state.chargeSign > 0;
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
  const lines = [
    { curve: upper, t: 0.025, length: 0.34 },
    { curve: upper, t: 0.08, length: 0.32 },
    { curve: upper, t: 0.18, length: 0.29 },
    { curve: upper, t: 0.36, length: 0.25 },
    { curve: upper, t: 0.68, length: 0.21 },
    { curve: lower, t: 0.975, length: 0.34 },
    { curve: lower, t: 0.92, length: 0.32 },
    { curve: lower, t: 0.82, length: 0.29 },
    { curve: lower, t: 0.64, length: 0.25 },
    { curve: lower, t: 0.32, length: 0.21 }
  ];
  lines.forEach(({ curve, t, length }) => drawNormalFieldLine(curve, t, length, outward));
  drawCubic(
    { x: 0.72, y: 0.5 },
    { x: 0.83, y: 0.5 },
    { x: 0.94, y: 0.5 },
    { x: 1.03, y: 0.5 },
    outward
  );
}

function drawDumbbellFieldLines() {
  const outward = state.chargeSign > 0;
  const lines = [
    { center: { x: 0.45, y: 0.5 }, r: 0.17, angle: Math.PI, length: 0.34 },
    { center: { x: 0.45, y: 0.5 }, r: 0.17, angle: Math.PI * 0.78, length: 0.31 },
    { center: { x: 0.45, y: 0.5 }, r: 0.17, angle: -Math.PI * 0.78, length: 0.31 },
    { center: { x: 0.45, y: 0.5 }, r: 0.17, angle: Math.PI * 0.58, length: 0.27 },
    { center: { x: 0.45, y: 0.5 }, r: 0.17, angle: -Math.PI * 0.58, length: 0.27 },
    { center: { x: 0.65, y: 0.5 }, r: 0.17, angle: 0, length: 0.34 },
    { center: { x: 0.65, y: 0.5 }, r: 0.17, angle: Math.PI * 0.22, length: 0.31 },
    { center: { x: 0.65, y: 0.5 }, r: 0.17, angle: -Math.PI * 0.22, length: 0.31 },
    { center: { x: 0.65, y: 0.5 }, r: 0.17, angle: Math.PI * 0.42, length: 0.27 },
    { center: { x: 0.65, y: 0.5 }, r: 0.17, angle: -Math.PI * 0.42, length: 0.27 }
  ];
  lines.forEach(({ center, r, angle, length }) => {
    const start = circlePoint(center.x, center.y, r, angle, 0.014);
    const end = circlePoint(center.x, center.y, r, angle, length);
    const c1 = circlePoint(center.x, center.y, r, angle, 0.09);
    const c2 = circlePoint(center.x, center.y, r, angle, length * 0.72);
    drawCubic(start, c1, c2, end, outward);
  });
}

function drawNormalFieldLine(curve, t, length, outward) {
  const start = cubicPointOnCurve(curve, t);
  const tangent = cubicTangentOnCurve(curve, t);
  const normal = outwardPixelNormal(start, tangent);
  const pixelLength = length * canvas.width;
  const c1 = movePointByPixelVector(start, normal, 30);
  const c2 = movePointByPixelVector(start, normal, pixelLength * 0.72);
  const end = movePointByPixelVector(start, normal, pixelLength);
  drawCubic(start, c1, c2, end, outward);
}

function cubicPointOnCurve(curve, t) {
  const u = 1 - t;
  return {
    x: u ** 3 * curve[0].x + 3 * u ** 2 * t * curve[1].x + 3 * u * t ** 2 * curve[2].x + t ** 3 * curve[3].x,
    y: u ** 3 * curve[0].y + 3 * u ** 2 * t * curve[1].y + 3 * u * t ** 2 * curve[2].y + t ** 3 * curve[3].y
  };
}

function cubicTangentOnCurve(curve, t) {
  const u = 1 - t;
  return {
    x: 3 * u ** 2 * (curve[1].x - curve[0].x) + 6 * u * t * (curve[2].x - curve[1].x) + 3 * t ** 2 * (curve[3].x - curve[2].x),
    y: 3 * u ** 2 * (curve[1].y - curve[0].y) + 6 * u * t * (curve[2].y - curve[1].y) + 3 * t ** 2 * (curve[3].y - curve[2].y)
  };
}

function outwardPixelNormal(point, tangent) {
  const pxTangent = {
    x: tangent.x * canvas.width,
    y: tangent.y * canvas.height
  };
  const len = Math.hypot(pxTangent.x, pxTangent.y) || 1;
  const tx = pxTangent.x / len;
  const ty = pxTangent.y / len;
  const candidates = [
    { x: -ty, y: tx },
    { x: ty, y: -tx }
  ];
  const fromCenter = {
    x: sx(point.x) - sx(0.52),
    y: sy(point.y) - sy(0.5)
  };
  const normal = candidates[0].x * fromCenter.x + candidates[0].y * fromCenter.y >
    candidates[1].x * fromCenter.x + candidates[1].y * fromCenter.y
    ? candidates[0]
    : candidates[1];
  return normal;
}

function movePointByPixelVector(point, vector, distance) {
  return {
    x: (sx(point.x) + vector.x * distance) / canvas.width,
    y: (sy(point.y) + vector.y * distance) / canvas.height
  };
}

function drawBemFieldLines() {
  const solution = getBemSolution();
  const lineSolution = makeLineSolution(solution);
  const reverseArrows = solution.sources[0].q < 0;
  const seeds = makeFieldSeeds(lineSolution);
  drawSymmetricFieldPaths(seeds, lineSolution, reverseArrows);
  if (state.scene === "cavity") {
    const outerCharge = solution.charges.reduce((sum, value, index) => (
      solution.boundaries[index].role === "outer" ? sum + value : sum
    ), 0);
    const count = state.dragging ? 8 : 12;
    drawOuterRadialLines(0.56, 0.5, 0.24, count, outerCharge >= 0);
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
  if (hasAxisymmetricBoundarySeeds()) return makeSymmetricBoundaryFluxSeeds(solution, budget);
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
    if (physDistance(point, solution.sources[0]) < 0.018) break;
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
