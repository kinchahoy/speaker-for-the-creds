// Speaker's approvals in Herdr. A bottom bar ("speaker · 2 waiting") polls speaker's owner API, posts a toast per new
// request, and opens the inbox (this mod again, as a dialog with props { inbox: true }): approve as asked, deny, revoke,
// or open the card in the browser. The owner password is typed once per Herdr start; the token stays in this module's
// memory, never on disk. Settings: config.json beside this file ({ "url": "<speaker>" }, see config.example.json).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, closeOverlay, nextCommand, notify, openOverlay, props, theme } from "herdr";
import * as fs from "fs/promises";

let base; // speaker's URL, from config.json
let token; // the owner API bearer token; gone when Herdr quits or speaker answers 401

async function api(path, body) {
  base ??= JSON.parse(await fs.readFile(`${appHome()}/mods/speaker/config.json`, "utf8")).url.replace(/\/$/, "");
  const response = await fetch(`${base}/admin/api${path}`, {
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
const openInbox = () => openOverlay({ mod: "speaker", kind: "dialog", width: 520, height: 0.8, props: { inbox: true } });
const ago = (ms) => `${Math.max(1, Math.round((Date.now() - ms) / 60_000))}m ago`;
const left = (iso) => (iso ? `${Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000))}m left` : "until revoked");

export default class Speaker extends View {
  init(_props, cx) {
    this.inbox = Boolean(props()?.inbox);
    this.pending = [];
    this.grants = [];
    this.chosen = {}; // request id -> duration
    this.seen = new Set();
    if (this.inbox) {
      this.password = InputState.new({ placeholder: "Owner password" });
      this.password.set_masked(true);
      this.password.on("submit", (_e, cx) => this.act(cx, async () => {
        token = (await api("/signin", { password: this.password.value() })).token;
        this.password.set_value("");
      }));
      this.password.focus();
    } else cx.spawn(async (cx) => { for (;;) if ((await nextCommand()) === "open") openInbox(); });
    this.refresh(cx);
    cx.timer.every(10_000, (cx) => this.refresh(cx));
  }

  // Runs an action, then shows the inbox as speaker now has it (or the error).
  act(cx, action) {
    cx.spawn(async (cx) => {
      try {
        await action();
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

  refresh(cx) {
    if (token || this.inbox) this.act(cx, async () => {});
  }

  render() {
    const t = theme();
    if (!this.inbox)
      return h_flex().id("speaker").size_full().px(14).items_center().bg(t.chrome).border_t(1).border_color(t.border)
        .text_size(11.8).text_color(this.error ? t.blocked : this.pending.length ? t.foreground : t.muted)
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => openInbox())
        .child(`speaker · ${this.error ?? (!token ? "sign in" : this.pending.length ? `${this.pending.length} waiting` : "nothing waiting")}`);
    const button = (id, label, primary, onClick) => h_flex().id(id).h(28).px(12).items_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    const browser = (anchor) => (_e, cx) => cx.open_url(`${base}/admin${anchor}`);
    const heading = (text) => div().pt(10).text_size(11.5).text_color(t.dim).child(text);
    const card = (r) => v_flex().gap(6).p(12).rounded(9).border_1().border_color(t.border).bg(t.surface)
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
    return v_flex().id("inbox").size_full().p(16).gap(8).bg(t.popover).text_color(t.foreground).text_size(12.5).overflow_y_scrollbar()
      .child(h_flex().justify_between().items_center().child(div().text_size(15).font_semibold().child("Speaker"))
        .child(button("close", "Close", false, () => closeOverlay(props().overlay))))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(!token, (el) => el.child(heading("Sign in to see and decide requests"))
        .child(Input.new(this.password).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background)))
      .when(Boolean(token), (el) => el
        .child(heading(this.pending.length ? `${this.pending.length} waiting` : "Nothing waiting"))
        .children(this.pending.map(card))
        .child(heading("Active"))
        .children(this.grants.map((g) => h_flex().gap(8).items_center()
          .child(div().flex_1().truncate().child(`${g.who.label} · ${g.item}`)).child(div().text_color(t.dim).child(left(g.expiresAt)))
          .child(button(`r-${g.id}`, "Revoke", false, (_e, cx) => this.act(cx, () => api(`/grants/${g.id}/revoke`, {}))))))
        .when(!this.grants.length, (el) => el.child(div().text_color(t.dim).child("No live grants")))
        .child(h_flex().pt(8).child(button("admin", "Open in browser", false, browser("")))));
  }
}
