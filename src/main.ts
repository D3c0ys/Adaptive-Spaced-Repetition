import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";

interface ASRSettings {
  thetaInit: number;
  threshold: number;
  alpha: number;
  beta: number;
}

const DEFAULT_SETTINGS: ASRSettings = {
  thetaInit: 0.05,
  threshold: 0.9,
  alpha: 0.7,
  beta: 1.6,
};

type Outcome = "pass" | "fail";

interface DueEntry {
  file: TFile;
  theta: number;
  nextReview: string;
  daysOverdue: number;
}

interface CurveSegment {
  start: string;
  end: string;
  theta: number;
}

interface CurveMarker {
  date: string;
  outcome: Outcome;
}

interface CurveData {
  rangeStart: string;
  rangeEnd: string;
  segments: CurveSegment[];
  markers: CurveMarker[];
  thetaNow: number;
  reviewCount: number;
}

// ---------- date helpers (dates are plain "YYYY-MM-DD" strings) ----------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr(): string {
  return isoDate(new Date());
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + Math.round(days));
  return isoDate(d);
}

function daysBetween(fromStr: string, toStr: string): number {
  return Math.round(
    (parseDate(toStr).getTime() - parseDate(fromStr).getTime()) / 86400000
  );
}

// Obsidian's YAML parser turns unquoted "YYYY-MM-DD" frontmatter values into
// JS Date objects on read (not strings), even though we always write plain
// strings. Coerce either shape back to a "YYYY-MM-DD" string before use.
function coerceDateStr(v: unknown): string | null {
  if (v instanceof Date) return isoDate(v);
  if (typeof v === "string") return v.slice(0, 10);
  return null;
}

// ---------- forgetting-curve math (mirrors forgetting_curve_sim.py) ----------

function gapDays(theta: number, threshold: number): number {
  return -Math.log(threshold) / theta;
}

