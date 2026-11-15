// Speaker's new cards in Herdr: polls speaker's ntfy topic, posts one toast per card, and opens the card in the
// browser from the toast or this bar. Settings: config.json beside this file (copy config.example.json).
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, nextCommand, notify, theme } from "herdr";
import * as fs from "fs/promises";

export default class SpeakerCards extends View {
  init(_props, cx) {
    this.latest = undefined; // the newest card: { title, url }
    this.since = Math.floor(Date.now() / 1000); // cards from before Herdr started were already announced
    cx.spawn(async (cx) => {
      try {
        this.config = JSON.parse(await fs.readFile(`${appHome()}/mods/speaker/config.json`, "utf8"));
      } catch (error) {
        this.error = `speaker: no config.json (${error.message}); copy config.example.json`;
        return cx.notify();
      }
      this.poll(cx);
      cx.timer.every(15_000, (cx) => this.poll(cx));
    });
    cx.spawn(async (cx) => {
      for (;;) if ((await nextCommand()) === "open") this.open(cx);
    });
  }

  open(cx) {
    if (this.latest) cx.open_url(this.latest.url);
  }

  poll(cx) {
    cx.spawn(async (cx) => {
      const { url, topic, token } = this.config;
      const response = await fetch(`${url.replace(/\/$/, "")}/${topic}/json?poll=1&since=${this.since}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }).catch((error) => ({ ok: false, status: error.message }));
      this.error = response.ok ? undefined : `speaker: ntfy answered ${response.status}`;
      for (const line of response.ok ? (await response.text()).split("\n").filter(Boolean) : []) {
        const message = JSON.parse(line);
        if (message.event !== "message") continue;
        this.since = message.id;
        this.latest = { title: message.title, url: message.click };
        notify({ title: message.title, body: message.message, level: "warning", action: { name: "speaker.open" } });
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return h_flex().id("speaker").size_full().px(14).gap(8).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(this.error ? t.blocked : t.muted)
      .child(div().child(this.error ?? (this.latest ? `speaker · ${this.latest.title}` : "speaker · no new cards")))
      .when(Boolean(this.latest && !this.error), (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_event, cx) => this.open(cx)));
  }
}
