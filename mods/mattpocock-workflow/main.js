// Workflow: where a mattpocock-skills project stands. Reads the local-markdown tracker
// (.scratch/<effort>/spec.md + issues/NN-*.md), GLOSSARY.md, docs/adr/, git branches and
// the Remember plugin's .remember/now.md, for the focused pane's repo.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, notify, run } from "herdr";

// What Submit starts in a new tab: one Opus Claude Code session implementing the ticket.
const IMPLEMENT = n => ["claude", "--model", "opus", `/mattpocock-skills:implement ${n}`];

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// One line like "**Status:** done" or "Status: ready-for-agent".
const field = (text, name) => {
  const m = new RegExp(`^\\s*\\**${name}:?\\**:?\\s*(.+)$`, "mi").exec(text);
  return m ? m[1].replace(/\*/g, "").trim() : null;
};

function parseTicket(file, text) {
  const num = (/^(\d+)/.exec(file) ?? [])[1] ?? "?";
  const title = (/^#\s+(?:\d+\s*[:.\-—]\s*)?(.+)$/m.exec(text) ?? [])[1]?.trim() ?? file;
  const status = (field(text, "Status") ?? "needs-triage").toLowerCase().split(/\s+/)[0];
  const blockedRaw = field(text, "Blocked by") ?? "";
  const blockedBy = /none/i.test(blockedRaw) ? [] : [...new Set(blockedRaw.match(/\b\d{2}\b/g) ?? [])];
  const checked = (text.match(/^\s*[-*] \[[xX]\]/gm) ?? []).length;
  const total = checked + (text.match(/^\s*[-*] \[ \]/gm) ?? []).length;
  const comments = text.split(/^## Comments\s*$/m)[1] ?? "";
  const followUps = /^\s*\**follow-?ups?\b/im.test(comments);
  return { num, file, title, status, blockedBy, checked, total, followUps, text };
}

const DONE = new Set(["done", "resolved", "closed", "complete", "completed"]);
const NEEDS_YOU = new Set(["needs-triage", "needs-info", "ready-for-human"]);
const ACTIVE = new Set(["in-progress", "claimed", "wip", "doing", "in-review", "review"]);

function lane(t, byNum, activeNums) {
  if (DONE.has(t.status)) return "done";
  if (t.status === "wontfix") return "wontfix";
  if (ACTIVE.has(t.status) || activeNums.has(t.num)) return "active";
  if (NEEDS_YOU.has(t.status)) return "you";
  // Only numbers that are tickets here: "Expo SDK 58" in the line isn't a blocker.
  const open = t.blockedBy.filter(n => byNum.has(n) && !DONE.has(byNum.get(n).status));
  t.waitingOn = open;
  return open.length ? "blocked" : "next";
}

const LANES = [
  ["active", "In progress"], ["you", "Needs you"], ["next", "Next up"],
  ["blocked", "Blocked"], ["done", "Done"], ["wontfix", "Won't fix"],
];

export default class Workflow extends View {
  init(_props, cx) {
    this.collapsed = new Set(["done", "wontfix"]);
    this.effort = null; this.open = null; this.submitted = new Set();
    try { this.effort = localStorage.getItem("effort"); } catch {}
    this.refresh(cx);
    cx.timer.every(15000, cx => this.refresh(cx));
  }

  watch(dir, cx) {
    if (this.on || this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async cx => {
      try { while (this.watched === dir) { await watchFolder(dir); if (this.watched === dir) this.refresh(cx); } }
      catch { if (this.watched === dir) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.data = null; this.open = null; this.error = null; this.watched = null; }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const data = await this.load(cwd, on);
        if (key() !== context) return;
        this.data = data; this.error = null; this.on = on;
        if (this.open) this.open = data.tickets?.find(x => x.file === this.open.file) ?? this.open;
        if (data.root) this.watch(`${data.root}/.scratch`, cx);
      } catch (e) { if (key() === context) this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(cwd, on) {
    const sh = (script, ...args) => exec("sh", ["-c", script, "wf", ...args], { cwd, on });
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
    const root = top?.code === 0 ? top.stdout.trim() : cwd;
    const read = p => readTextFile(`${root}/${p}`, { on }).catch(() => null);
    const git = args => exec("git", [...READ, ...args], { cwd: root, on }).catch(() => ({ code: 1, stdout: "" }));

    const ls = await sh('cd "$1" 2>/dev/null || exit 0; for d in .scratch/*/; do [ -d "$d" ] && echo "E ${d#.scratch/}"; done; for f in .scratch/*/issues/*.md; do [ -f "$f" ] && echo "I ${f#.scratch/}"; done; for f in docs/adr/*.md; do [ -f "$f" ] && echo "A ${f##*/}"; done', root);
    const lines = ls.stdout.split("\n").filter(Boolean);
    const efforts = lines.filter(l => l[0] === "E").map(l => l.slice(2).replace(/\/$/, ""));
    if (!efforts.length) return { root, efforts: [] };

    const branch = (await git(["branch", "--show-current"])).stdout.trim();
    const heads = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).stdout.split("\n").filter(Boolean);
    let effort = efforts.includes(this.effort) ? this.effort : efforts.find(e => branch === e || heads.includes(e)) ?? efforts[0];

    const files = lines.filter(l => l[0] === "I" && l.slice(2).startsWith(`${effort}/issues/`)).map(l => l.slice(2).split("/").pop()).sort();
    const tickets = (await Promise.all(files.map(async f => {
      const text = await read(`.scratch/${effort}/issues/${f}`);
      return text == null ? null : { ...parseTicket(f, text), path: `${root}/.scratch/${effort}/issues/${f}` };
    }))).filter(Boolean);
    const spec = await read(`.scratch/${effort}/spec.md`);
    const map = await read(`.scratch/${effort}/map.md`);
    const glossary = await read("GLOSSARY.md");
    const adrs = lines.filter(l => l[0] === "A").length;

    // A ticket is being worked when we're on its branch, or its branch isn't merged yet.
    const base = heads.includes(effort) ? effort : heads.includes("main") ? "main" : null;
    const merged = base ? new Set((await git(["branch", "--format=%(refname:short)", "--merged", base])).stdout.split("\n").filter(Boolean)) : new Set();
    const ticketNum = b => (/(?:^|\/)(?:ticket|issue)s?[\/-]?(\d+)/i.exec(b) ?? [])[1]?.padStart(2, "0");
    const activeNums = new Set();
    if (ticketNum(branch)) activeNums.add(ticketNum(branch));
    for (const h of heads) if (ticketNum(h) && !merged.has(h)) activeNums.add(ticketNum(h));
    const byNum = new Map(tickets.map(t => [t.num, t]));
    for (const t of tickets) {
      t.lane = lane(t, byNum, activeNums);
      t.branch = heads.find(h => ticketNum(h) === t.num) ?? null;
    }
    const current = byNum.get(ticketNum(branch)) ?? tickets.find(t => t.lane === "active") ?? null;

    let ahead = null, dirty = 0;
    const against = branch === effort ? (heads.includes("main") ? "main" : null) : base;
    if (against && branch && against !== branch) {
      const r = await git(["rev-list", "--count", `${against}..HEAD`]);
      if (r.code === 0) ahead = { count: +r.stdout.trim(), of: against };
    }
    const st = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
    if (st.code === 0) dirty = st.stdout.split("\0").filter(Boolean).length;
    const shipped = heads.includes(effort) && heads.includes("main")
      ? (await git(["merge-base", "--is-ancestor", effort, "main"])).code === 0 && (await git(["rev-list", "--count", `main..${effort}`])).stdout.trim() === "0" && tickets.length > 0 && tickets.every(t => t.lane === "done" || t.lane === "wontfix")
      : false;

    // Last entry of the Remember plugin's buffer: "## 23:44 | branch" + body.
    let note = null;
    const now = await read(".remember/now.md");
    if (now) {
      const parts = now.split(/^## /m).filter(s => s.trim());
      const last = parts[parts.length - 1];
      if (last) { const [head, ...body] = last.split("\n"); note = { head: head.trim(), body: body.join(" ").trim() }; }
    }

    return {
      root, efforts, effort, tickets, current, branch, ahead, dirty, note, shipped,
      spec: spec != null, specStatus: spec ? field(spec, "Status") : null,
      stories: spec ? (spec.match(/^\s*\d+\.\s+As an?\b/gim) ?? []).length : 0,
      map: map != null,
      terms: glossary ? (glossary.match(/^\*\*[^*]+\*\*:?\s*$/gm) ?? []).length : 0,
      adrs,
    };
  }

  showTicket(t, cx) { this.open = t; cx.notify(); }

  // A new tab in the repo root, named after the ticket, running the implement skill on it.
  submit(x, cx) {
    const space = spaces().find(s => s.active);
    const n = String(parseInt(x.num, 10));
    run("tab.new", { name: `${x.num} · ${x.title}`, space: space?.id, folder: this.data.root, argv: IMPLEMENT(n) });
    this.submitted.add(`${this.data.root}#${x.file}`);
    cx.notify();
  }

  submitButton(x, t, id) {
    const sent = this.submitted.has(`${this.data.root}#${x.file}`);
    return div().id(id).flex_none().px(8).h(20).flex().items_center().rounded(5).text_size(11).font_medium()
      .cursor_pointer().bg(sent ? t.raised : t.solid).text_color(sent ? t.muted : t.solid_foreground)
      .hover(s => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.submit(x, cx); })
      .child(sent ? "Started" : "Submit");
  }

  pickEffort(e, cx) {
    this.effort = e; this.open = null;
    try { localStorage.setItem("effort", e); } catch {}
    this.data = { ...this.data, loading: true }; this.refresh(cx);
  }

  // ── view ────────────────────────────────────────────────────────────────

  laneColor(l, t) {
    return { active: t.working, you: t.blocked, next: t.accent, blocked: t.dim, done: t.done, wontfix: t.dim }[l] ?? t.muted;
  }

  chip(text, color, t) {
    return div().flex_none().px(6).h(18).rounded(9).border_1().border_color(color).text_color(color).text_size(10).items_center().flex().child(text);
  }

  segments(t, done, total, color, id) {
    if (!total) return div();
    return h_flex().id(id).h(5).gap(2).flex_1().children(
      Array.from({ length: total }, (_, i) => div().flex_1().h(5).rounded(2).bg(i < done ? color : t.raised)));
  }

  stage(label, sub, state, t, last) {
    const color = state === "done" ? t.done : state === "now" ? t.working : t.dim;
    return h_flex().flex_1().min_w(0).items_center().gap(4)
      .child(v_flex().items_center().gap(3).min_w(0).flex_1()
        .child(div().size(10).rounded_full().bg(state === "todo" ? t.raised : color).border_1().border_color(color)
          .when(state === "now", el => el.loop("opacity", { from: 0.45, to: 1, period: 1400 })))
        .child(div().text_size(10).font_semibold().text_color(state === "todo" ? t.dim : t.foreground).truncate().child(label))
        .child(div().text_size(9).text_color(t.dim).truncate().child(sub)))
      .when(!last, el => el.child(div().w(10).h(1).flex_none().bg(t.border)));
  }

  pipeline(d, t) {
    const n = d.tickets.length, done = d.tickets.filter(x => x.lane === "done" || x.lane === "wontfix").length;
    const steps = [
      ["Domain", `${d.terms}T · ${d.adrs} ADR`, d.terms || d.adrs],
      ["Spec", d.spec ? `${d.stories} stories` : "none", d.spec],
      ["Tickets", `${n}`, n > 0],
      ["Build", `${done}/${n}`, n > 0 && done === n],
      ["Ship", d.shipped ? "in main" : "not merged", d.shipped],
    ];
    const firstOpen = steps.findIndex(s => !s[2]);
    return h_flex().px(12).py(10).gap(0).children(steps.map(([label, sub, ok], i) =>
      this.stage(label, sub, ok ? "done" : i === firstOpen ? "now" : "todo", t, i === steps.length - 1)));
  }

  nowCard(d, t) {
    const c = d.current;
    const card = v_flex().mx(10).p(10).gap(6).rounded(8).bg(t.surface).border_1().border_color(c ? t.working : t.border);
    const git = h_flex().gap(8).text_size(11).text_color(t.dim)
      .child(div().truncate().min_w(0).child(`⎇ ${d.branch || "detached"}`))
      .when(Boolean(d.ahead), el => el.child(div().flex_none().child(`↑${d.ahead.count} vs ${d.ahead.of}`)))
      .child(div().flex_none().text_color(d.dirty ? t.blocked : t.dim).child(d.dirty ? `${d.dirty} uncommitted` : "clean"));
    if (!c) {
      const next = d.tickets.find(x => x.lane === "next");
      return card.child(div().text_size(11).text_color(t.dim).child("NOW"))
        .child(div().text_size(13).child(next ? `Nothing in progress. Next up: ${next.num} ${next.title}` : "Nothing in progress"))
        .child(git);
    }
    return card.id("now-card").cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.showTicket(c, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(10).font_semibold().text_color(t.working).child("NOW"))
        .child(div().flex_1())
        .child(this.chip(c.status, t.muted, t)))
      .child(div().text_size(14).font_semibold().child(`${c.num} · ${c.title}`))
      .child(h_flex().gap(8).items_center()
        .child(this.segments(t, c.checked, c.total, t.working, "now-seg"))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(c.total ? `${c.checked}/${c.total} criteria` : "no checklist")))
      .child(git);
  }

  noteCard(d, t) {
    if (!d.note) return div();
    return v_flex().mx(10).mt(8).px(10).py(8).gap(3).rounded(8).bg(t.surface)
      .child(div().text_size(10).text_color(t.dim).child(`LAST SESSION NOTE · ${d.note.head}`))
      .child(div().text_size(12).text_color(t.muted).child(d.note.body.length > 320 ? d.note.body.slice(0, 320) + "…" : d.note.body));
  }

  row(x, t) {
    const color = this.laneColor(x.lane, t);
    const extra = x.lane === "blocked" ? `waits on ${x.waitingOn.join(", ")}`
      : x.lane === "you" ? x.status : x.lane === "active" && x.branch ? x.branch : null;
    return h_flex().id(`t-${x.num}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.showTicket(x, cx))
      .child(div().w(22).flex_none().text_size(11).font_semibold().text_color(color).child(x.num))
      .child(div().flex_1().min_w(0).truncate().text_color(x.lane === "done" || x.lane === "blocked" ? t.muted : t.foreground).child(x.title))
      .when(Boolean(extra), el => el.child(div().flex_none().max_w(110).truncate().text_size(10).text_color(t.dim).child(extra)))
      .when(x.followUps, el => el.child(this.chip("follow-ups", t.blocked, t)))
      .when(x.total > 0, el => el.child(div().flex_none().w(30).text_right().text_size(10).text_color(t.dim).child(`${x.checked}/${x.total}`)))
      .when(x.lane === "next", el => el.child(this.submitButton(x, t, `submit-${x.num}`)));
  }

  lanes(d, t) {
    return v_flex().px(6).pt(10).gap(2).children(LANES.flatMap(([id, label]) => {
      const items = d.tickets.filter(x => x.lane === id);
      if (!items.length) return [];
      const closed = this.collapsed.has(id), color = this.laneColor(id, t);
      return [
        h_flex().id(`lane-${id}`).h(26).px(8).gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => { closed ? this.collapsed.delete(id) : this.collapsed.add(id); cx.notify(); })
          .child(svg(`mods/mattpocock-workflow/chevron-${closed ? "right" : "down"}.svg`).size(10).text_color(t.dim))
          .child(div().size(7).rounded_full().bg(color))
          .child(div().text_size(11).font_semibold().text_color(t.muted).child(label.toUpperCase()))
          .child(div().text_size(11).text_color(t.dim).child(String(items.length))),
        ...(closed ? [] : items.map(x => this.row(x, t))),
      ];
    }));
  }

  // The ticket as markdown chunks and checkbox lines, in file order, so boxes can be ticked in place.
  pieces(text) {
    const out = [], buf = [];
    let fence = false;
    const flush = () => { if (buf.join("").trim()) out.push({ md: buf.join("\n") }); buf.length = 0; };
    text.split("\n").forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const m = fence ? null : /^(\s*)[-*] \[([ xX])\] (.*)$/.exec(line);
      if (!m) { buf.push(line); return; }
      flush();
      out.push({ line: i, raw: line, indent: m[1].length, done: m[2] !== " ", text: m[3] });
    });
    flush();
    return out;
  }

  // Flips one box in the file on disk, refusing if the line changed since it was shown.
  toggleBox(x, box, cx) {
    if (this.on) { notify({ title: "Can't edit a ticket on another machine", level: "warning" }); return; }
    cx.spawn(async cx => {
      try {
        const current = await readTextFile(x.path);
        if (current == null) throw new Error("The ticket file is gone");
        const lines = current.split("\n");
        if (lines[box.line] !== box.raw) throw new Error("The ticket changed on disk; showing the new version");
        lines[box.line] = box.raw.replace(/\[([ xX])\]/, box.done ? "[ ]" : "[x]");
        const next = lines.join("\n");
        await writeTextFile(x.path, next, current);
        const fresh = { ...x, ...parseTicket(x.file, next) };
        this.data.tickets = this.data.tickets.map(y => y.file === x.file ? fresh : y);
        if (this.data.current?.file === x.file) this.data.current = fresh;
        if (this.open?.file === x.file) this.open = fresh;
      } catch (e) {
        notify({ title: "Checkbox not saved", body: String(e?.message ?? e), level: "warning" });
        this.refresh(cx);
      } finally { cx.notify(); }
    });
  }

  box(x, b, t) {
    return h_flex().id(`box-${b.line}`).pl(4 + b.indent * 8).pr(6).py(4).gap(8).items_start().rounded(6)
      .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.toggleBox(x, b, cx))
      .child(div().mt(2).size(15).flex_none().rounded(4).border_1().flex().items_center().justify_center()
        .border_color(b.done ? t.done : t.input).bg(b.done ? t.done : t.background)
        .text_size(11).text_color(t.background).child(b.done ? "✓" : ""))
      .child(div().flex_1().min_w(0).text_color(b.done ? t.muted : t.foreground)
        .child(TextView.markdown(`boxmd-${x.file}-${b.line}`, b.text)));
  }

  detail(t) {
    const x = this.open;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.chip(x.lane === "you" ? "needs you" : x.lane, this.laneColor(x.lane, t), t))
        .when(x.total > 0, el => el.child(this.segments(t, x.checked, x.total, this.laneColor(x.lane, t), "detail-seg"))
          .child(div().flex_none().text_size(11).text_color(t.muted).child(`${x.checked}/${x.total}`)))
        .when(!x.total, el => el.child(div().flex_1()))
        .child(div().flex_none().max_w(200).truncate().text_size(11).text_color(t.dim).child(x.file))
        .when(x.lane === "next", el => el.child(this.submitButton(x, t, "submit-detail"))))
      .child(v_flex().id("wf-detail").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(2)
        .children(this.pieces(x.text).map((p, i) => p.md != null
          ? TextView.markdown(`md-${x.file}-${i}`, p.md).selectable(true)
          : this.box(x, p, t))));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), d = this.data;
    const total = d?.tickets?.length ?? 0, done = d?.tickets?.filter(x => x.lane === "done").length ?? 0;

    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.open), el => el.child(div().id("wf-back").w(20).cursor_pointer().text_color(t.muted)
        .on_click((_e, cx) => { this.open = null; cx.notify(); }).child("←")))
      .child(div().font_semibold().child(this.open ? `${this.open.num} · ${this.open.title}` : "Workflow"))
      .when(!this.open && total > 0, el => el.child(div().text_size(11).text_color(t.dim).child(`${done}/${total} done`)))
      .child(div().flex_1())
      .when(!this.open && (d?.efforts?.length ?? 0) > 0, el => el.children(d.efforts.map(e =>
        div().id(`effort-${e}`).px(8).h(22).flex().items_center().rounded(6).text_size(11).cursor_pointer()
          .bg(e === d.effort ? t.selected : t.background).text_color(e === d.effort ? t.foreground : t.dim)
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.pickEffort(e, cx)).child(e))));

    const root = v_flex().id("workflow").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).child(header);

    if (this.open) return root.child(this.detail(t));
    if (!d) return root.child(div().p(14).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Reading the tracker…" : "No folder")));
    if (!d.efforts?.length) return root.child(v_flex().p(14).gap(6).text_size(12).text_color(t.dim)
      .child(div().child("No .scratch/ tracker in this repo."))
      .child(div().child("Specs and tickets appear here once a skill publishes them to .scratch/<feature>/.")));

    return root.child(v_flex().id("wf-body").flex_1().min_h(0).overflow_y_scrollbar().pb(10)
      .child(this.pipeline(d, t))
      .child(this.nowCard(d, t))
      .child(this.noteCard(d, t))
      .child(this.lanes(d, t))
      .when(d.specStatus || d.map, el => el.child(h_flex().px(16).pt(10).gap(10).text_size(10).text_color(t.dim)
        .when(Boolean(d.specStatus), el => el.child(div().child(`spec: ${d.specStatus}`)))
        .when(d.map, el => el.child(div().child("map.md present"))))));
  }
}
