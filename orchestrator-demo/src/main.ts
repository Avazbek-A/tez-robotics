import { Sim, grid, GRID_W, GRID_H, Cell, stations, chargers, type Robot } from "./sim";
import { setLang, t, type Lang } from "./i18n";

const canvas = document.getElementById("warehouse") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const sim = new Sim(8);
let speedMul = 1;
let paused = false;
// debug handle for inspection
(window as unknown as { sim: Sim }).sim = sim;

// ---------- UI wiring ----------

document.querySelectorAll<HTMLButtonElement>(".lang-switch button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".lang-switch button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    setLang(b.dataset.lang as Lang);
  });
});

document.querySelectorAll<HTMLButtonElement>(".speed button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".speed button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    speedMul = Number(b.dataset.speed);
  });
});

const pauseBtn = document.getElementById("btn-pause") as HTMLButtonElement;
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "▶" : "⏸";
});

const robotSlider = document.getElementById("robot-count") as HTMLInputElement;
robotSlider.addEventListener("input", () => {
  const n = Number(robotSlider.value);
  document.getElementById("robot-count-val")!.textContent = String(n);
  sim.setRobotCount(n);
});

const rateSlider = document.getElementById("order-rate") as HTMLInputElement;
rateSlider.addEventListener("input", () => {
  const n = Number(rateSlider.value);
  document.getElementById("order-rate-val")!.textContent = String(n);
  sim.orderRate = n;
});

// ---------- Rendering ----------

