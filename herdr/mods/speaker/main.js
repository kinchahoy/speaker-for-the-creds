// Speaker's approvals in Herdr. A bottom bar ("speaker · 2 waiting (oldest 4m)") polls speaker's owner API every 10 s,
// posts a toast per new request, and opens the inbox (this mod again, as a dialog with props { inbox: true }, polling
// every 10 s): approve as asked, deny, revoke, or open the card in the browser. The inbox also has bottle's open agents
// (Stop; click one to focus its terminal pi-<id>, or its pending request card), the last few finished ones (click opens
// their archive folder in a new tab), a Start section (templates and models from `bottle templates --json`), and Settings
// (speaker URL, bottle URL, bottle machine: Herdr's shared state "speaker.settings"). The owner password is typed once per Herdr start;
// the token stays in this module's memory, never on disk. Bind a key in keys.json: "alt-s": "mod.open:speaker".
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, exec, nextCommand, notify, openOverlay, props, run, setShared, shared, terminals, theme } from "herdr";

const settings = () => shared("speaker.settings"); // { url, bottle } once saved in the inbox
let token; // the owner API bearer token; gone when Herdr quits, the speaker URL changes, or speaker answers 401

async function api(path, body) {
  const response = await fetch(`${settings().url}/admin/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  if (response.status === 401 && token) {
    token = undefined;
    throw new Error("signed out; sign in again");
  }
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? `speaker answered ${response.status}`);
  return response.status === 204 ? null : response.json();
}
// Runs a program; a failure throws its stderr (or stdout) so the inbox shows it.
// bottle runs on the machine named in Settings (a Herdr machine from `hc machine ls`), or here when it is empty.
const machine = () => settings()?.machine || undefined;
const onMachine = () => (machine() ? ["--on", machine()] : []); // for hc run
const must = async (command, args, on) => {
  const r = await exec(command, args, { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `${command} exited ${r.code}`);
  return r;
};
const openInbox = () => openOverlay({ mod: "speaker", kind: "dialog", width: 520, height: 0.8, props: { inbox: true } });
const closed = ["closing", "archived", "failed-archive"]; // bottle agents that are over
const minutes = (ms) => `${Math.max(1, Math.round(ms / 60_000))}m`;
const since = (iso) => minutes(Date.now() - Date.parse(iso));
const ago = (ms) => `${minutes(Date.now() - ms)} ago`;
const left = (iso) => (iso ? `${Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000))}m left` : "until revoked");
// bottle run -d can outlast exec's 30 s limit (cold start of bottle and the VM), so it runs in a terminal of the bottle space
// (removed when it succeeds; on failure it waits for Enter so the error stays readable).
const startScript = 'bottle "$@" || { echo; echo "bottle run failed; press Enter to close"; read -r _; }';

export default class Speaker extends View {
  init(_props, cx) {
    this.inbox = Boolean(props()?.inbox || props()?.overlay); // any overlay copy (mod.open, the palette) is the inbox; only the docked copy is the bar
    this.pending = [];
    this.grants = [];
    this.agents = []; // bottle's open agents
    this.finished = []; // its last few closed ones
    this.agentsNote = ""; // why there are none to show
    this.templates = [];
    this.models = [];
    this.startNote = "";
    this.highlight = new Set(); // request ids whose cards are marked (from an agent's "waiting for approval")
    this.chosen = {}; // request id -> duration
    this.seen = new Set();
    if (this.inbox) {
      const field = (placeholder, value) => {
        const input = InputState.new({ placeholder });
        input.set_value(value ?? "");
        return input;
      };
      this.password = InputState.new({ placeholder: "Owner password" });
      this.password.set_masked(true);
      this.password.on("submit", (_e, cx) => this.act(cx, async () => {
        token = (await api("/signin", { password: this.password.value() })).token;
        this.password.set_value("");
      }));
      this.urlInput = field("Speaker URL, e.g. http://localhost:3000", settings()?.url);
      this.bottleInput = field("Bottle URL for listing agents (empty: http://127.0.0.1:7001 when bottle is local)", settings()?.bottle);
      this.machineInput = field("Bottle machine from hc machine ls, e.g. wsl (empty: this computer)", settings()?.machine);
      this.prompt = InputState.new({ placeholder: "Prompt for the new agent (optional)" });
      this.folders = InputState.new({ placeholder: "Extra folders, comma-separated: ~/code/proj:rw, ~/docs (optional)" });
      (settings()?.url ? this.password : this.urlInput).focus();
      this.loadTemplates(cx);
    } else cx.spawn(async (cx) => { for (;;) if ((await nextCommand()) === "open") openInbox(); });
    this.refresh(cx);
    cx.timer.every(10_000, (cx) => this.refresh(cx));
  }

  // Runs an action, then shows the inbox as speaker and bottle now have it (or the error).
  act(cx, action) {
    cx.spawn(async (cx) => {
      try {
        await action();
        await this.loadAgents();
        this.error = undefined;
        if (token) {
          this.pending = (await api("/pending")).pending;
          if (this.inbox) this.grants = (await api("/active")).grants;
        }
      } catch (error) {
        this.error = error.message;
      }
      if (!this.inbox)
        for (const r of this.pending.filter((r) => !this.seen.has(r.id))) {
          this.seen.add(r.id);
          notify({ title: `${r.who.label} asks for access`, body: r.items.map((i) => i.item).join(", "), level: "warning", action: { name: "speaker.open" } });
        }
      cx.notify();
    });
  }

  async loadAgents() {
    const bottle = settings()?.bottle || (machine() ? undefined : "http://127.0.0.1:7001"); // a local bottle needs no URL
    this.agents = [];
    this.finished = [];
    this.agentsNote = bottle ? "" : "Set the Bottle URL in Settings to list agents on a bottle machine";
    if (bottle)
      try {
        const state = await (await fetch(`${bottle}/api/state`)).json();
        this.agents = state.agents.filter((a) => !closed.includes(a.state));
        this.finished = state.finished;
        if (!this.agents.length) this.agentsNote = "No open agents";
      } catch {
        this.agentsNote = "bottle is not running";
      }
  }

  loadTemplates(cx) {
    cx.spawn(async (cx) => {
      try {
        ({ templates: this.templates, models: this.models } = JSON.parse((await must("bottle", ["templates", "--json"], machine())).stdout));
        this.startNote = "";
      } catch (error) {
        this.startNote = `bottle templates: ${error.message}`;
      }
      cx.notify();
    });
  }

  save(cx) {
    this.act(cx, async () => {
      const clean = (input) => input.value().trim().replace(/\/$/, "");
      const next = { url: clean(this.urlInput), bottle: clean(this.bottleInput), machine: clean(this.machineInput) };
      if (!next.url) throw new Error("Speaker URL is required");
      if (next.url !== settings()?.url) {
        token = undefined;
        this.pending = [];
        this.grants = [];
      }
      setShared("speaker.settings", next);
      this.loadTemplates(cx);
    });
  }

  // Focuses the agent's terminal (labelled like bottle's CLI does), starting it first if needed.
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

  start(cx, template, alias) {
    this.act(cx, async () => {
      const name = `start-${template}`;
      const prompt = this.prompt.value().trim();
      const folders = this.folders.value().split(",").map((f) => f.trim()).filter(Boolean).flatMap((f) => ["-f", f]);
      await must("hc", ["run", ...onMachine(), "--bg", "--rm", "--no-parent", "--name", name, "--label", "herdr.space=bottle", "--label", `herdr.tab=${name}`,
        "--", "sh", "-c", startScript, "sh", "run", "-d", "-t", template, "-m", alias, ...folders, ...(prompt ? ["--", prompt] : [])]);
      this.prompt.set_value("");
      this.folders.set_value("");
      this.startNote = `Starting ${template} on ${alias}; its tab ${name} in the bottle space shows progress and any error`;
    });
  }

  refresh(cx) {
    this.act(cx, async () => {});
  }

  render() {
    const t = theme();
    if (!this.inbox) {
      const waiting = token ? this.pending.length : 0;
      const oldest = waiting ? Date.now() - Math.min(...this.pending.map((r) => r.createdAt)) : 0;
      const label = this.error ?? (!settings()?.url ? "set up" : !token ? "sign in" : waiting ? `${waiting} waiting (oldest ${minutes(oldest)})` : "nothing waiting");
      return h_flex().id("speaker").size_full().px(14).items_center().bg(t.chrome).border_t(1).border_color(t.border)
        .text_size(11.8).text_color(this.error || oldest >= 5 * 60_000 ? t.blocked : waiting ? t.foreground : t.muted)
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => openInbox())
        .child(`speaker · ${label}${this.agents.length ? ` · ${this.agents.length} agents` : ""}`);
    }
    const button = (id, label, primary, onClick) => h_flex().id(id).h(28).px(12).items_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12).child(label)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
      .when(!onClick, (el) => el.opacity(0.45));
    const browser = (anchor) => (_e, cx) => cx.open_url(`${settings().url}/admin${anchor}`);
    const heading = (text) => div().pt(10).text_size(11.5).text_color(t.dim).child(text);
    const field = (state) => Input.new(state).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background);
    const card = (r) => v_flex().gap(6).p(12).rounded(9).border_1().border_color(this.highlight.has(r.id) ? t.accent : t.border).bg(t.surface)
      .child(h_flex().justify_between().child(div().font_semibold().child(r.who.label)).child(div().text_color(t.dim).text_size(11.5).child(ago(r.createdAt))))
      .child(div().text_color(t.dim).text_size(11.5).child([r.who.says, r.who.via && `via ${r.who.via}`, `from ${r.who.source || "unknown address"}`].filter(Boolean).join(" · ")))
      .children(r.items.map((i) => v_flex()
        .child(h_flex().gap(6).child(div().text_color(t.accent).child(i.item)).when(Boolean(i.risk), (el) => el.child(div().text_color(t.blocked).child(i.risk))))
        .child(div().text_color(t.muted).child(i.text))
        .when(Boolean(i.warning), (el) => el.child(div().text_color(t.blocked).child(i.warning)))))
      .when(r.type === "agent", (el) => el.child(div().text_color(r.reason ? t.foreground : t.dim).child(r.reason || "No reason given")))
      .when(r.durations.length > 1, (el) => el.child(h_flex().gap(4).children(r.durations.map((d) => {
        const on = (this.chosen[r.id] ?? r.duration) === d;
        return div().id(`d-${r.id}-${d}`).px(7).py(2).rounded(5).text_size(11.5).cursor_pointer()
          .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.chosen[r.id] = d; cx.notify(); }).child(d);
      }))))
      .child(h_flex().gap(8).pt(4)
        .child(button(`a-${r.id}`, "Approve as asked", true, (_e, cx) => this.act(cx, () => api(`/requests/${r.id}/approve`, { duration: this.chosen[r.id] ?? r.duration }))))
        .child(button(`n-${r.id}`, "Deny", false, (_e, cx) => this.act(cx, () => api(`/requests/${r.id}/deny`, {}))))
        .child(button(`b-${r.id}`, "Open in browser", false, browser(`#request-${r.id}`))));
    // A pending request id here is the speaker request id, the same as the card's.
    const waits = (a) => a.pendingRequests.length > 0;
    const agent = (a) => h_flex().id(`agent-${a.id}`).gap(8).py(3).items_center()
      .child(div().id(`open-${a.id}`).truncate().cursor_pointer().hover((s) => s.text_color(t.accent)).on_click((_e, cx) => this.openAgent(cx, a.id)).child(a.name))
      .child(div().id(`state-${a.id}`).cursor_pointer().text_color(waits(a) ? t.blocked : t.muted)
        .on_click((_e, cx) => {
          if (!waits(a)) return this.openAgent(cx, a.id);
          this.highlight = new Set(a.pendingRequests.map((p) => p.id));
          cx.notify();
        }).child(waits(a) ? "waiting for approval" : a.state))
      .child(div().text_color(t.dim).child(`${a.model} · ${since(a.startedAt)}`))
      .child(div().flex_1().truncate().text_color(t.dim).child((a.summary ?? "").slice(0, 60)))
      .child(button(`stop-${a.id}`, "Stop", false, (_e, cx) => this.act(cx, () => must("bottle", ["stop", a.id], machine()))));
    const finished = (a) => h_flex().id(`fin-${a.id}`).gap(8).py(3).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => { run("tab.new", { folder: a.outputDir, name: a.name }); closeOverlay(props().overlay); })
      .child(div().truncate().child(a.name)).child(div().text_color(t.muted).child(a.state))
      .child(div().flex_1().truncate().text_color(t.dim).child(a.model ?? ""));
    const template = (tpl) => h_flex().gap(6).items_center()
      .child(div().flex_1().truncate().child(`${tpl.id} · ${tpl.label}`))
      .children(this.models.filter((m) => m.alias).map((m) => button(`go-${tpl.id}-${m.alias}`, m.up ? m.alias : `${m.alias} · down`, m.alias === tpl.model,
        m.up ? (_e, cx) => this.start(cx, tpl.id, m.alias) : undefined)));
    const ready = Boolean(settings()?.url);
    const pending = [...this.pending].sort((a, b) => this.highlight.has(b.id) - this.highlight.has(a.id));
    return v_flex().id("inbox").size_full().p(16).gap(8).bg(t.popover).text_color(t.foreground).text_size(12.5).overflow_y_scrollbar()
      .child(h_flex().justify_between().items_center().child(div().text_size(15).font_semibold().child("Speaker"))
        .child(button("close", "Close", false, () => closeOverlay(props().overlay))))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(ready && !token, (el) => el.child(heading("Sign in to see and decide requests")).child(field(this.password)))
      .when(Boolean(token), (el) => el
        .child(heading(pending.length ? `${pending.length} waiting` : "Nothing waiting"))
        .children(pending.map(card)))
      .when(ready, (el) => el
        .child(heading("Agents"))
        .children(this.agents.map(agent))
        .when(Boolean(this.agentsNote), (el) => el.child(div().text_color(t.dim).child(this.agentsNote)))
        .when(this.finished.length > 0, (el) => el.child(heading("Recently finished")).children(this.finished.map(finished)))
        .child(heading("Start an agent"))
        .child(field(this.prompt))
        .child(field(this.folders))
        .children(this.templates.map(template))
        .when(Boolean(this.startNote), (el) => el.child(div().text_color(t.dim).child(this.startNote))))
      .when(Boolean(token), (el) => el
        .child(heading("Active"))
        .children(this.grants.map((g) => h_flex().gap(8).items_center()
          .child(div().flex_1().truncate().child(`${g.who.label} · ${g.item}`)).child(div().text_color(t.dim).child(left(g.expiresAt)))
          .child(button(`r-${g.id}`, "Revoke", false, (_e, cx) => this.act(cx, () => api(`/grants/${g.id}/revoke`, {}))))))
        .when(!this.grants.length, (el) => el.child(div().text_color(t.dim).child("No live grants"))))
      .child(heading("Settings"))
      .child(field(this.urlInput))
      .child(field(this.bottleInput))
      .child(field(this.machineInput))
      .child(h_flex().gap(8)
        .child(button("save", "Save", true, (_e, cx) => this.save(cx)))
        .when(ready, (el) => el.child(button("admin", "Open in browser", false, browser("")))));
  }
}
