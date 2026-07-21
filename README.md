# Jikong BMS Telemetry Monitor Web Application

A premium, fully front-end web application that connects directly to **Jikong (JK) BMS** units from your web browser using either **Web Bluetooth** or **Web Serial (USB UART)**.

## Features

- **Dual-Connection Support:** 
  - **Wireless Bluetooth BLE:** Pair directly with the BMS GATT service (`0xFFE0` / `0xFFE1`).
  - **Wired UART/RS485 Serial:** Read telemetry via any standard USB-to-Serial adapter.
- **Dynamic Cell Voltage Map:** Supports 4S to 32S configurations with auto-detection. Dynamically highlights the highest and lowest cell voltages with custom colored glowing borders, and shows Delta voltage.
- **Protections & Alarms Dashboard:** Highlights active warning flags like Overvoltage, Undervoltage, Overcurrent, Overtemperature, and open wires.
- **Real-Time Telemetry Graph:** Glowing SVG/Canvas chart plotting voltage and current changes in real time.
- **BMS Limit Specs Viewer:** View read-only protection thresholds (OVP, UVP, delta settings) and hardware properties (firmware version, serial number, runtime).
- **Log Terminal:** Displays real-time connection info and raw hex dumps for diagnostics.
- **Demo Mock Mode:** Built-in simulator that generates realistic BMS telemetry so you can explore the UI without physical hardware.

## System Requirements

This application uses advanced HTML5 APIs (`Web Bluetooth` and `Web Serial`) which are supported on:
- Google Chrome (Desktop and Android)
- Microsoft Edge (Desktop)
- Opera (Desktop)

*Note: You may need to enable experimental flags if the browser doesn't prompt for permission:*
- Open Chrome/Edge and go to `chrome://flags/#enable-experimental-web-platform-features`
- Set it to **Enabled** and restart the browser.

---

## Connection Guidelines

### Method 1: Bluetooth BLE (Wireless)
1. Turn on Bluetooth on your computer/phone.
2. Click **Bluetooth BLE** in the connection panel.
3. Select your BMS from the popup list (usually starts with `JK-` or `BMS-`) and click **Pair**.
4. The dashboard will automatically retrieve device specs and start streaming cell details.

### Method 2: USB Serial UART (Wired)
1. Connect your BMS to your computer using a USB-to-TTL or USB-to-RS485 adapter.
2. Click **USB Serial (UART)**.
3. Select the correct COM port from the browser prompt and click **Connect**.
4. The dashboard will poll the BMS every 2 seconds for telemetry frames.

---

## ⚠️ Critical Safety Warning (Serial Wiring)

When connecting to the BMS physically using the 4-pin GPS port:
- **VBAT Danger:** One of the pins on the JST-SH connector carries **full battery pack voltage** (e.g., 24V, 48V, or 58V depending on your battery string!).
- **Damage Risk:** If you wire VBAT to your serial adapter's VCC or RX/TX pins, it will **instantly burn** the serial chip and potentially damage your computer.
- **Safe Wiring:** 
  - Connect ONLY **GND (Ground)**, **RX (BMS TX)**, and **TX (BMS RX)**.
  - Leave the VCC/VBAT pin completely disconnected.

---

## Running Locally

Since this app contains zero backend dependencies, you can open it in two ways:
1. **Directly:** Double-click `index.html` to open it in Chrome/Edge.
2. **Local Dev Server (Recommended for Bluetooth on some platforms):** Run a quick server using python or Node:
   ```bash
   # Python
   python -m http.server 8000
   
   # Node.js
   npx serve .
   ```
   Open `http://localhost:8000` in your web browser.
