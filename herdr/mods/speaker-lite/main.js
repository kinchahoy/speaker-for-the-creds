// Speaker lite: a one-line bar (click or alt-shift-s opens the overlay) that lists waiting requests with Approve / Deny / Web.
// Uses the full mod's settings ("speaker.settings": url, machine); the token lives in memory only.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Button } from "gpui-base";
import { closeOverlay, exec, nextCommand, notify, openOverlay, props, shared, theme } from "herdr";

const settings = () => shared("speaker.settings");
const open = () => openOverlay({ mod: "speaker-lite", kind: "dialog", width: 420, height: 480, props: { inbox: true } });
let token;
const seen = new Set();

async function api(path, body) {
  const response = await fetch(`${settings().url}/admin/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  if (response.status === 401 && token) token = undefined;
  if (!response.ok) throw new Error(token === undefined && response.status === 401 ? "wrong password" : ((await response.json().catch(() => null))?.message ?? `speaker answered ${response.status}`));
  return response.status === 204 ? null : response.json();
}

export default class SpeakerLite extends View {
  init(_props, cx) {
    this.inbox = Boolean(props()?.inbox || props()?.overlay);
    this.pending = [];
    this.password = InputState.new({ placeholder: "Owner password" });
    this.password.set_masked(true);
    this.password.on("submit", (_e, cx) => this.signIn(cx));
    if (!this.inbox) cx.spawn(async () => { for (;;) if ((await nextCommand()) === "open") open(); });
    this.act(cx, async () => {});
    cx.timer.every(10_000, (cx) => this.act(cx, async () => {}));
  }

  signIn(cx) {
    this.act(cx, async () => {
      ({ token } = await api("/signin", { password: this.password.value() }));
      this.password.set_value("");
    });
  }

  // Runs an action, then reloads; the last error stays visible as one line.
  act(cx, action) {
    cx.spawn(async (cx) => {
      this.error = undefined;
      try {
        await action();
        if (token && settings()?.url) {
          this.pending = (await api("/pending")).pending;
          this.offline = false;
        }
      } catch (error) {
        this.error = error.message;
        this.offline = error instanceof TypeError; // fetch failed: speaker unreachable
      }
      if (!this.inbox) {
        for (const r of this.pending.filter((r) => !seen.has(r.id))) {
          seen.add(r.id);
          notify({ title: `${r.who.label} asks for access`, body: r.items.map((i) => i.item).join("\n"), level: "warning", action: { name: "speaker-lite.open" } });
        }
        const out = await exec("bottle", ["ls", "--json"], { on: settings()?.machine || undefined }).catch(() => null);
        this.agents = out?.code === 0 ? JSON.parse(out.stdout).agents.filter((a) => !["closing", "archived", "failed-archive"].includes(a.state)).length : undefined;
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const n = this.pending.length;
    if (!this.inbox) {
      const [state, color] = !token ? ["sign in", t.muted] : this.offline ? ["offline", t.blocked] : n ? [`${n} waiting`, t.blocked] : ["ok", t.dim];
      return h_flex().id("lite").size_full().px(14).items_center().gap(8).bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
        .cursor_pointer().on_click(() => open()).child(div().text_color(t.muted).child("speaker")).child(div().text_color(color).child(state))
        .when(this.agents !== undefined, (el) => el.child(div().text_color(t.dim).child(`${this.agents} agents`)));
    }
    const web = (hash) => (_e, cx) => cx.open_url(`${settings().url}/admin${hash}`);
    const button = (id, label, primary, onClick) => Button.new(id).flex().items_center().h(28).px(12).rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12).child(label).cursor_pointer().on_click(onClick);
    const card = (r) => v_flex().gap(4).p(10).rounded(9).border_1().border_color(t.border).bg(t.surface)
      .child(div().font_semibold().child(r.who.label))
      .children(r.items.map((i) => h_flex().gap(6).child(div().child(i.item)).when(Boolean(i.risk), (el) => el.child(div().text_color(t.blocked).child(`⚠ ${i.risk}`)))))
      .child(h_flex().gap(8).pt(4)
        .child(button(`a-${r.id}`, `Approve ${r.duration}`, true, (_e, cx) => this.act(cx, () => api(`/requests/${r.id}/approve`, { duration: r.duration }))))
        .child(button(`n-${r.id}`, "Deny", false, (_e, cx) => this.act(cx, () => api(`/requests/${r.id}/deny`, {}))))
        .child(button(`w-${r.id}`, "Web", false, web(`#request-${r.id}`))));
    return v_flex().id("inbox").size_full().p(14).gap(8).bg(t.popover).text_color(t.foreground).text_size(12.5).overflow_y_scrollbar()
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(!settings()?.url, (el) => el.child(div().text_color(t.muted).child("Set the speaker URL in the full mod's settings.")))
      .when(Boolean(settings()?.url) && !token, (el) => el.child(h_flex().gap(8).child(div().flex_1().child(Input.new(this.password).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background)))
        .child(button("signin", "Sign in", true, (_e, cx) => this.signIn(cx)))))
      .children(this.pending.map(card))
      .when(Boolean(token) && !n, (el) => el.child(div().text_color(t.dim).child("Nothing waiting")))
      .when(Boolean(settings()?.url), (el) => el.child(div().id("web").pt(6).text_color(t.muted).cursor_pointer().on_click(web("")).child("Open speaker")));
  }
}