function updateTheta(theta: number, outcome: Outcome, settings: ASRSettings): number {
  if (outcome === "pass") return theta * settings.alpha;
  return Math.min(theta * settings.beta, settings.thetaInit);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function shortDate(s: string): string {
  const parts = s.split("-");
  return `${parts[1]}/${parts[2]}`;
}

/**
 * Replays a note's actual review_history (real dates, real outcomes) through
 * the same theta-update rule as gradeNote(), producing decay-curve segments
 * and review markers for plotting — the in-app equivalent of
 * forgetting_curve_sim.py's simulate()/build_curve(), but driven by real
 * recorded reviews instead of a synthetic on-schedule simulation.
 */
function buildCurveData(fm: any, settings: ASRSettings, today: string): CurveData {
  const history: any[] = Array.isArray(fm.review_history) ? fm.review_history.slice() : [];
  const events: CurveMarker[] = history
    .map((h) => {
      const d = h && coerceDateStr(h.date);
      if (!d) return null;
      return { date: d, outcome: (h.outcome === "fail" ? "fail" : "pass") as Outcome };
    })
    .filter((e): e is CurveMarker => e !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const created = coerceDateStr(fm.created) || events[0]?.date || today;

  const segments: CurveSegment[] = [];
  const markers: CurveMarker[] = [];
  let theta = settings.thetaInit;
  let prevDate = created;

  for (const e of events) {
    if (daysBetween(prevDate, e.date) > 0) {
      segments.push({ start: prevDate, end: e.date, theta });
    }
    markers.push({ date: e.date, outcome: e.outcome });
    theta = updateTheta(theta, e.outcome, settings);
    prevDate = e.date;
  }

  // The note's stored theta is authoritative (it's what gradeNote() actually
  // wrote); use it for the current/trailing segment instead of the replayed
  // value so the "now" part of the graph is always exact.
  const thetaNow = typeof fm.theta === "number" ? fm.theta : theta;

  let trailEnd = coerceDateStr(fm.next_review);
  if (!trailEnd || daysBetween(prevDate, trailEnd) <= 0) {
    trailEnd = addDays(prevDate, Math.max(1, gapDays(thetaNow, settings.threshold)));
  }
  if (daysBetween(trailEnd, today) > 0) trailEnd = today;

  segments.push({ start: prevDate, end: trailEnd, theta: thetaNow });

  return {
    rangeStart: created,
    rangeEnd: trailEnd,
    segments,
    markers,
    thetaNow,
    reviewCount: events.length,
  };
}

function renderCurve(
  canvas: HTMLCanvasElement,
  containerEl: HTMLElement,
  data: CurveData,
  settings: ASRSettings,
  today: string
): void {
  const cssWidth = canvas.clientWidth || 560;
  const cssHeight = canvas.clientHeight || 300;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;

  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const styles = getComputedStyle(containerEl);
  function cssVar(name: string, fallback: string): string {
    const v = styles.getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  }
  const colAxis = cssVar("--background-modifier-border", "#888888");
  const colText = cssVar("--text-muted", "#888888");
  const colCurve = cssVar("--text-accent", "#7c3aed");
  const colPass = cssVar("--text-success", "#2e9e5b");
  const colFail = cssVar("--text-error", "#d14343");
  const font = cssVar("--font-interface", "sans-serif");

  const padL = 42,
    padR = 16,
    padT = 30,
    padB = 26;
  const plotW = Math.max(cssWidth - padL - padR, 10);
  const plotH = Math.max(cssHeight - padT - padB, 10);
  const YMAX = 1.08;

  const totalDays = Math.max(daysBetween(data.rangeStart, data.rangeEnd), 1);

  function x(dateStr: string): number {
    return padL + (daysBetween(data.rangeStart, dateStr) / totalDays) * plotW;
  }
  function y(n: number): number {
    return padT + (1 - n / YMAX) * plotH;
  }

  // axes
  ctx.strokeStyle = colAxis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  // y gridlines/ticks
  ctx.font = "10px " + font;
  ctx.textBaseline = "middle";
  [0, 0.25, 0.5, 0.75, 1.0].forEach((v) => {
    const yy = y(v);
    ctx.strokeStyle = colAxis;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(padL + plotW, yy);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colText;
    ctx.textAlign = "right";
    ctx.fillText(v.toFixed(2), padL - 6, yy);
  });

  // threshold dashed line
  ctx.save();
  ctx.strokeStyle = colText;
  ctx.setLineDash([4, 3]);
  const ty = y(settings.threshold);
  ctx.beginPath();
  ctx.moveTo(padL, ty);
  ctx.lineTo(padL + plotW, ty);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = colText;
  ctx.textAlign = "left";
  ctx.fillText("threshold " + Math.round(settings.threshold * 100) + "%", padL + 4, ty - 8);

  // today vertical dashed line
  if (daysBetween(data.rangeStart, today) >= 0 && daysBetween(today, data.rangeEnd) >= 0) {
    const tx = x(today);
    ctx.save();
    ctx.strokeStyle = colText;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(tx, padT);
    ctx.lineTo(tx, padT + plotH);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = colText;
    ctx.textAlign = "center";
    ctx.fillText("today", tx, padT - 10);
  }

  // decay curve, per segment
  ctx.strokeStyle = colCurve;
  ctx.lineWidth = 2;
  data.segments.forEach((seg) => {
    const segDays = daysBetween(seg.start, seg.end);
    if (segDays <= 0) return;
    const steps = Math.max(segDays * 3, 8);
    const startOffset = daysBetween(data.rangeStart, seg.start);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * segDays;
      const n = Math.exp(-seg.theta * t);
      const xx = padL + ((startOffset + t) / totalDays) * plotW;
      const yy = y(n);
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  });

  // review markers, jittered when multiple share a date
  const byDate: Record<string, CurveMarker[]> = {};
  data.markers.forEach((m) => {
    (byDate[m.date] = byDate[m.date] || []).push(m);
  });
  Object.keys(byDate).forEach((d) => {
    const group = byDate[d];
    const baseX = x(d);
    const my = y(1.0);
    group.forEach((m, idx) => {
      const mx = baseX + (idx - (group.length - 1) / 2) * 7;
      const color = m.outcome === "pass" ? colPass : colFail;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (m.outcome === "pass") {
        ctx.beginPath();
        ctx.arc(mx, my, 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx - 4, my - 4);
        ctx.lineTo(mx + 4, my + 4);
        ctx.moveTo(mx + 4, my - 4);
        ctx.lineTo(mx - 4, my + 4);
        ctx.stroke();
      }
      ctx.fillStyle = colText;
      ctx.font = "9px " + font;
      ctx.textAlign = "center";
      ctx.fillText(shortDate(d), mx, my - 10 - idx * 11);
    });
  });

  // x-axis start/end date labels
  ctx.fillStyle = colText;
  ctx.font = "10px " + font;
  ctx.textAlign = "left";
  ctx.fillText(shortDate(data.rangeStart), padL, padT + plotH + 16);
  ctx.textAlign = "right";
  ctx.fillText(shortDate(data.rangeEnd), padL + plotW, padT + plotH + 16);
}

export default class AdaptiveSRPlugin extends Plugin {
  settings: ASRSettings;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("repeat", "Review due notes (Adaptive SR)", () => {
      new DueNotesModal(this.app, this).open();
    });

    this.addCommand({
      id: "asr-add-note",
      name: "Add current note to review schedule",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.initNote(file);
        return true;
      },
    });

    this.addCommand({
      id: "asr-review-current",
      name: "Review current note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) new GradeModal(this.app, this, file).open();
        return true;
      },
    });

    this.addCommand({
      id: "asr-show-due",
      name: "Show due notes",
      callback: () => new DueNotesModal(this.app, this).open(),
    });

    this.addCommand({
      id: "asr-show-graph",
      name: "Show recall curve for current note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) new GraphModal(this.app, this, file).open();
        return true;
      },
    });

    this.addSettingTab(new ASRSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isTracked(fm: any): boolean {
    return !!fm && typeof fm.theta === "number" && coerceDateStr(fm.next_review) !== null;
  }

  /** Adds review-tracking frontmatter to a note that isn't tracked yet. New notes are due immediately. */
  async initNote(file: TFile) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (this.isTracked(fm)) {
      new Notice(`"${file.basename}" is already on the review schedule.`);
      return;
    }
    const today = todayStr();
    await this.app.fileManager.processFrontMatter(file, (data) => {
      if (!data.created) data.created = today;
      data.theta = this.settings.thetaInit;
      data.next_review = today;
      if (!Array.isArray(data.review_history)) data.review_history = [];
    });
    new Notice(`"${file.basename}" added to the review schedule — due today.`);
  }

  /**
   * Records a review outcome, updates theta, and recomputes next_review.
   * The gap to the *next* review is derived from the *updated* theta, matching
   * forgetting_curve_sim.py: this outcome's theta update governs the following interval.
   */
  async gradeNote(file: TFile, outcome: Outcome): Promise<string> {
    const today = todayStr();
    let nextReview = today;
    await this.app.fileManager.processFrontMatter(file, (data) => {
      const theta = typeof data.theta === "number" ? data.theta : this.settings.thetaInit;
      const newTheta = round6(updateTheta(theta, outcome, this.settings));
      const gap = gapDays(newTheta, this.settings.threshold);
      nextReview = addDays(today, gap);

      data.last_reviewed = today;
      data.theta = newTheta;
      data.next_review = nextReview;
      if (!Array.isArray(data.review_history)) data.review_history = [];
      data.review_history.push({ date: today, outcome });
    });
    return nextReview;
  }

  getDueNotes(): DueEntry[] {
    const today = todayStr();
    const due: DueEntry[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!this.isTracked(fm)) continue;
      const nextReview = coerceDateStr(fm!.next_review)!;
      if (nextReview <= today) {
        due.push({
          file,
          theta: fm!.theta,
          nextReview,
          daysOverdue: daysBetween(nextReview, today),
        });
      }
    }
    due.sort((a, b) => b.daysOverdue - a.daysOverdue);
    return due;
  }
}