const ROBOT_COLORS = ["#22d3ee", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#fb923c", "#60a5fa", "#f87171"];

function resize() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener("resize", resize);

function draw() {
  const rect = canvas.getBoundingClientRect();
  const cw = rect.width, chh = rect.height;
  const cell = Math.min(cw / GRID_W, chh / GRID_H);
  const ox = (cw - cell * GRID_W) / 2;
  const oy = (chh - cell * GRID_H) / 2;
  const px = (x: number) => ox + x * cell;
  const py = (y: number) => oy + y * cell;

  ctx.clearRect(0, 0, cw, chh);

  // floor dots
  ctx.fillStyle = "rgba(139,152,169,0.12)";
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (grid[y][x] === Cell.Floor) {
        ctx.beginPath();
        ctx.arc(px(x) + cell / 2, py(y) + cell / 2, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // racks
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (grid[y][x] === Cell.Rack) {
        ctx.fillStyle = "#232c3d";
        ctx.strokeStyle = "#33415c";
        ctx.lineWidth = 1;
        const pad = cell * 0.08;
        roundRect(px(x) + pad, py(y) + pad, cell - pad * 2, cell - pad * 2, 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // stations
  stations.forEach((s, i) => {
    ctx.fillStyle = "rgba(52,211,153,0.2)";
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = 1.5;
    const pad = cell * 0.05;
    roundRect(px(s.x) + pad, py(s.y) + pad, cell - pad * 2, cell - pad * 2, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#34d399";
    ctx.font = `${Math.max(9, cell * 0.38)}px Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`P${i + 1}`, px(s.x) + cell / 2, py(s.y) + cell / 2);
  });

  // chargers
  for (const c of chargers) {
    ctx.fillStyle = "rgba(251,191,36,0.15)";
    ctx.strokeStyle = "rgba(251,191,36,0.6)";
    ctx.lineWidth = 1;
    const pad = cell * 0.12;
    roundRect(px(c.x) + pad, py(c.y) + pad, cell - pad * 2, cell - pad * 2, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(251,191,36,0.8)";
    ctx.font = `${Math.max(8, cell * 0.4)}px Inter, sans-serif`;
    ctx.fillText("⚡", px(c.x) + cell / 2, py(c.y) + cell / 2 + 1);
  }

  // order pick markers
  for (const o of sim.orders) {
    if (o.status !== "new" && o.status !== "assigned") continue;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    ctx.strokeStyle = o.status === "new" ? `rgba(251,191,36,${0.4 + 0.4 * pulse})` : "rgba(34,211,238,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px(o.rack.x) + cell / 2, py(o.rack.y) + cell / 2, cell * 0.35 + pulse * 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  // robot paths
  for (const r of sim.robots) {
    if (!r.path.length) continue;
    const color = ROBOT_COLORS[(r.id - 1) % ROBOT_COLORS.length];
    ctx.strokeStyle = color + "44";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px(r.fx) + cell / 2, py(r.fy) + cell / 2);
    for (const p of r.path) ctx.lineTo(px(p.x) + cell / 2, py(p.y) + cell / 2);
    ctx.stroke();
  }

  // robots
  for (const r of sim.robots) {
    const color = ROBOT_COLORS[(r.id - 1) % ROBOT_COLORS.length];
    const cx = px(r.fx) + cell / 2;
    const cy = py(r.fy) + cell / 2;
    const s = cell * 0.72;
    ctx.fillStyle = color;
    ctx.strokeStyle = "#0d1117";
    ctx.lineWidth = 1.5;
    roundRect(cx - s / 2, cy - s / 2, s, s, s * 0.25);
    ctx.fill();
    ctx.stroke();
    // carrying box
    if (r.state === "toDrop" || r.state === "dropping") {
      ctx.fillStyle = "#e8c07a";
      ctx.strokeStyle = "#8a6d3b";
      ctx.lineWidth = 1;
      const b = s * 0.5;
      roundRect(cx - b / 2, cy - b / 2, b, b, 1.5);
      ctx.fill();
      ctx.stroke();
    }
    // id
    ctx.fillStyle = "#0d1117";
    ctx.font = `bold ${Math.max(8, cell * 0.32)}px Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (!(r.state === "toDrop" || r.state === "dropping")) ctx.fillText(String(r.id), cx, cy + 0.5);
    // low battery ring
    if (r.battery <= 25) {
      ctx.strokeStyle = "#f87171";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.72, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- Panel ----------

function stateLabel(r: Robot): string {
  switch (r.state) {
    case "idle": return t("stIdle");
    case "toPick": case "picking": return t("stToPick");
    case "toDrop": case "dropping": return t("stCarry");
    case "toCharge": case "charging": return t("stCharge");
  }
}

function fmtMeters(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${m} м`;
}

let panelTimer = 0;
function updatePanel(dt: number) {
  panelTimer += dt;
  if (panelTimer < 0.25) return;
  panelTimer = 0;
  const m = sim.metrics();
  (document.getElementById("kpi-done")!).textContent = String(m.done);
  (document.getElementById("kpi-rate")!).textContent = String(m.perHour);
  (document.getElementById("kpi-cycle")!).textContent = m.avgCycleSec ? String(m.avgCycleSec) : "—";
  (document.getElementById("kpi-util")!).textContent = `${m.utilization}%`;
  (document.getElementById("kpi-dist")!).textContent = String(m.distanceMeters);
  (document.getElementById("kpi-queue")!).textContent = String(m.queue);
  (document.getElementById("kpi-walk")!).textContent = fmtMeters(m.walkSavedMeters);

  const feed = document.getElementById("order-feed")!;
  feed.innerHTML = sim.feed
    .map((o) => {
      const cls = o.status === "new" ? "status-new" : o.status === "assigned" ? "status-assigned" : "status-done";
      const label = o.status === "new" ? t("stNew") : o.status === "assigned" ? t("stAssigned") : t("stDone");
      return `<li><span class="oid">${o.id}</span><span>→ P${o.stationIdx + 1}</span><span class="${cls}">${label}</span></li>`;
    })
    .join("");

  const fleet = document.getElementById("fleet-list")!;
  fleet.innerHTML = sim.robots
    .map((r) => {
      const color = ROBOT_COLORS[(r.id - 1) % ROBOT_COLORS.length];
      const bat = Math.round(r.battery);
      const batColor = bat <= 25 ? "#f87171" : bat <= 50 ? "#fbbf24" : "#34d399";
      return `<li><span class="dot" style="background:${color}"></span>AMR-${String(r.id).padStart(2, "0")} · ${stateLabel(r)}<span class="battery" style="color:${batColor}">${bat}%</span></li>`;
    })
    .join("");
}

// ---------- Main loop ----------

// Physics on a timer (keeps running when the tab is throttled), rendering on rAF.
let lastStep = performance.now();
setInterval(() => {
  const now = performance.now();
  // cap catch-up to 2s of real time so background throttling doesn't cause a giant jump
  const dtReal = Math.min(2, (now - lastStep) / 1000);
  lastStep = now;
  if (paused) return;
  const dtSim = dtReal * speedMul;
  const steps = Math.max(1, Math.ceil(dtSim / 0.05));
  for (let i = 0; i < steps; i++) sim.step(dtSim / steps);
}, 50);

let lastFrame = performance.now();
function frame(now: number) {
  const dtReal = (now - lastFrame) / 1000;
  lastFrame = now;
  draw();
  updatePanel(dtReal);
  requestAnimationFrame(frame);
}

resize();
setLang("ru");
requestAnimationFrame(frame);
