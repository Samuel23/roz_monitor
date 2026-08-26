# 🔔 Discord & Telegram Push Alerts Setup Guide

ROZ Companion features a built-in background push notification engine (`ro_alerts.py`) that sends instant mobile push notifications to your phone via **Discord Webhooks** or **Telegram Bots** when critical in-game events occur.

---

## ⚡ What Events Trigger Alerts?

| Alert Type | Icon | Trigger Condition | Notification Details |
| :--- | :---: | :--- | :--- |
| **Player Death** | 💀 | HP reaches 0 | Character name, map location, and time of defeat |
| **Critical Low HP** | 🚨 | HP drops below 25% | Live HP/SP levels and danger warning |
| **Private Whisper** | ✉️ | Incoming whisper message | Sender name and preview of the whisper message |
| **Level Up** | 🌟 | Base Lv or Job Lv increases | New level reached and time elapsed |
| **Rare Item Drop** | 💎 | Monster Card or rare gear drops | Item name and map location |
| **Disconnect / AFK** | 🔌 | Game connection lost | Inactivity / network disconnection alert |

---

## 🎮 How to Open the Alerts Configuration

1. Launch **`ROZ_Overlay.exe`**.
2. In the top-left menu, click **`overlay ▾`** (or go to the **Setup** tab) $\rightarrow$ **`Discord & Telegram Alerts`**.
3. Configure either **Discord**, **Telegram**, or both!

---

## 🟣 1. Discord Webhook Setup (Recommended — 1 Minute Setup)

Discord webhooks send rich embedded notification cards to any text channel on your private Discord server.

### Step 1: Create a Webhook on Discord
1. Open your Discord server on desktop or mobile.
2. Choose a text channel (e.g., `#farming-alerts` or a private channel).
3. Click the **Channel Settings (⚙️ Gear Icon)** $\rightarrow$ **Integrations** $\rightarrow$ **Webhooks**.
4. Click **New Webhook**, name it (e.g., `ROZ Companion`), and click **Copy Webhook URL**.

### Step 2: Paste in ROZ Overlay
1. In the ROZ Overlay Alerts dialog, paste the copied URL into **Discord Webhook URL**:
   ```
   https://discord.com/api/webhooks/1234567890/abc-XYZ...
   ```
   *(Note: The URL above is an illustrative placeholder sample. Always generate and use your own private webhook URL from Discord).*
2. Click **`Send Test Alert`**.
3. Check your Discord channel — you will instantly receive a test alert.
4. Click **`Save & Close`**.

---

## 🔵 2. Telegram Bot API Setup (Direct Push to Phone)

Telegram bots allow ROZ Companion to send direct private messages directly to your personal Telegram account.

### Step 1: Create Your Personal Bot via BotFather
1. Open the Telegram app and search for `@BotFather`.
2. Start the chat and send the command:
   ```
   /newbot
   ```
3. Follow the prompts to give your bot a name and username (e.g., `MyROZAlertBot`).
4. `@BotFather` will reply with your **HTTP API Bot Token**:
   ```
   7123456789:AAFlkjw9823lkjsdf-8923jksdf
   ```
   *(Note: The token above is an illustrative placeholder sample. Always generate and use your own private bot token from @BotFather).*
5. Click the link to your new bot and click **Start** (so the bot has permission to message you).

### Step 2: Find Your Telegram Chat ID
1. In Telegram, search for `@userinfobot` or `@GetMyIdBot`.
2. Start the chat — it will instantly reply with your numeric **Id** (e.g., `123456789` - *sample placeholder ID*).

### Step 3: Paste into ROZ Overlay
1. In the ROZ Overlay Alerts dialog:
   * Paste your private token into **Telegram Bot Token**.
   * Paste your personal numeric ID into **Telegram Chat ID**.
2. Click **`Send Test Alert`**.
3. You will receive an instant push alert on your Telegram app.
4. Click **`Save & Close`**.

---

## ⚙️ Advanced Settings & Customization

* **🎴 Monster Cards & Costumes**: All monster cards (Item Type 6) and costumes (Item Type 8) automatically trigger rich golden/purple embed alerts.
* **⚔️ Equipment Random Options**: Weapons and armors only alert when dropping with **2 or more random option bonuses** (configurable via *Min Random Options*).
* **📋 Custom Rare Item Watchlist**: Customize the list of item IDs in the Alerts dialog (e.g. `603, 604, 607, 608, 616, 617, 644, 674, 12020, 7049`). Any item matching your watchlist triggers an instant alert!
* **🚨 Low HP Threshold**: Customize the warning trigger percentage (default is `< 25%`).
* **🛡️ Debounce & Spam Protection**: Warnings are automatically debounced to prevent notification spamming while recovering.
* **👥 Multi-Client Routing**: Alerts automatically report the character name and zone map that triggered the event.