// ---------- grade a single note (used by "Review current note") ----------

class GradeModal extends Modal {
  plugin: AdaptiveSRPlugin;
  file: TFile;

  constructor(app: App, plugin: AdaptiveSRPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `Review: ${this.file.basename}` });
    contentEl.createEl("p", { text: "Did you recall this note?" });

    const btnRow = contentEl.createDiv({ cls: "asr-btn-row" });

    const passBtn = btnRow.createEl("button", { text: "Pass", cls: "mod-cta" });
    passBtn.onclick = () => this.grade("pass");

    const failBtn = btnRow.createEl("button", { text: "Fail" });
    failBtn.onclick = () => this.grade("fail");
  }

  async grade(outcome: Outcome) {
    if (!this.plugin.isTracked(this.app.metadataCache.getFileCache(this.file)?.frontmatter)) {
      await this.plugin.initNote(this.file);
    }
    const nextReview = await this.plugin.gradeNote(this.file, outcome);
    new Notice(`"${this.file.basename}" graded ${outcome}. Next review: ${nextReview}.`);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------- recall curve for the current note ----------

class GraphModal extends Modal {
  plugin: AdaptiveSRPlugin;
  file: TFile;

  constructor(app: App, plugin: AdaptiveSRPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `Recall curve: ${this.file.basename}` });

    const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    if (!this.plugin.isTracked(fm)) {
      contentEl.createEl("p", {
        text: `This note isn't on the review schedule yet. Run "Add current note to review schedule" first.`,
      });
      return;
    }

    const history: any[] = Array.isArray(fm!.review_history) ? fm!.review_history : [];
    if (history.length === 0) {
      contentEl.createEl("p", {
        text: `No reviews recorded yet. Run "Review current note" to log the first one.`,
      });
      return;
    }

    const today = todayStr();
    const data = buildCurveData(fm, this.plugin.settings, today);

    contentEl.createEl("p", {
      cls: "asr-graph-stats",
      text:
        `θ now: ${data.thetaNow.toFixed(4)}` +
        `  •  ${data.reviewCount} review${data.reviewCount === 1 ? "" : "s"}` +
        `  •  next review: ${coerceDateStr(fm!.next_review)}`,
    });

    const canvas = contentEl.createEl("canvas", { cls: "asr-graph-canvas" });

    const legend = contentEl.createDiv({ cls: "asr-graph-legend" });
    legend.createSpan({ text: "● pass", cls: "asr-legend-pass" });
    legend.createSpan({ text: "✕ fail", cls: "asr-legend-fail" });
    legend.createSpan({ text: "- - threshold / today", cls: "asr-legend-muted" });

    // defer to next frame so the canvas has real layout dimensions
    window.requestAnimationFrame(() => {
      renderCurve(canvas, contentEl, data, this.plugin.settings, today);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------- due notes list ----------

class DueNotesModal extends Modal {
  plugin: AdaptiveSRPlugin;

  constructor(app: App, plugin: AdaptiveSRPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Due for review" });

    const due = this.plugin.getDueNotes();

    if (due.length === 0) {
      contentEl.createEl("p", { text: "Nothing due right now." });
      return;
    }

    const list = contentEl.createDiv({ cls: "asr-due-list" });

    for (const entry of due) {
      const row = list.createDiv({ cls: "asr-due-row" });

      const info = row.createDiv({ cls: "asr-due-info" });
      const link = info.createEl("a", { text: entry.file.basename, cls: "asr-due-title" });
      link.onclick = (e) => {
        e.preventDefault();
        this.app.workspace.getLeaf(false).openFile(entry.file);
        this.close();
      };
      const overdueLabel = entry.daysOverdue > 0 ? `${entry.daysOverdue}d overdue` : "due today";
      info.createEl("span", {
        text: ` — θ=${entry.theta.toFixed(4)} — ${overdueLabel}`,
        cls: "asr-due-meta",
      });

      const actions = row.createDiv({ cls: "asr-due-actions" });
      const passBtn = actions.createEl("button", { text: "Pass", cls: "mod-cta" });
      passBtn.onclick = async () => {
        const nextReview = await this.plugin.gradeNote(entry.file, "pass");
        new Notice(`"${entry.file.basename}" passed. Next review: ${nextReview}.`);
        this.render();
      };
      const failBtn = actions.createEl("button", { text: "Fail" });
      failBtn.onclick = async () => {
        const nextReview = await this.plugin.gradeNote(entry.file, "fail");
        new Notice(`"${entry.file.basename}" failed. Next review: ${nextReview}.`);
        this.render();
      };
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------- settings tab ----------

class ASRSettingTab extends PluginSettingTab {
  plugin: AdaptiveSRPlugin;

  constructor(app: App, plugin: AdaptiveSRPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Adaptive Spaced Repetition" });

    new Setting(containerEl)
      .setName("Initial theta")
      .setDesc("Starting forgetting rate for new notes. Higher = forgotten faster.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.thetaInit)).onChange(async (value) => {
          const n = parseFloat(value);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.thetaInit = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Review threshold")
      .setDesc(
        "Schedule the next review for when predicted recall probability drops to this value (0–1)."
      )
      .addText((text) =>
        text.setValue(String(this.plugin.settings.threshold)).onChange(async (value) => {
          const n = parseFloat(value);
          if (!isNaN(n) && n > 0 && n < 1) {
            this.plugin.settings.threshold = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Alpha (pass multiplier)")
      .setDesc("theta is multiplied by this after a successful recall. Should be < 1 so gaps grow.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.alpha)).onChange(async (value) => {
          const n = parseFloat(value);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.alpha = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Beta (fail multiplier)")
      .setDesc(
        "theta is multiplied by this after a failed recall, capped at the initial theta. Should be > 1 so gaps shrink."
      )
      .addText((text) =>
        text.setValue(String(this.plugin.settings.beta)).onChange(async (value) => {
          const n = parseFloat(value);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.beta = n;
            await this.plugin.saveSettings();
          }
        })
      );
  }
}
