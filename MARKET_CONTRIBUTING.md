# 🛒 Contributing to the ROZ Market Price Index

**[ROZ Market](https://samuel23.github.io/roz_market/)** is a community price
index for Ragnarok Zero — what is being vended, where it is standing, what it
costs, and when somebody last actually saw it.

There is no bot and no scraper behind it. Every price on that site is there
because a player walked past the shop with ROZ Overlay running. That is the
whole mechanism, and it is why the index is only ever as good as the number of
people walking markets.

> [!IMPORTANT]
> Contribution is **off by default** and stays off until you tick a box. This
> guide is how to tick it, what happens when you do, and how to untick it.

---

## 📥 Get the overlay

| File | What it is | Size |
|---|---|---|
| **`ROZ_Overlay_v1.8.0.zip`** | Everything, in one download — this is the one you want | ~27 MB |
| `ROZ_Overlay.exe` | The companion on its own, if you already have the data file | ~12 MB |
| `ro_data.bin` | Item / monster / map database and minimap textures | ~15 MB |

👉 **[Download v1.8.0 (latest release)](https://github.com/Samuel23/roz_monitor/releases/latest)**

Unzip both files **into the same folder** and run `ROZ_Overlay.exe`. There is
no installer.

Windows will warn you about an unknown publisher the first time. That is
expected — the reason, and what to check before trusting it, is in the
[main README](README.md#-windows-will-say-unknown-publisher--here-is-why-and-what-to-do).

---

## ✅ Turning contribution ON

1. **Launch `ROZ_Overlay.exe`** and start your game client as normal. Order
   does not matter.
2. Click the **`Setup`** tab, at the right-hand end of the tab strip.
3. Scroll to the checkbox reading
   **"Contribute anonymous market prices to community index"**.
4. **Tick it.**
5. Directly underneath, a status line appears:
   `0 shop(s) seen, 0 observation(s), 0 sent`.

That is the entire setup. **No account, no login, no e-mail, no API key, no
pairing.** The choice is remembered, so you only ever do this once.

If live tracking is not working at all — the whole overlay sitting at zero, not
just the market line — the Setup tab will say so and offer a **Restart as
Administrator** button. Market contribution needs the same connection every
other feature does.

## ❌ Turning contribution OFF

**Untick the same box.** It takes effect immediately:

* Collection stops on the spot.
* Anything queued but not yet uploaded is **thrown away**, not flushed.
* The status line goes back to `off - nothing is being sent.`

You can flip it on and off as often as you like. There is nothing to clean up
and nothing left running.

---

## 📡 What is actually sent

Only what a shop **broadcasts to everyone standing on that map**. If your
character can see it by walking up to the shop, so can the index; if it cannot,
the index never receives it.

| ✅ Sent | ❌ Never sent |
|---|---|
| Shop title (the sign text) | Your character name |
| Shop owner's name (already on the sign) | Your account, login, or e-mail |
| Map name and the shop's x / y | Your position, level, HP, or zeny |
| Items, prices, quantities, refine, cards | Your inventory, cart, or storage |
| Whether it is a selling or buying store | Your chat, whispers, or party |
| A Store Assistant's rental countdown | Anything you type |
| A random 16-character contributor token | Anything identifying you |

The contributor token is generated once, on your PC, purely so the site can
tell "two different people saw this price" apart from "one person saw it
twice". It is not tied to any character or account, and it is not shown
anywhere on the site.

> [!NOTE]
> The capture socket is **receive-only**. Nothing is ever transmitted to the
> game server, and no memory is read or written in the game client. See
> [Zero-Injection Architecture](README.md#-zero-injection-architecture).

---

## 🚶 The four ways you contribute

You do not have to do anything special. **Playing normally in a market town is
already contributing.** But the four sources are worth understanding, because
they are not worth the same amount.

### 1. 🚶 Walking past shops — free, and the backbone

Every vending sign that comes into view is recorded: the shop, its owner, its
exact tile. **No clicking.** Walk the length of a market street and you have
placed every shop on it on the map.

What walking cannot get you is **prices** — a sign advertises a title, not a
cart. Which is why:

### 2. 🖱️ Clicking a shop open — the most valuable single action

Opening a vendor gives the index that shop's **entire stock**, every item and
every price, and it is the only source that does.

This matters more than it sounds. A whole-shop view is the only thing that can
tell the site an item is **gone** — if you saw the whole cart and the Elunium
is not in it, it sold. Every other source can only ever add.

**You do not have to buy anything.** Open the shop, look, close it. That is a
complete contribution.

> 💡 If you are going to do one deliberate thing: walk a market row and click
> open every shop as you pass. Twenty clicks is twenty complete carts.

### 3. 🔍 Vending Search Scroll — priced rows from across the market

Running a search uploads every result row you get back: shop, item, price. It
is genuine price data and it costs you a search you were doing anyway.

Two limits worth knowing:

* Search rows are **partial** — they are the items that matched your query, not
  the shop's cart, so they can never mark anything sold out.
* Search rows carry **no coordinates**. A shop only ever seen in a search shows
  its price but cannot be pinned on the map until somebody walks past it.

### 4. 🌟 Deluxe Vending Search Scroll — a complete cart, from anywhere

The Deluxe scroll's results can be **opened remotely** instead of walked to,
and a remote open sends back the same whole-cart listing that standing in front
of the shop would.

That makes the Deluxe scroll the strongest contribution per click in the game:
each result you open is a **complete shop snapshot**, without crossing the map.
The plain scroll returns coordinates instead, which is useful to you but adds
nothing beyond the search rows you already sent.

---

## 📊 Reading the status line

The line under the checkbox is the whole dashboard:

```
14 shop(s) seen, 63 observation(s), 50 sent
```

* **shop(s) seen** — distinct vendors currently in this session's table.
* **observation(s)** — how many reports were produced. Higher than shops,
  because a shop seen again later is a fresh observation with a fresh timestamp.
* **sent** — how many actually reached the server. It lags the other two by up
  to about five seconds; that is the upload batching, not a fault.

| The line says | What it means |
|---|---|
| `off - nothing is being sent.` | The box is unticked. Nothing is being collected. |
| `N shop(s) seen, ...` in green | Working normally. |
| `... - 3 failed, 0 dropped` in amber | Uploads are being refused or the network is down. It retries by itself; nothing needs doing. |
| `... - 0 failed, 12 dropped` in amber | Observations were produced faster than they could be sent, so the oldest were discarded. Harmless — the newest data is the data kept. |
| `paused: a market packet could not be read.` in red | A packet this build does not understand arrived, usually after a game patch. Collection stopped for the session so it cannot upload bad data. Restart the overlay; if it comes back, please [open an issue](https://github.com/Samuel23/roz_monitor/issues). |

---

## 🛠️ Frequently asked

**Does it slow the game down?**
No. The overlay reads a copy of network traffic your PC has already received.
It is not in the game's path and cannot be — nothing is injected into the
client and nothing is sent to the game server.

**Can anyone tell the prices came from me?**
No. Observations carry a random token, not an identity. Nothing links an upload
to a character or an account, and the token is never displayed on the site.

**Do I need to keep the overlay open?**
Only while you want to contribute. Close it and nothing more is sent; what you
already uploaded stays in the index with the timestamp it was seen at.

**I ticked the box and it still says 0 shops.**
You are probably not on a map with vending shops on it. The counter moves the
moment a shop sign comes into view — stand in a market street and it will start
climbing within seconds. If the rest of the overlay is also empty, live capture
is not running; see the [Administrator](README.md#-administrator) note.

**I am multi-boxing.**
Every client is collected from independently, up to eight at once. Two of your
own characters standing in the same market do not double-count — the site
treats reports from one contributor as one voice, however many clients they
came from.

**Does my contribution show up straight away?**
Near enough. A price only you have ever seen is published and marked as
single-source; a second, independent contributor seeing the same thing is what
promotes it. Give the site a minute and refresh.

---

## 🗺️ Where it ends up

**👉 [samuel23.github.io/roz_market](https://samuel23.github.io/roz_market/)**

Search by item, or open the **Map** tab to see the shops laid out on the market
floor with the time each one was last seen. Every listing carries the moment it
was observed — this is an index of what people saw, not a live feed, and it is
never complete. Read the timestamps and trust them accordingly.

---

## ☕ Support development

ROZ Overlay and ROZ Market are free and stay free. If they have been useful,
the tip jar is at **[ko-fi.com/elijahawesam](https://ko-fi.com/elijahawesam)** —
no obligations in either direction, and no feature depends on it.

---

## ⚖️ Legal & Copyright Notice

ROZ Monitor, ROZ Overlay and ROZ Market are independent open-source companion
tools. All character graphics, monster sprites, item icons, map textures, and
registered trademarks are the intellectual property of **Gravity Co., Ltd.** &
Lee Myoung-Jin.
