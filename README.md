<div align="center">
  <img src="app_logo.png" width="128" height="128" alt="ROZ Monitor Logo" />
  <h1>📱 ROZ Monitor — Live Remote Companion & Web Dashboard</h1>
  <p><b>Real-time mobile telemetry & radar companion for Ragnarok Zero & Renewal</b></p>
  <p>
    <a href="https://samuel23.github.io/roz_monitor/"><img src="https://img.shields.io/badge/Live%20PWA-samuel23.github.io%2Froz__monitor-brightgreen" alt="Live Web App" /></a>
    <a href="https://github.com/Samuel23/roz_monitor/releases"><img src="https://img.shields.io/github/v/release/Samuel23/roz_monitor?color=blue&label=Desktop%20Release" alt="Download" /></a>
    <img src="https://img.shields.io/badge/Platform-iOS%20%7C%20Android%20%7C%20Desktop-purple" alt="Platform" />
  </p>
</div>

---

## 📸 Screenshots & Visual Preview

<div align="center">
  <table>
    <tr>
      <td align="center" width="62%" valign="top">
        <b>Live Web Radar Dashboard</b><br>
        <img src="screenshots/web_monitor_portal.png" width="520" alt="Live Web Radar Dashboard" />
      </td>
      <td align="center" width="38%" valign="top">
        <b>Desktop Overlay Companion</b><br>
        <img src="screenshots/overlay_desktop.png" width="300" alt="Desktop Overlay Companion" />
      </td>
    </tr>
  </table>
</div>

---

## ⚡ Features

* **🗺️ High-DPI Vector Radar**:
  * Renders official map geometry with real-time player position and path trail.
  * Plots nearby monsters with live HP bars and MVP / Boss danger indicators.
  * Displays players, NPCs, and warp portals in real-time.
* **📊 Experience & Combat Telemetry**:
  * Real-time Base & Job EXP/hr rates, % progress bars, and Time-to-Level (ETA).
  * Live combat DPS meter, damage dealt vs. taken, and max hit record.
  * Active buffs ledger with remaining countdown timers.
* **💎 Loot & Container Management**:
  * Session loot drop counters and acquisition rates (items/hr).
  * Category switcher for **Backpack Inventory**, **Merchant Push Cart**, and **Kafra Storage** with instant name filtering.
* **🚨 Mobile Audio Alarms & Haptics**:
  * Distinct sound chimes for Low HP warnings, Level Up fanfares, and incoming whispers.
  * Device vibration and screen wake-lock (prevents phone from sleeping while farming).
* **🔔 Discord & Telegram Push Alerts**:
  * Direct webhook & bot push notifications to your phone for Low HP (<25%), Deaths, Whispers, and Rare Drops. 👉 **[View Setup Guide](DISCORD_TELEGRAM_ALERTS.md)**
* **🎮 Multi-Client Support**:
  * Seamlessly switch between multiple active game clients with the multi-box fleet bar.

---

## 🛡️ Security & Integrity Verification

Official release binary integrity and SHA-256 verification:

| File | Size | SHA-256 Checksum |
|:---|:---|:---|
| **`ROZ_Overlay.exe`** | 13.6 MB | `75ae4cfeaf1d2c84c9bc8e2d3c49d78da5a10fde26a285f285eb61380c2be29e` |
| **`ro_data.bin`** | 15.0 MB | `f21d3fc68f5ee5ae87930e93561e2105e0aca80eaa913b8292b87ced216942d1` |

### 🔒 Zero-Injection Architecture
* ❌ **No DLL Injection**
* ❌ **No Memory Reading / Writing**
* ❌ **No Client File Modification**
* ✅ **100% In-Memory Passive Telemetry**
* 🔐 **End-to-End WebSocket Encryption** via Room Code & PIN

---

## 🚀 Quick Start & Pairing

