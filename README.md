# 📱 ROZ Monitor — Live Remote Companion & Web Dashboard

A modern, responsive Progressive Web App (PWA) and remote dashboard for **Ragnarok Zero & Renewal**. It pairs securely with the desktop companion ([**ROZ Overlay**](https://github.com/Samuel23/roz_monitor/releases)) to stream live character telemetry, high-DPI radar minimaps, and real-time audio alarms to your mobile phone, tablet, or browser anywhere in the world.

🌐 **Live Web App**: [https://samuel23.github.io/roz_monitor/](https://samuel23.github.io/roz_monitor/)

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
* **🎮 Multi-Client Support**:
  * Seamlessly switch between multiple active game clients with the multi-box fleet bar.

---

## 🔒 Security & Privacy

1. **Passive Telemetry**: The desktop overlay operates strictly outside the game process without reading memory or injecting code.
2. **End-to-End Encryption**: Traffic between the desktop overlay and your browser is encrypted via secure WebSockets using a unique **16-character Room Code** and a **6-digit cryptographic PIN**.
3. **No Packet Leaks**: Raw packets are never transmitted over the internet or saved to disk; only sanitized numeric metrics and entity coordinates are synced.

---

## 🚀 Quick Start & Pairing

1. **Launch Desktop Overlay**:
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

## ⚖️ Legal & Copyright Notice

ROZ Monitor and ROZ Overlay are independent open-source companion tools.  
All character graphics, monster sprites, item icons, map textures, and registered trademarks are the intellectual property of **Gravity Co., Ltd.** & Lee Myoung-Jin.
