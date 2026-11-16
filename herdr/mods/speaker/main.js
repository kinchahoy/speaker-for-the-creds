// Speaker's approvals in Herdr: a docked bar ("Speaker · 1 approval · 4 bottle agents") and, on click, this mod as a dialog
// (props { inbox: true }): sign-in, Needs attention, Current agents with their grants, Recently finished, Connections
// (shared state "speaker.settings"), New agent. Web deep links use speaker's public URL (from sign-in); the browser UI
// refuses other addresses. The token stays in memory, never on disk. Bind a key: "alt-s": "mod.open:speaker".
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Button } from "gpui-base";
import { writeFile } from "fs/promises";
import { appHome, closeOverlay, exec, nextCommand, notify, openOverlay, props, run, setShared, shared, terminals, theme } from "herdr";

const settings = () => shared("speaker.settings"); // { url, bottle, machine } once saved in the inbox
let token; // the owner API bearer token; gone when Herdr quits, the speaker URL changes, or speaker answers 401
let publicUrl; // speaker's PUBLIC_URL, from the same sign-in

// Debug log: the last 300 calls (no password, token or body), rewritten to ~/.config/herdr-app/speaker.log.
const lines = [];
let writing = Promise.resolve();
const log = (line) => {
  lines.push(`${new Date().toISOString()} ${line}`);
  lines.splice(0, lines.length - 300);
  const text = `${lines.join("\n")}\n`;
  writing = writing.then(() => writeFile(`${appHome()}/speaker.log`, text)).catch((error) => console.log(`speaker.log: ${error.message}`));
};