1. **Launch Desktop Companion**:
   Download and run **`ROZ_Overlay.exe`** on your PC from [GitHub Releases](https://github.com/Samuel23/roz_monitor/releases).
2. **Scan QR Code**:
   Go to the **Setup** tab on the overlay and scan the pairing QR code with your mobile phone camera.
3. **Install as Mobile App (PWA)**:
   In your mobile browser (Safari on iOS or Chrome on Android), tap **Share** / **Options** $\rightarrow$ **"Add to Home Screen"** to install it as a standalone full-screen app.

---

## 💻 Desktop Companion Releases

| Component | Description | Size |
|---|---|---|
| **`ROZ_Overlay.exe`** | Fast native Windows companion launcher (No Wireshark or Npcap required) | ~12 MB |
| **`ro_data.bin`** | Encrypted game schemas, item/mob database, and 400+ minimap PNG textures | ~15 MB |
| **`ROZ_Overlay_vX.X.X.zip`** | Complete release distribution package containing both files | ~27 MB |

👉 **[Download Latest Release](https://github.com/Samuel23/roz_monitor/releases)**

---

## 🛠️ Frequently Asked Questions & Troubleshooting

### 📡 1. Packet Synchronization Lifecycle & Missing Details
> **"Why does my inventory, cart, or character name occasionally show empty after launching the companion?"**

Because ROZ Companion operates **100% passively** without injecting code or reading your game's memory, it captures data that is broadcasted via standard network protocols during normal gameplay:

* **🎒 Backpack Inventory & Equipped Gear**:  
  Transmitted by the server **only once upon entering a world map** after character selection.
* **🛒 Merchant Push Cart**:  
  Transmitted when opening your pushcart in-game (`Alt+W`).
* **🏦 Storage**:  
  Transmitted when opening Storage via NPC.
* **🗺️ Character Name, Map, and Area Entities**:  
  Broadcasted whenever you enter a new map, change zones, or use a **Fly Wing / Teleport** (even within the same map).

> [!TIP]
> **Recommended Best Practice for a 100% Full Sync:**  
> If you start `ROZ_Overlay.exe` while already standing in the game world, simply press `Esc` $\rightarrow$ **Character Select** and re-enter your character. This prompts the server to re-broadcast your full inventory, equipment options, and character profile.

---

### 💾 2. Local Storage & Data Privacy Transparency
> **"Where is my data saved, and what exactly is being recorded?"**

All companion telemetry is saved strictly on your local PC in your user profile:
```
%LOCALAPPDATA%\ROZOverlay\
```

#### What files are stored locally?
* `state.json`: Window coordinates, UI tab selection, sound volume, and character profile preferences.
* `status.json` / `inventory.json` / `chat.json`: Temporary local telemetry snapshots used to power the desktop overlay and web dashboard.
* `history/YYYY-MM-DD/<Character>/summary.json`: Daily farming summaries for reviewing personal EXP/hr rates, total zeny earnings, and monster drops.

#### Sample of recorded data (`history/.../summary.json`):
```json
{
  "date": "2026-08-25",
  "character": "Solaris",
  "job": "Knight",
  "base_exp_gained": 145200,
  "job_exp_gained": 98400,
  "zeny_net": 125000,
  "kills_total": 86,
  "kills_breakdown": {
    "Mandragora": 48,
    "Poring": 38
  },
  "loot": {
    "Stem": 48,
    "Jellopy": 38
  }
}
```

> [!NOTE]
> **No Sensitive Data Stored:** Passwords, account credentials, master logins, and private authentication tokens are never parsed or written to disk.

---

### 🔐 3. Privacy & Account Credentials Guarantee
> **"How can I be 100% sure my login details, passwords, or PIN codes are never captured?"**

* **Architecture Guarantee**: The companion tool completely ignores login and character authentication authentication servers. It passively listens only to active in-game world events once you are playing inside the game.
* **Zero-Risk Verification Method**: If you want absolute peace of mind, **launch `ROZ_Overlay.exe` only AFTER you have already logged in and entered the game world.**
* **Local In-Memory Privacy**: All calculations (EXP/h, loot counts, radar tracking) are computed entirely in volatile RAM on your local PC. Nothing is ever transmitted to external servers.

---

### 👥 4. Multi-Client / Multi-Boxing Focus
> **"I am playing on multiple accounts. How do I switch which character the overlay is tracking?"**

* **Instant Switching**: Look at the fleet selector bar at the top of the overlay window or mobile web portal. Click any character name to immediately switch live telemetry, inventory, and stats to that client window.

---

### 📡 5. Telemetry Status Shows "Searching / Connecting"
> **"The overlay is open, but telemetry events are not incrementing."**

* **Quick Fix**: Walk a few steps in-game or cast any skill. The capture engine passively detects the active socket as soon as the game client exchanges traffic with the server.

---

### 📱 6. Mobile Web Portal Pairing
> **"How do I connect my mobile phone or tablet to the live monitor?"**

* **1-Scan Pairing**: Open the **Setup** tab on your desktop overlay and scan the pairing QR code with your phone's camera.
* **Manual Room Code & PIN**: Alternatively, open [https://samuel23.github.io/roz_monitor/](https://samuel23.github.io/roz_monitor/) on any device, enter the **Room Code** and **4-digit PIN** displayed on your desktop Setup tab, and tap **Connect**.
* **Reconnecting**: If you close your browser or change tabs, simply re-enter your Room Code and PIN to immediately resume your live session.

---

## ⚖️ Legal & Copyright Notice

ROZ Monitor and ROZ Overlay are independent open-source companion tools.  
All character graphics, monster sprites, item icons, map textures, and registered trademarks are the intellectual property of **Gravity Co., Ltd.** & Lee Myoung-Jin.