async function api(path, body) {
  const url = `${settings().url}/admin/api${path}`;
  const what = `speaker ${body ? "POST" : "GET"} ${url} ->`;
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  }).catch((error) => {
    log(`${what} ${error.message}`);
    throw error;
  });
  log(`${what} ${response.status}${token ? "" : " (no token)"}`);
  if (response.status === 401 && token) {
    token = undefined;
    throw new Error("signed out; sign in again");
  }
  if (!response.ok) {
    // speaker's errors are JSON; its sign-in rate limit (429) answers plain text
    const text = (await response.text()).trim();
    let message = text;
    try {
      message = JSON.parse(text).message;
    } catch {}
    log(`  ${message}`);
    throw new Error(message || `speaker answered ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}
// Runs a program; a failure throws its stderr (or stdout) so the inbox shows it.
// bottle runs on the machine named in Settings (a Herdr machine from `hc machine ls`), or here when it is empty.
const machine = () => settings()?.machine || undefined;
const onMachine = () => (machine() ? ["--on", machine()] : []); // for hc run
const must = async (command, args, on) => {
  const what = `run ${command} ${args.slice(0, 4).join(" ")}${on ? ` on ${on}` : ""} ->`;
  const r = await exec(command, args, { on }).catch((error) => {
    log(`${what} ${error.message}`);
    throw error;
  });
  log(`${what} exit ${r.code}${r.code ? `: ${(r.stderr || r.stdout).trim().split("\n")[0]}` : ""}`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `${command} exited ${r.code}`);
  return r;
};
const openInbox = () => openOverlay({ mod: "speaker", kind: "dialog", width: 520, height: 0.8, props: { inbox: true } });
const closed = ["closing", "archived", "failed-archive"]; // bottle agents that are over
const span = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);
const ago = (when) => `${span(Date.now() - (typeof when === "string" ? Date.parse(when) : when))} ago`; // epoch ms or ISO
const left = (iso) => (iso ? `${Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000))}m left` : "until revoked");
// bottle run -d can outlast exec's 30 s limit, so it runs in a bottle-space terminal (removed on success; on failure it waits for Enter).
const startScript = 'bottle "$@" || { echo; echo "bottle run failed; press Enter to close"; read -r _; }';

export default class Speaker extends View {
  init(_props, cx) {
    this.inbox = Boolean(props()?.inbox || props()?.overlay); // any overlay copy (mod.open, the palette) is the inbox; only the docked copy is the bar
    log(`${this.inbox ? "inbox" : "bar"} start: speaker ${settings()?.url}, bottle ${settings()?.bottle}, machine ${machine()}`);
    this.pending = [];
    this.grants = [];
    this.agents = []; // bottle's open agents
    this.finished = []; // its last few closed ones
    this.templates = [];
    this.models = [];
    this.highlight = new Set(); // request ids whose cards are marked (from an agent's "waiting for approval")
    this.chosen = {}; // request id -> duration
    this.seen = new Set();
    this.shown = new Set(settings()?.url ? [] : ["conn"]); // open disclosures
    if (this.inbox) {
      const field = (placeholder, value = "") => InputState.new({ placeholder, value });
      this.password = InputState.new({ placeholder: "Owner password" });
      this.password.set_masked(true);
      this.password.on("submit", (_e, cx) => this.signIn(cx));
      this.urlInput = field("e.g. https://speaker.example.com or a tailnet address", settings()?.url);
      this.bottleInput = field("usually empty; only when bottle's control API is reachable from here, e.g. http://127.0.0.1:7001", settings()?.bottle);
      this.machineInput = field("a name from hc machine ls, e.g. nuc10i5 (not a web address; empty: this computer)", settings()?.machine);
      for (const input of [this.urlInput, this.bottleInput, this.machineInput]) input.on("submit", (_e, cx) => this.save(cx));
      this.prompt = TextareaState.new({ placeholder: "optional task for the agent", rows: 3 });
      this.folders = field("optional, comma-separated: ~/code/proj:rw, ~/docs");
      if (!settings()?.url) this.urlInput.focus();
      this.loadTemplates(cx);
    } else cx.spawn(async (cx) => { for (;;) if ((await nextCommand()) === "open") openInbox(); });
    const refresh = (cx) => this.act(cx, async () => {});
    refresh(cx);
    cx.timer.every(10_000, refresh);
  }

  // Runs an action, then reloads speaker and bottle independently (a failure keeps that side's last data, shown stale).
  act(cx, action) {
    cx.spawn(async (cx) => {
      try {
        await action();
        this.error = undefined;
      } catch (error) {
        this.error = error.message;
      }
      await Promise.all([this.loadSpeaker(), this.loadAgents()]);
      if (!this.inbox)
        for (const r of this.pending.filter((r) => !this.seen.has(r.id))) {
          this.seen.add(r.id);
          notify({ title: `${r.who.label} asks for access`, body: r.items.map((i) => i.item).join(", "), level: "warning", action: { name: "speaker.open" } });
        }
      cx.notify();
    });
  }

  async loadSpeaker() {
    if (!token || !settings()?.url) return;
    try {
      this.pending = (await api("/pending")).pending;
      if (this.inbox) this.grants = (await api("/active")).grants;
      [this.speakerAt, this.speakerErr] = [Date.now()];
    } catch (error) {
      this.speakerErr = error.message;
    }
  }

  async loadAgents() {
    // A local bottle needs no URL; one on another machine without a URL is asked through its own CLI there.
    const bottle = settings()?.bottle || (machine() ? "bottle ls --json" : "http://127.0.0.1:7001");
    try {
      let state;
      if (bottle.startsWith("http")) {
        const response = await fetch(`${bottle}/api/state`);
        log(`bottle ${bottle} -> ${response.status}`);
        if (!response.ok) throw new Error(`bottle answered ${response.status}`);
        state = await response.json();
      } else state = JSON.parse((await must("bottle", ["ls", "--json"], machine())).stdout);
      this.agents = state.agents.filter((a) => !closed.includes(a.state));
      this.finished = state.finished;
      [this.bottleAt, this.bottleErr] = [Date.now()];
    } catch (error) {
      log(`bottle ${bottle} -> ${error.message}`);
      // A set URL wins over the machine, so say how to get back to the machine's own command.
      this.bottleErr = bottle.startsWith("http") && machine() ? `${error.message} (clear Bottle URL to ask through ${machine()})` : error.message;
    }
  }

  loadTemplates(cx) {
    this.startNote = undefined;
    cx.spawn(async (cx) => {
      try {
        ({ templates: this.templates, models: this.models } = JSON.parse((await must("bottle", ["templates", "--json"], machine())).stdout));
      } catch (error) {
        this.startNote = `bottle templates: ${error.message}`;
      }
      cx.notify();
    });
  }

  signIn(cx) {
    if (this.signingIn || !this.password.value()) return;
    this.signingIn = true;
    cx.notify();
    this.act(cx, async () => {
      try {
        ({ token, publicUrl } = await api("/signin", { password: this.password.value() }));
        this.password.set_value("");
        this.reveal(false); // act re-renders afterwards
      } finally {
        this.signingIn = false;
      }
    });
  }

  reveal(on) {
    this.revealed = on;
    this.password.set_masked(!on);
  }

  save(cx) {
    this.act(cx, async () => {
      const clean = (input) => input.value().trim().replace(/\/$/, "");
      const next = { url: clean(this.urlInput), bottle: clean(this.bottleInput), machine: clean(this.machineInput) };
      if (!next.url) throw new Error("Speaker URL is required");
      if (next.url !== settings()?.url) {
        token = publicUrl = undefined;
        this.pending = [];
        this.grants = [];
        this.speakerAt = this.speakerErr = undefined;
      }
      if (next.bottle !== settings()?.bottle || next.machine !== settings()?.machine) {
        this.agents = [];
        this.finished = [];
        this.bottleAt = this.bottleErr = undefined;
      }
      setShared("speaker.settings", next);
      this.loadTemplates(cx);
    });
  }

  // Focuses the agent's terminal (named like bottle's CLI does), starting it first if needed.
  openAgent(cx, id) {
    this.act(cx, async () => {
      const find = () => terminals().find((t) => t.name === `pi-${id}`);
      if (!find()) {
        await exec("hc", ["run", ...onMachine(), "--bg", "--no-parent", "--name", `pi-${id}`, "--label", "herdr.space=bottle", "--label", `herdr.tab=${id}`, "--", "bottle", "attach", id]);
        for (let i = 0; i < 10 && !find(); i++) await exec("sleep", ["0.3"], { on: machine() }); // Windows has no sleep; the bottle machine does
      }
      if (!find()) throw new Error(`terminal pi-${id} did not appear`);
      run("pane.focus", { terminal: find().address });
      closeOverlay(props().overlay);
    });
  }

  openArchive(a) {
    if (machine()) run("space.new", { machine: machine(), folder: a.outputDir, name: a.name });
    else run("tab.new", { folder: a.outputDir, name: a.name });
    closeOverlay(props().overlay);
  }

  start(cx, template, model) {
    if (this.launching) return;
    this.launching = true;
    cx.notify();
    this.act(cx, async () => {
      try {
        const name = `start-${template}`;
        const prompt = this.prompt.value().trim();
        const folders = this.folders.value().split(",").map((f) => f.trim()).filter(Boolean).flatMap((f) => ["-f", f]);
        await must("hc", ["run", ...onMachine(), "--bg", "--rm", "--no-parent", "--name", name, "--label", "herdr.space=bottle", "--label", `herdr.tab=${name}`,
          "--", "sh", "-c", startScript, "sh", "run", "-d", "-t", template, "-m", model, ...folders, ...(prompt ? ["--", prompt] : [])]);
        this.prompt.set_value("");
        this.folders.set_value("");
        this.view = undefined;
        this.note = `Launch accepted: ${template} on ${model}; tab ${name} in the bottle space shows progress.`;
      } finally {
        this.launching = false;
      }
    });
  }

  render() {
    const t = theme();
    const ready = Boolean(settings()?.url);
    if (!this.inbox) {
      const waiting = token ? this.pending.length : 0;
      const oldest = waiting ? Date.now() - Math.min(...this.pending.map((r) => r.createdAt)) : 0;
      const speakerPart = !ready ? "set up" : !token ? "sign in" : this.speakerErr ? "unreachable" : waiting ? `${waiting} approval${waiting > 1 ? "s" : ""}` : "no approvals";
      const bottlePart = this.bottleErr ? "bottle unreachable" : this.bottleAt && `${this.agents.length} bottle agent${this.agents.length === 1 ? "" : "s"}`;
      return h_flex().id("speaker").size_full().px(14).items_center().bg(t.chrome).border_t(1).border_color(t.border)
        .text_size(11.8).text_color(this.error || this.speakerErr || oldest >= 5 * 60_000 ? t.blocked : waiting ? t.foreground : t.muted)
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => openInbox())
        .child(["Speaker", speakerPart, bottlePart].filter(Boolean).join(" · "));
    }
    const button = (id, label, primary, onClick) => Button.new(id).flex().items_center().h(28).px(12).rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12).child(label).disabled(!onClick)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
      .when(!onClick, (el) => el.opacity(0.45));
    const web = (anchor) => publicUrl && ((_e, cx) => cx.open_url(`${publicUrl.replace(/\/$/, "")}/admin${anchor}`)); // dimmed until sign-in
    const heading = (text) => div().pt(10).text_size(11.5).text_color(t.dim).child(text);
    const note = (text, color = t.dim) => div().text_size(11.5).text_color(color).child(text);
    const revokeAll = (key, id) => h_flex().pl(8).child(button(`ra-${key}`, "Revoke all (web)", false, web(`#agent-${id}`)));
    const field = (state) => Input.new(state).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background);
    const labeled = (label, input) => v_flex().gap(4).child(note(label, t.muted)).child(input);
    const withButton = (state, ...btns) => h_flex().gap(8).items_center().child(div().flex_1().child(field(state))).children(btns);
    // A row of choices, [value, label, usable?]; the chosen one is lit.
    const chips = (id, items, current, pick) => h_flex().gap(4).flex_wrap().children(items.map(([value, label, usable = true]) => {
      const on = current === value;
      return div().id(`${id}-${value}`).px(7).py(2).rounded(5).text_size(11.5).bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted)
        .when(usable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(value, cx))).opacity(usable ? 1 : 0.5).child(label);
    }));
    const disclosure = (key, title, body) => {
      const on = this.shown.has(key);
      return v_flex().gap(6).child(heading(`${on ? "▾" : "▸"} ${title}`).id(`disc-${key}`).cursor_pointer()
        .on_click((_e, cx) => { this.shown[on ? "delete" : "add"](key); cx.notify(); })).when(on, (el) => el.child(body()));
    };
    const stale = (err, at) => (err ? `unreachable${at ? `, stale (${ago(at)})` : ""}: ${err}` : at ? `connected, ${ago(at)}` : "not loaded");
    // Title and summary are untrusted text; the short id tells equal names apart.
    const pool = [...this.agents, ...this.finished].map((a) => a.title ?? a.name);
    const nameOf = (a) => (pool.filter((n) => n === (a.title ?? a.name)).length > 1 ? `${a.title ?? a.name} (${a.id.slice(0, 6)})` : (a.title ?? a.name));
    const card = (r) => v_flex().gap(6).p(12).rounded(9).border_1().border_color(this.highlight.has(r.id) ? t.accent : t.border).bg(t.surface)
      .child(h_flex().justify_between().child(div().font_semibold().child(r.who.label)).child(div().text_color(t.dim).text_size(11.5).child(ago(r.createdAt))))
      .child(note([r.who.says, r.who.via && `via ${r.who.via}`, `from ${r.who.source || "unknown address"}`].filter(Boolean).join(" · ")))
      .children(r.items.map((i) => v_flex()
        .child(h_flex().gap(6).child(div().text_color(t.accent).child(i.item)).when(Boolean(i.risk), (el) => el.child(div().text_color(t.blocked).child(i.risk))))
        .child(div().text_color(t.muted).child(i.text))
        .when(Boolean(i.warning), (el) => el.child(div().text_color(t.blocked).child(i.warning)))))
      .when(r.type === "agent", (el) => el.child(div().text_color(r.reason ? t.foreground : t.dim).child(r.reason || "No reason given")))
      .when(r.durations.length > 1, (el) => el.child(chips(`d-${r.id}`, r.durations.map((d) => [d, d]), this.chosen[r.id] ?? r.duration, (d, cx) => { this.chosen[r.id] = d; cx.notify(); })))
      .child(h_flex().gap(8).pt(4)
        .child(button(`a-${r.id}`, "Approve as asked", true, (_e, cx) => this.act(cx, () => api(`/requests/${r.id}/approve`, { duration: this.chosen[r.id] ?? r.duration }))))
        .child(button(`n-${r.id}`, "Deny", false, (_e, cx) => this.act(cx, () => api(`/requests/${r.id}/deny`, {}))))
        .child(button(`b-${r.id}`, "Pick items in web", false, web(`#request-${r.id}`))));
    const grantRow = (g) => h_flex().gap(8).items_center().pl(8)
      .child(div().flex_1().truncate().child(g.item)).child(div().text_color(g.risk ? t.blocked : t.dim).child(g.risk ?? "access")).child(div().text_color(t.dim).child(left(g.expiresAt)))
      .child(button(`x-${g.id}`, "Extend", false, web(`#grant-${g.id}`)))
      .child(button(`r-${g.id}`, "Revoke", false, (_e, cx) => this.act(cx, () => api(`/grants/${g.id}/revoke`, {}))));
    const grantsOf = (subject) => this.grants.filter((g) => g.subject === subject);
    const agent = (a) => {
      const waits = a.pendingRequests.length > 0;
      const mine = grantsOf(a.speakerAgentId);
      return v_flex().gap(3).py(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().child(div().flex_1().truncate().font_semibold().child(nameOf(a)))
          .child(button(`join-${a.id}`, "Join", true, (_e, cx) => this.openAgent(cx, a.id)))
          .child(this.confirm === a.id
            ? h_flex().gap(4).child(button(`stop-${a.id}`, "Close and archive", false, (_e, cx) => (this.confirm = undefined, this.act(cx, () => must("bottle", ["stop", a.id], machine())))))
              .child(button(`keep-${a.id}`, "Keep", false, (_e, cx) => (this.confirm = undefined, cx.notify())))
            : button(`ask-${a.id}`, "Close…", false, (_e, cx) => (this.confirm = a.id, cx.notify()))))
        .child(h_flex().gap(6).child(div().id(`state-${a.id}`).text_color(waits ? t.blocked : t.muted).cursor_pointer()
          .on_click((_e, cx) => { this.highlight = new Set(a.pendingRequests.map((p) => p.id)); cx.notify(); }).child(waits ? "waiting for approval" : a.state))
          .child(note(`${a.model} · ${span(Date.now() - Date.parse(a.startedAt))}`)))
        .when(Boolean(a.summary), (el) => el.child(div().truncate().text_color(t.muted).child(`Latest: ${a.summary.slice(0, 120)}`)))
        // Launch-time extensions never reach speaker; only this line shows them.
        .when(Boolean(a.launchGrants?.length), (el) => el.child(note(`given at launch by the template: ${a.launchGrants.join(", ")}`)))
        .children(mine.map(grantRow))
        .when(Boolean(a.speakerAgentId && mine.length), (el) => el.child(revokeAll(a.id, a.speakerAgentId)));
    };
    const known = new Set(this.agents.map((a) => a.speakerAgentId));
    const direct = [...new Set(this.grants.map((g) => g.subject))].filter((s) => !known.has(s)); // no bottle row
    const failures = this.finished.filter((a) => a.state === "failed-archive");
    const finishedRow = (a) => h_flex().gap(8).items_center().py(2)
      .child(div().flex_1().truncate().child(nameOf(a))).child(note(a.model ?? ""))
      .child(note(a.state === "archived" ? "Archived" : "Archive failed", a.state === "archived" ? t.muted : t.blocked)).child(note(a.closedAt ? ago(a.closedAt) : ""))
      .child(button(`oa-${a.id}`, "Open archive", false, () => this.openArchive(a)));
    const editConnections = () => v_flex().gap(6)
            .child(labeled("Speaker URL", field(this.urlInput)))
      .child(labeled("Bottle machine: the Herdr machine bottle runs on; its bottle command is run there", field(this.machineInput)))
      .child(labeled("Bottle URL: optional, a direct address for bottle's control API in place of that command", field(this.bottleInput)))
      .child(h_flex().gap(8).pt(4).child(button("save", "Save", true, (_e, cx) => this.save(cx))).child(note("A new speaker URL signs out.")));
    const header = (title, ...btns) => h_flex().justify_between().items_center().child(div().text_size(15).font_semibold().child(title)).child(h_flex().gap(6).children(btns));
    const shell = () => v_flex().id("inbox").size_full().p(16).gap(8).bg(t.popover).text_color(t.foreground).text_size(12.5).overflow_y_scrollbar()
      .when(Boolean(this.error), (el) => el.child(note(this.error, t.blocked)));

    if (this.view === "new") {
      const tpl = this.templates.find((x) => x.id === this.tpl) ?? this.templates[0];
      const alias = (m) => m.alias ?? m.id;
      const model = this.models.find((m) => alias(m) === (this.model ?? tpl?.model)) ?? this.models[0];
      const go = tpl && model?.up ? (_e, cx) => this.start(cx, tpl.id, alias(model)) : undefined;
      const back = (_e, cx) => (this.view = undefined, cx.notify());
      return shell().child(header("New agent", button("back", "Back", false, back)))
        .when(Boolean(this.startNote), (el) => el.child(note(this.startNote, t.blocked)).child(h_flex().child(button("retry", "Retry", false, (_e, cx) => (this.loadTemplates(cx), cx.notify())))))
        .child(note(`Machine: ${machine() ?? "this computer"}. Execution: detached (bottle run -d); approvals wait in Speaker.`))
        .child(labeled("Template", chips("tpl", this.templates.map((x) => [x.id, x.id]), tpl?.id, (id, cx) => (this.tpl = id, cx.notify()))))
        .when(Boolean(tpl), (el) => el.child(note(tpl.label, t.muted))
          .when(Boolean(tpl.extensions?.length), (el) => el.child(note(`Held from launch: ${tpl.extensions.join(", ")}`))))
        .child(labeled("Model", chips("mdl", this.models.map((m) => [alias(m), m.up ? alias(m) : `${alias(m)} · down`, m.up]), model && alias(model), (m, cx) => (this.model = m, cx.notify()))))
        .when(Boolean(model), (el) => el.child(note(`${model.label} (${model.id})${model.up ? "" : ": not running, so it cannot start"}`, model.up ? t.dim : t.blocked)))
        .child(labeled("Task", Textarea.new(this.prompt).h(70).px(10).rounded(8).border_1().border_color(t.input).bg(t.background)))
        .child(labeled("Extra folders", field(this.folders)))
        .child(note("e.g. ~/code/proj:rw, ~/docs (read-only unless :rw). ~/agent-space is always read-write."))
        .child(h_flex().gap(8).pt(6).child(button("start", this.launching ? "Starting…" : "Start agent", true, this.launching ? undefined : go))
          .child(button("cancel", "Cancel", false, back)));
    }

    const pending = [...this.pending].sort((a, b) => this.highlight.has(b.id) - this.highlight.has(a.id));
    const attention = token ? pending.length + failures.length : 0;
    const signedOut = ready && !token;
    return shell()
      .child(header("Speaker", button("new", "New agent", true, (_e, cx) => (this.view = "new", cx.notify())), button("web", "Web", false, web("")), button("close", "Close", false, () => closeOverlay(props().overlay))))
      .child(note(`Speaker: ${!ready ? "not set up" : !token ? "signed out" : stale(this.speakerErr, this.speakerAt)} · Bottle: ${stale(this.bottleErr, this.bottleAt)}`))
      .when(Boolean(this.note), (el) => el.child(note(this.note, t.muted)))
      .when(signedOut, (el) => el.child(heading("Sign in to decide requests"))
        .child(labeled("Owner password", withButton(this.password,
          button("reveal", this.revealed ? "Hide" : "Show", false, (_e, cx) => (this.reveal(!this.revealed), cx.notify())),
          button("signin", this.signingIn ? "Signing in…" : "Sign in", true, this.signingIn ? undefined : (_e, cx) => this.signIn(cx))))))
      .when(Boolean(token), (el) => el.child(heading(attention ? `Needs attention (${attention})` : "Nothing needs attention"))
        .children(pending.map(card))
        .children(failures.map((a) => note(`Archive failed: ${nameOf(a)} (open Recently finished)`, t.blocked))))
      .when(ready, (el) => el.child(heading(`Current agents (${this.agents.length})`))
        .children(this.agents.map(agent))
        .children(direct.map((subject) => v_flex().gap(3).py(6)
          .child(div().font_semibold().child(`${grantsOf(subject)[0].who.label} (no bottle row)`))
          .children(grantsOf(subject).map(grantRow))
          .child(revokeAll(subject, subject)))))
      .when(ready && this.finished.length > 0, (el) => el.child(disclosure("finished", `Recently finished (${this.finished.length})`, () => v_flex().children(this.finished.map(finishedRow)))))
      .child(disclosure("conn", "Connections and sign-in", editConnections));
  }
}
