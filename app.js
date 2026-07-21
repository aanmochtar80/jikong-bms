/**
 * Jikong BMS Reader Logic
 * Supports Web Bluetooth (BLE fixed-offset) and Web Serial (UART TLV)
 */

// Global State
const state = {
  connected: false,
  connectionType: null, // 'ble' or 'serial'
  device: null, // BluetoothDevice or SerialPort
  bleWriteChar: null, // For sending commands
  bleNotifyChars: [], // For receiving telemetry notifications
  blePollInterval: null, // Periodic polling timer
  serialReader: null,
  serialWriter: null,
  serialPollInterval: null,
  
  // BMS Data
  bmsData: {
    cell_info: {
      voltages: [],
      average_cell_voltage: 0,
      delta_cell_voltage: 0,
      max_voltage_cell: 0,
      min_voltage_cell: 0,
      resistances: [],
      total_voltage: 0,
      current: 0,
      power: 0,
      temperature_sensor_1: 0,
      temperature_sensor_2: 0,
      temperature_mos: 0,
      temperature_box: 0,
      battery_soc: 0,
      cycle_count: 0,
      cycle_capacity: 0,
      cell_count: 0,
    },
    settings: {
      charging_switch_enabled: false,
      discharging_switch_enabled: false,
      balancing_switch_enabled: false,
      cell_voltage_overvoltage_protection: 0,
      cell_voltage_undervoltage_protection: 0,
      total_voltage_overvoltage_protection: 0,
      total_voltage_undervoltage_protection: 0,
      charging_overcurrent_protection: 0,
      discharging_overcurrent_protection: 0,
      balancing_start_voltage: 0,
      balancing_delta_voltage: 0,
      full_charge_capacity: 0,
      actual_battery_capacity: 0,
      battery_type: 'Unknown',
    },
    device_info: {
      hw_rev: 'N/A',
      sw_rev: 'N/A',
      serial_number: 'N/A',
      vendor_id: 'N/A',
      production: 'N/A',
      uptime: 0,
    },
    alarms: {
      resistance_too_high: false,
      mosfet_overtemp: false,
      cell_count_wrong: false,
      charge_overvoltage: false,
      charge_overcurrent: false,
      charge_undertemp: false,
      cell_undervoltage: false,
      discharge_overcurrent: false,
      discharge_overtemp: false,
      bitmask: 0
    }
  },

  // Chart Data History
  history: {
    voltage: [],
    current: [],
    timestamps: [],
    maxPoints: 60
  }
};

// BLE UUID Constants
const BLE_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const BLE_CHAR_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';
const BLE_MODEL_NBR_UUID = '00002a24-0000-1000-8000-00805f9b34fb';

// Raw stream buffers
let bleBuffer = new Uint8Array(0);
let serialBuffer = new Uint8Array(0);

// Initialize Chart canvas
let canvas, ctx;

function initBmsApp() {
  // Setup Chart canvas
  canvas = document.getElementById('telemetryChart');
  if (canvas) {
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }
  
  // Setup Button Listeners
  document.getElementById('btnConnectBle').addEventListener('click', connectBle);
  document.getElementById('btnConnectSerial').addEventListener('click', connectSerial);
  document.getElementById('btnDisconnect').addEventListener('click', disconnect);

  log('System initialized. Ready to connect.', 'info');
  updateUI();
  drawChart();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBmsApp);
} else {
  initBmsApp();
}

function resizeCanvas() {
  if (canvas) {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight || 200;
    drawChart();
  }
}

// Log utility
function log(message, type = 'info') {
  const consoleEl = document.getElementById('consoleTerminal');
  if (!consoleEl) return;

  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  
  const timestamp = new Date().toLocaleTimeString();
  line.textContent = `[${timestamp}] ${message}`;
  
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// Connection State UI updater
function updateUI() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const btnBle = document.getElementById('btnConnectBle');
  const btnSerial = document.getElementById('btnConnectSerial');
  const btnDisconnect = document.getElementById('btnDisconnect');

  // Connection Indicator
  dot.className = 'status-dot';
  if (state.connected) {
    dot.classList.add('connected');
    text.textContent = `CONNECTED (${state.connectionType.toUpperCase()})`;
    btnBle.disabled = true;
    btnSerial.disabled = true;
    btnDisconnect.disabled = false;
  } else if (dot.classList.contains('connecting')) {
    text.textContent = 'CONNECTING...';
    btnBle.disabled = true;
    btnSerial.disabled = true;
    btnDisconnect.disabled = false;
  } else {
    dot.classList.add('disconnected');
    text.textContent = 'DISCONNECTED';
    btnBle.disabled = false;
    btnSerial.disabled = false;
    btnDisconnect.disabled = true;
  }

  // Set values in document
  const d = state.bmsData.cell_info;
  const s = state.bmsData.settings;
  const dev = state.bmsData.device_info;

  // Header quick values
  document.getElementById('valSoC').textContent = d.battery_soc || 0;
  document.getElementById('valSoCProgress').style.strokeDashoffset = 314 - (314 * (d.battery_soc || 0) / 100);
  
  document.getElementById('valVoltage').textContent = (d.total_voltage || 0).toFixed(2);
  document.getElementById('valCurrent').textContent = (d.current || 0).toFixed(2);
  
  const power = d.total_voltage * d.current;
  d.power = power;
  document.getElementById('valPower').textContent = (power || 0).toFixed(1);
  
  document.getElementById('valCycles').textContent = d.cycle_count || 0;
  
  document.getElementById('valCapacityRemain').textContent = (d.capacity_remain || 0).toFixed(1);
  document.getElementById('valCapacityNominal').textContent = (s.full_charge_capacity || 0).toFixed(1);

  // Switches
  updateSwitch('switchCharge', s.charging_switch_enabled);
  updateSwitch('switchDischarge', s.discharging_switch_enabled);
  updateSwitch('switchBalance', s.balancing_switch_enabled);

  // Temperatures
  document.getElementById('valTempMos').textContent = (d.temperature_mos || 0).toFixed(1);
  document.getElementById('valTemp1').textContent = (d.temperature_sensor_1 || 0).toFixed(1);
  document.getElementById('valTemp2').textContent = (d.temperature_sensor_2 || 0).toFixed(1);

  // Cell summary
  document.getElementById('valAverageCell').textContent = (d.average_cell_voltage || 0).toFixed(3);
  document.getElementById('valDeltaCell').textContent = (d.delta_cell_voltage || 0).toFixed(3);
  document.getElementById('valMaxCellNum').textContent = d.max_voltage_cell ? `#${d.max_voltage_cell}` : '-';
  document.getElementById('valMaxCellVolts').textContent = d.max_voltage_cell ? d.voltages[d.max_voltage_cell - 1]?.toFixed(3) : '0.000';
  document.getElementById('valMinCellNum').textContent = d.min_voltage_cell ? `#${d.min_voltage_cell}` : '-';
  document.getElementById('valMinCellVolts').textContent = d.min_voltage_cell ? d.voltages[d.min_voltage_cell - 1]?.toFixed(3) : '0.000';

  // Render Cell Cards
  renderCellCards();

  // Alarms
  updateAlarmIndicators();

  // Settings Panel
  document.getElementById('setOVP').textContent = (s.cell_voltage_overvoltage_protection || 0).toFixed(3);
  document.getElementById('setUVP').textContent = (s.cell_voltage_undervoltage_protection || 0).toFixed(3);
  document.getElementById('setTotalOVP').textContent = (s.total_voltage_overvoltage_protection || 0).toFixed(2);
  document.getElementById('setTotalUVP').textContent = (s.total_voltage_undervoltage_protection || 0).toFixed(2);
  document.getElementById('setChargeOCP').textContent = (s.charging_overcurrent_protection || 0).toFixed(1);
  document.getElementById('setDischargeOCP').textContent = (s.discharging_overcurrent_protection || 0).toFixed(1);
  document.getElementById('setBalStart').textContent = (s.balancing_start_voltage || 0).toFixed(3);
  document.getElementById('setBalDelta').textContent = (s.balancing_delta_voltage || 0).toFixed(3);
  document.getElementById('setCapNom').textContent = (s.full_charge_capacity || 0).toFixed(1);
  document.getElementById('setCapAct').textContent = (s.actual_battery_capacity || 0).toFixed(1);
  document.getElementById('setBatType').textContent = s.battery_type || 'Unknown';

  // Device Info
  document.getElementById('infoHw').textContent = dev.hw_rev || 'N/A';
  document.getElementById('infoSw').textContent = dev.sw_rev || 'N/A';
  document.getElementById('infoSerial').textContent = dev.serial_number || 'N/A';
  document.getElementById('infoVendor').textContent = dev.vendor_id || 'N/A';
  document.getElementById('infoProduction').textContent = dev.production || 'N/A';
  
  const uptimeHours = (dev.uptime || 0) / 60;
  document.getElementById('infoUptime').textContent = uptimeHours > 24 
    ? `${(uptimeHours / 24).toFixed(1)} Days` 
    : `${uptimeHours.toFixed(1)} Hours`;
}

function updateSwitch(id, isActive) {
  const card = document.getElementById(id);
  const pill = card.querySelector('.switch-status-pill');
  if (isActive) {
    card.classList.add('active');
    pill.textContent = 'ON';
  } else {
    card.classList.remove('active');
    pill.textContent = 'OFF';
  }
}

function renderCellCards() {
  const container = document.getElementById('cellsContainer');
  if (!container) return;

  const d = state.bmsData.cell_info;
  const count = d.cell_count || d.voltages.length || 0;

  if (count === 0) {
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 2rem;">No cells detected. Connect to BMS or enable Demo Mock Mode.</div>`;
    return;
  }

  let html = '';
  for (let i = 0; i < count; i++) {
    const v = d.voltages[i] || 0;
    const r = (d.resistances && d.resistances[i]) ? (d.resistances[i] * 1000).toFixed(1) : '-';
    
    let extraClass = '';
    let badgeText = '';
    if (i + 1 === d.max_voltage_cell) {
      extraClass = 'high-voltage';
      badgeText = '<span>HIGH</span>';
    } else if (i + 1 === d.min_voltage_cell) {
      extraClass = 'low-voltage';
      badgeText = '<span>LOW</span>';
    }

    html += `
      <div class="cell-card ${extraClass}">
        <div class="cell-number-badge">
          <span>Cell #${i + 1}</span>
          ${badgeText}
        </div>
        <div class="cell-volts">${v.toFixed(3)}<span style="font-size: 0.75rem; font-weight: 500; margin-left: 0.15rem; color: var(--text-secondary);">V</span></div>
        <div class="cell-res">Res: ${r} mΩ</div>
      </div>
    `;
  }
  container.innerHTML = html;
}

function updateAlarmIndicators() {
  const alarms = state.bmsData.alarms;
  const banner = document.getElementById('alarmSummaryBanner');

  const alarmKeys = [
    { key: 'resistance_too_high', id: 'alarmWire' },
    { key: 'mosfet_overtemp', id: 'alarmMos' },
    { key: 'cell_count_wrong', id: 'alarmCellCount' },
    { key: 'charge_overvoltage', id: 'alarmOvp' },
    { key: 'charge_overcurrent', id: 'alarmCoc' },
    { key: 'charge_undertemp', id: 'alarmCut' },
    { key: 'cell_undervoltage', id: 'alarmUvp' },
    { key: 'discharge_overcurrent', id: 'alarmDoc' },
    { key: 'discharge_overtemp', id: 'alarmDot' }
  ];

  let activeCount = 0;
  alarmKeys.forEach(alarm => {
    const el = document.getElementById(alarm.id);
    if (el) {
      if (alarms[alarm.key]) {
        el.classList.add('active');
        activeCount++;
      } else {
        el.classList.remove('active');
      }
    }
  });

  if (activeCount > 0) {
    banner.className = 'alarm-summary-banner danger';
    banner.textContent = `⚠️ ATTENTION: ${activeCount} active protection alarms detected! Check system settings.`;
  } else if (state.connected) {
    banner.className = 'alarm-summary-banner ok';
    banner.textContent = `✓ SYSTEM OK: All cell levels and protections normal.`;
  } else {
    banner.style.display = 'none';
  }
}

// ----------------------------------------------------
// WEB BLUETOOTH API
// ----------------------------------------------------
async function connectBle() {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot connecting';
  log('Requesting Bluetooth device...', 'info');

  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [BLE_SERVICE_UUID] },
        { services: ['ffe0'] }
      ]
    });

    log(`Device selected: ${device.name || device.id}. Connecting to GATT Server...`, 'info');
    state.device = device;
    device.addEventListener('gattserverdisconnected', onBleDisconnected);

    const server = await device.gatt.connect();
    log('GATT Connected. Discovering Primary Service...', 'info');

    let service;
    try {
      service = await server.getPrimaryService(BLE_SERVICE_UUID);
    } catch (e) {
      log('128-bit service UUID not found, trying 16-bit short UUID...', 'warning');
      try {
        service = await server.getPrimaryService('ffe0');
      } catch (e2) {
        log('16-bit service UUID not found, retrieving all services...', 'warning');
        const services = await server.getPrimaryServices();
        log(`Discovered ${services.length} services:`, 'info');
        for (const s of services) {
          log(`- Service: ${s.uuid}`, 'info');
          if (s.uuid.includes('ffe0') || s.uuid.includes('FFE0')) {
            service = s;
            break;
          }
        }
        if (!service) throw new Error('Jikong BLE Service (ffe0) not found on this device.');
      }
    }
    log('Service retrieved. Discovering Characteristics...', 'info');

    let characteristics;
    try {
      characteristics = await service.getCharacteristics();
    } catch (e) {
      log('Failed to get all characteristics via list, searching BLE_CHAR_UUID directly...', 'warning');
      const char = await service.getCharacteristic(BLE_CHAR_UUID);
      characteristics = [char];
    }

    let writeChar = null;
    const notifyChars = [];

    for (const char of characteristics) {
      const props = [];
      if (char.properties.write) props.push('write');
      if (char.properties.writeWithoutResponse) props.push('writeWithoutResponse');
      if (char.properties.notify) props.push('notify');
      if (char.properties.indicate) props.push('indicate');
      log(`Characteristic: ${char.uuid} (Props: ${props.join(', ')})`, 'info');

      const uuid = char.uuid.toLowerCase();
      // FFE1 is the correct write channel for Jikong BMS commands
      if (uuid.includes('ffe1')) {
        if (char.properties.write || char.properties.writeWithoutResponse) {
          writeChar = char;
        }
      }
      // Collect notify channels
      if (char.properties.notify || char.properties.indicate || uuid.includes('ffe1') || uuid.includes('ffe2') || uuid.includes('ffe3')) {
        notifyChars.push(char);
      }
    }

    if (!writeChar) {
      log('FFE1 write channel not found in list, trying fallback...', 'warning');
      for (const char of characteristics) {
        if (char.properties.write || char.properties.writeWithoutResponse) {
          writeChar = char;
          break;
        }
      }
    }

    if (!writeChar) {
      throw new Error('No writable BLE characteristic found.');
    }

    state.bleWriteChar = writeChar;
    state.bleNotifyChars = notifyChars;

    log(`Subscribing to notifications on ${notifyChars.length} characteristics...`, 'info');
    for (const char of notifyChars) {
      try {
        // Register listener BEFORE starting notifications (Standard Web Bluetooth rule)
        char.addEventListener('characteristicvaluechanged', handleBleNotification);
        await char.startNotifications();
        log(`Subscribed to notifications on: ${char.uuid.slice(-4).toUpperCase()}`, 'success');
      } catch (err) {
        log(`Failed to subscribe to ${char.uuid.slice(-4).toUpperCase()}: ${err.message}`, 'warning');
      }
    }
    
    state.connected = true;
    state.connectionType = 'ble';
    log('BLE Connection established! Polling with Legacy AA55 protocol...', 'success');

    // Only use Legacy AA55 protocol (confirmed working for JK_BD4A24S4P)
    let pollStep = 0;
    state.blePollInterval = setInterval(async () => {
      if (!state.connected || !state.bleWriteChar) {
        clearInterval(state.blePollInterval);
        state.blePollInterval = null;
        return;
      }

      // Alternate between Device Info (0x97) and Cell Info (0x96)
      const cmd = (pollStep % 2 === 0) ? 0x97 : 0x96;
      const frame = buildLegacyReadCommand(cmd);

      // Write command to FFE1
      const char = state.bleWriteChar;
      try {
        if (char.properties.writeWithoutResponse) {
          await withTimeout(char.writeValueWithoutResponse(frame), 300);
        } else {
          await withTimeout(char.writeValueWithResponse(frame), 300);
        }
      } catch (err) {
        log(`TX Error: ${err.message}`, 'error');
      }

      // Single readValue() kick after 300ms to prime the notification pipeline
      await new Promise(r => setTimeout(r, 300));
      for (const nc of state.bleNotifyChars) {
        try {
          const val = await withTimeout(nc.readValue(), 200);
          if (val && val.byteLength > 0) {
            const data = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
            const newBuf = new Uint8Array(bleBuffer.length + data.length);
            newBuf.set(bleBuffer, 0);
            newBuf.set(data, bleBuffer.length);
            bleBuffer = newBuf;
            processBuffer();
          }
        } catch (e) {
          // readValue not supported or timed out
        }
      }

      pollStep++;
    }, 2000);

    updateUI();
  } catch (error) {
    log(`Bluetooth Connection Failed: ${error.message}`, 'error');
    dot.className = 'status-dot';
    updateUI();
  }
}

async function requestBleFrame(commandByte) {
  if (!state.bleWriteChar) return;
  
  const frame = new Uint8Array(20);
  frame[0] = 0xAA;
  frame[1] = 0x55;
  frame[2] = 0x90;
  frame[3] = 0xEB;
  frame[4] = commandByte;
  frame[5] = 0x00; // length
  // 6 to 18 remain 0x00
  
  // Calculate CRC (sum of bytes 0 to 18)
  let sum = 0;
  for (let i = 0; i < 19; i++) {
    sum += frame[i];
  }
  frame[19] = sum & 0xFF;

  try {
    log(`Sending 0x${commandByte.toString(16).toUpperCase()}...`, 'info');
    await state.bleWriteChar.writeValueWithoutResponse(frame);
    log(`Command 0x${commandByte.toString(16).toUpperCase()} sent.`, 'success');
  } catch (err) {
    log(`Failed to write command 0x${commandByte.toString(16).toUpperCase()}: ${err.message}`, 'error');
  }
}

function handleBleNotification(event) {
  try {
    const value = new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength);
    
    // Log incoming bytes for real-time debugging
    const hex = Array.from(value).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    log(`RX-notify (${value.length}B): ${hex.slice(0, 40)}${hex.length > 40 ? '...' : ''}`, 'success');

    // Append new data to the buffer
    const newBuf = new Uint8Array(bleBuffer.length + value.length);
    newBuf.set(bleBuffer, 0);
    newBuf.set(value, bleBuffer.length);
    bleBuffer = newBuf;

    processBuffer();
  } catch (err) {
    log(`Notification handler error: ${err.message}`, 'error');
  }
}

function processBuffer() {
  while (bleBuffer.length >= 4) {
    let headerIndex = -1;
    let isLegacy = false;

    // Search for frame header 0x4E57 (Modern) or 0x55AAEB90 (Legacy)
    for (let i = 0; i < bleBuffer.length - 1; i++) {
      if (bleBuffer[i] === 0x4E && bleBuffer[i + 1] === 0x57) {
        headerIndex = i;
        isLegacy = false;
        break;
      }
      if (i < bleBuffer.length - 3 && 
          bleBuffer[i] === 0x55 && bleBuffer[i + 1] === 0xAA && 
          bleBuffer[i + 2] === 0xEB && bleBuffer[i + 3] === 0x90) {
        headerIndex = i;
        isLegacy = true;
        break;
      }
    }

    if (headerIndex === -1) {
      // Keep last 3 bytes to avoid losing partial headers
      if (bleBuffer.length > 3) {
        bleBuffer = bleBuffer.slice(bleBuffer.length - 3);
      }
      return;
    }

    // Discard preceding garbage
    if (headerIndex > 0) {
      bleBuffer = bleBuffer.slice(headerIndex);
    }

    if (isLegacy) {
      if (bleBuffer.length < 300) return; // Wait for full 300-byte legacy frame
      const frame = bleBuffer.slice(0, 300);
      bleBuffer = bleBuffer.slice(300);

      // Verify CRC (sum8)
      let sum = 0;
      for (let i = 0; i < 299; i++) {
        sum += frame[i];
      }
      if ((sum & 0xFF) === frame[299]) {
        log('Legacy frame received and CRC passed!', 'success');
        decodeBleFrame(frame);
      } else {
        log('Legacy BLE Checksum failed', 'warning');
      }
    } else {
      if (bleBuffer.length < 4) return;
      const frameLen = (bleBuffer[2] << 8) | bleBuffer[3];
      const totalFrameSize = frameLen + 2; // NW header is 2 bytes, total frame is frameLen + 2
      
      if (bleBuffer.length < totalFrameSize) return; // Wait for full modern frame
      const frame = bleBuffer.slice(0, totalFrameSize);
      bleBuffer = bleBuffer.slice(totalFrameSize);

      // Verify Checksum (4-byte sum at the end)
      const last = totalFrameSize - 1;
      const receivedChecksum = (frame[last-3] << 24) | (frame[last-2] << 16) | (frame[last-1] << 8) | frame[last];
      let calculatedSum = 0;
      for (let i = 0; i < totalFrameSize - 4; i++) {
        calculatedSum += frame[i];
      }

      if (calculatedSum === receivedChecksum) {
        log('Modern frame received and checksum passed!', 'success');
        // Extract TLV data block (starts at index 11)
        const tlvData = frame.slice(11, totalFrameSize - 4);
        decodeSerialTLV(tlvData);
      } else {
        log('Modern BLE Checksum failed', 'warning');
      }
    }
  }
}

function decodeBleFrame(frame) {
  const infoType = frame[4];
  
  // Helper to read 16-bit little-endian
  const readU16LE = (offset) => frame[offset] | (frame[offset + 1] << 8);
  const readU32LE = (offset) => frame[offset] | (frame[offset + 1] << 8) | (frame[offset + 2] << 16) | (frame[offset + 3] << 24);
  const readI32LE = (offset) => {
    let val = readU32LE(offset);
    return val >= 0x80000000 ? val - 0x100000000 : val;
  };
  const readString = (offset, len) => new TextDecoder().decode(frame.slice(offset, offset + len)).replace(/\0+$/, '').trim();

  // Detect 24S or 32S model configuration
  // If byte 287 has value > 0, it is 32S
  const is32S = frame[287] > 0;
  state.bmsData.cell_info.cell_count = is32S ? 32 : 24;

  const offsetAdjust = (offset) => {
    if (!is32S) return 0;
    if (offset >= 112) return 32;
    if (offset >= 54) return 16;
    return 0;
  };

  const getAdjustedOffset = (baseOffset) => baseOffset + offsetAdjust(baseOffset);

  if (infoType === 0x01) {
    // Settings frame
    log('Parsed BLE settings frame', 'info');
    const s = state.bmsData.settings;
    s.cell_voltage_undervoltage_protection = readU32LE(10) * 0.001;
    s.cell_voltage_overvoltage_protection = readU32LE(18) * 0.001;
    s.balancing_start_voltage = readU32LE(26) * 0.001;
    s.charging_overcurrent_protection = readU32LE(50) * 0.001; // wait, settings max charge
    s.discharging_overcurrent_protection = readU32LE(62) * 0.001;
    s.cell_count = readU32LE(114);
    s.charging_switch_enabled = frame[118] > 0;
    s.discharging_switch_enabled = frame[122] > 0;
    s.balancing_switch_enabled = frame[126] > 0;
    s.full_charge_capacity = readU32LE(50) * 0.001; // placeholder
    s.actual_battery_capacity = readU32LE(50) * 0.001;
    s.battery_type = 'Lithium Iron Phosphate';
    
    updateUI();
  } 
  else if (infoType === 0x02) {
    // Cell info telemetry frame
    const d = state.bmsData.cell_info;
    const s = state.bmsData.settings;
    const alarms = state.bmsData.alarms;

    // 1. Parse Cell Voltages (up to settings cell count)
    const cellCount = s.cell_count || state.bmsData.cell_info.cell_count || 16;
    d.voltages = [];
    for (let i = 0; i < cellCount; i++) {
      d.voltages.push(readU16LE(6 + i * 2) * 0.001);
    }

    // 2. Parse telemetry values
    const oAvg = getAdjustedOffset(58);
    d.average_cell_voltage = readU16LE(oAvg) * 0.001;
    d.delta_cell_voltage = readU16LE(oAvg + 2) * 0.001;
    d.max_voltage_cell = frame[oAvg + 4];
    d.min_voltage_cell = frame[oAvg + 5];

    // resistances
    const oRes = getAdjustedOffset(64);
    d.resistances = [];
    for (let i = 0; i < cellCount; i++) {
      d.resistances.push(readU16LE(oRes + i * 2) * 0.000001); // mOhm conversion helper
    }

    // electrical metrics
    const oTotV = getAdjustedOffset(118);
    d.total_voltage = readU16LE(oTotV) * 0.001;
    d.current = readI32LE(oTotV + 8) * 0.001; // offset 126 in 24S

    // temperatures
    const oTemp = getAdjustedOffset(130);
    d.temperature_sensor_1 = readU16LE(oTemp) * 0.1;
    d.temperature_sensor_2 = readU16LE(oTemp + 2) * 0.1;
    d.temperature_mos = is32S ? readU16LE(112 + 32) * 0.1 : readU16LE(134) * 0.1;

    d.battery_soc = frame[getAdjustedOffset(141)];
    d.capacity_remain = readU32LE(getAdjustedOffset(142)) * 0.001;
    s.full_charge_capacity = readU32LE(getAdjustedOffset(146)) * 0.001; // nominal capacity
    d.cycle_count = readU32LE(getAdjustedOffset(150));
    d.cycle_capacity = readU32LE(getAdjustedOffset(154)) * 0.001;

    s.charging_switch_enabled = frame[getAdjustedOffset(166)] > 0;
    s.discharging_switch_enabled = frame[getAdjustedOffset(167)] > 0;
    s.balancing_switch_enabled = frame[getAdjustedOffset(191)] > 0;

    // Alarms parsing from warning bitmask
    const alarmBitmask = readU16LE(136); // Warning bitmask offset
    alarms.bitmask = alarmBitmask;
    alarms.resistance_too_high = !!(alarmBitmask & (1 << 0));
    alarms.cell_count_wrong = !!(alarmBitmask & (1 << 2));
    alarms.charge_overvoltage = !!(alarmBitmask & (1 << 4));
    alarms.charge_overcurrent = !!(alarmBitmask & (1 << 6));
    alarms.charge_undertemp = !!(alarmBitmask & (1 << 9));
    alarms.cell_undervoltage = !!(alarmBitmask & (1 << 11));
    alarms.discharge_overcurrent = !!(alarmBitmask & (1 << 13));
    alarms.discharge_overtemp = !!(alarmBitmask & (1 << 15));
    alarms.mosfet_overtemp = !!(alarmBitmask & (1 << 1));

    // Update history for canvas graph
    addToHistory(d.total_voltage, d.current);

    updateUI();
  } 
  else if (infoType === 0x03) {
    // Device info frame
    log('Parsed BLE device info frame', 'info');
    const dev = state.bmsData.device_info;
    dev.vendor_id = readString(6, 16);
    dev.hw_rev = readString(22, 8);
    dev.sw_rev = readString(30, 8);
    dev.uptime = readU32LE(38);
    dev.production = readString(78, 8);
    dev.serial_number = readString(86, 10);
    
    updateUI();
  }
}

function onBleDisconnected() {
  log('Bluetooth device disconnected GATT Server.', 'error');
  disconnect();
}

// ----------------------------------------------------
// WEB SERIAL API
// ----------------------------------------------------
async function connectSerial() {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot connecting';
  log('Requesting Serial Port...', 'info');

  try {
    const port = await navigator.serial.requestPort();
    log('Port selected. Opening port at 115200 baud...', 'info');
    
    await port.open({
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    });

    state.device = port;
    state.connected = true;
    state.connectionType = 'serial';
    log('Serial Port Connected!', 'success');

    // Read loop
    readSerialStream(port);

    // Write periodic poll loop (Command 0x06: Read All)
    sendSerialPoll();
    state.serialPollInterval = setInterval(sendSerialPoll, 2000);

    updateUI();
  } catch (error) {
    log(`Serial Port Connection Failed: ${error.message}`, 'error');
    dot.className = 'status-dot';
    updateUI();
  }
}

async function sendSerialPoll() {
  if (!state.device || !state.connected) return;

  // Status request payload
  // 0x4E 0x57 0x00 0x13 0x00 0x00 0x00 0x00 0x06 0x03 0x00 0x00 0x00 0x00 0x00 0x00 0x68 0x00 0x00 0x01 0x29
  const frame = new Uint8Array([
    0x4E, 0x57, 0x00, 0x13, 0x00, 0x00, 0x00, 0x00, 0x06, 0x03, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x68, 0x00, 0x00, 0x01, 0x29
  ]);

  try {
    const writer = state.device.writable.getWriter();
    await writer.write(frame);
    writer.releaseLock();
    // log('Serial poll sent (Read All Data)', 'raw');
  } catch (error) {
    log(`Failed to write to serial port: ${error.message}`, 'error');
  }
}

async function readSerialStream(port) {
  while (port.readable && state.connected) {
    try {
      const reader = port.readable.getReader();
      state.serialReader = reader;
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          log('Serial reader stream closed.', 'info');
          break;
        }
        if (value) {
          handleSerialBytes(value);
        }
      }
      reader.releaseLock();
    } catch (error) {
      log(`Serial read error: ${error.message}`, 'error');
      break;
    }
  }
}

function handleSerialBytes(value) {
  // Append new data to buffer
  const newBuf = new Uint8Array(serialBuffer.length + value.length);
  newBuf.set(serialBuffer, 0);
  newBuf.set(value, serialBuffer.length);
  serialBuffer = newBuf;

  // Search for the Start frame sequence: 0x4E, 0x57 ("NW")
  let startIndex = -1;
  for (let i = 0; i < serialBuffer.length - 3; i++) {
    if (serialBuffer[i] === 0x4E && serialBuffer[i+1] === 0x57) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    if (serialBuffer.length > 2) {
      serialBuffer = serialBuffer.slice(serialBuffer.length - 2);
    }
    return;
  }

  if (startIndex > 0) {
    serialBuffer = serialBuffer.slice(startIndex);
  }

  if (serialBuffer.length >= 4) {
    // Read payload length (indices 2 and 3)
    const payloadLength = (serialBuffer[2] << 8) | serialBuffer[3];
    const totalFrameSize = payloadLength + 2; // Frame header is 2 bytes, total frame is length + 2

    if (serialBuffer.length >= totalFrameSize) {
      const frame = serialBuffer.slice(0, totalFrameSize);
      serialBuffer = serialBuffer.slice(totalFrameSize);

      // Verify Checksum (4-byte sum at the end of the frame)
      const last = totalFrameSize - 1;
      const receivedChecksum = (frame[last-3] << 24) | (frame[last-2] << 16) | (frame[last-1] << 8) | frame[last];
      
      // Calculate sum of all bytes except checksum
      let calculatedSum = 0;
      for (let i = 0; i < totalFrameSize - 4; i++) {
        calculatedSum += frame[i];
      }

      if (calculatedSum === receivedChecksum) {
        // Extract TLV data block (starts at index 11 after the header)
        // Header bytes: Header (2) + Length (2) + Terminal ID (4) + Command (1) + Source (1) + Transport (1) = 11 bytes
        const tlvData = frame.slice(11, totalFrameSize - 4); // exclude checksum and end bytes
        decodeSerialTLV(tlvData);
      } else {
        log(`Serial Packet dropped: Checksum failed. Calc: ${calculatedSum}, Recv: ${receivedChecksum}`, 'warning');
      }
    }
  }
}

function decodeSerialTLV(data) {
  const d = state.bmsData.cell_info;
  const s = state.bmsData.settings;
  const dev = state.bmsData.device_info;
  const alarms = state.bmsData.alarms;

  let index = 0;
  
  // Helper functions
  const getU16 = (idx) => (data[idx] << 8) | data[idx + 1];
  const getU32 = (idx) => (data[idx] << 24) | (data[idx + 1] << 16) | (data[idx + 2] << 8) | data[idx + 3];
  const getTemp = (val) => val > 100 ? 100 - val : val;
  const getString = (idx, len) => new TextDecoder().decode(data.slice(idx, idx + len)).replace(/\0+$/, '').trim();

  while (index < data.length) {
    const registerId = data[index];
    index++;

    if (registerId === 0x68) {
      // End code
      break;
    }

    switch (registerId) {
      case 0x79: { // Cell Voltages
        const len = data[index];
        index++;
        const cellCount = len / 3;
        d.voltages = [];
        for (let i = 0; i < cellCount; i++) {
          const cellNum = data[index];
          const voltage = getU16(index + 1) * 0.001; // mV to V
          d.voltages[cellNum - 1] = voltage;
          index += 3;
        }
        d.cell_count = cellCount;
        break;
      }
      case 0x80: // MOSFET Temperature
        d.temperature_mos = getTemp(getU16(index));
        index += 2;
        break;
      case 0x81: // Box Temperature
        d.temperature_box = getTemp(getU16(index));
        index += 2;
        break;
      case 0x82: // Sensor 1 (Battery) Temperature
        d.temperature_sensor_1 = getTemp(getU16(index));
        index += 2;
        break;
      case 0x83: // Total pack voltage
        d.total_voltage = getU16(index) * 0.01;
        index += 2;
        break;
      case 0x84: { // Current
        const currentVal = getU16(index);
        if (currentVal >= 32768) {
          d.current = (currentVal - 32768) * 0.01; // Charging
        } else {
          d.current = -currentVal * 0.01; // Discharging
        }
        index += 2;
        break;
      }
      case 0x85: // SOC
        d.battery_soc = data[index];
        index++;
        break;
      case 0x86: // Temp sensors count
        d.temp_sensors_count = data[index];
        index++;
        break;
      case 0x87: // Cycle count
        d.cycle_count = getU16(index);
        index += 2;
        break;
      case 0x89: // Cycle capacity (Ah)
        d.cycle_capacity = getU32(index) * 0.001;
        index += 4;
        break;
      case 0x8A: // String cell count settings
        s.cell_count = getU16(index);
        index += 2;
        break;
      case 0x8B: { // Active alarms
        const val = getU16(index);
        alarms.bitmask = val;
        alarms.resistance_too_high = !!(val & (1 << 0));
        alarms.mosfet_overtemp = !!(val & (1 << 1));
        alarms.cell_count_wrong = !!(val & (1 << 2));
        alarms.charge_overvoltage = !!(val & (1 << 4));
        alarms.charge_overcurrent = !!(val & (1 << 6));
        alarms.charge_undertemp = !!(val & (1 << 9));
        alarms.cell_undervoltage = !!(val & (1 << 11));
        alarms.discharge_overcurrent = !!(val & (1 << 13));
        alarms.discharge_overtemp = !!(val & (1 << 15));
        index += 2;
        break;
      }
      case 0x8C: { // Switch states
        const val = getU16(index);
        s.charging_switch_enabled = !!(val & (1 << 0));
        s.discharging_switch_enabled = !!(val & (1 << 1));
        s.balancing_switch_enabled = !!(val & (1 << 2));
        index += 2;
        break;
      }
      case 0x8E: // Total OVP
        s.total_voltage_overvoltage_protection = getU16(index) * 0.01;
        index += 2;
        break;
      case 0x8F: // Total UVP
        s.total_voltage_undervoltage_protection = getU16(index) * 0.01;
        index += 2;
        break;
      case 0x90: // Cell OVP limit
        s.cell_voltage_overvoltage_protection = getU16(index) * 0.001;
        index += 2;
        break;
      case 0x93: // Cell UVP limit
        s.cell_voltage_undervoltage_protection = getU16(index) * 0.001;
        index += 2;
        break;
      case 0x97: // Discharge OCP
        s.discharging_overcurrent_protection = getU16(index);
        index += 2;
        break;
      case 0x99: // Charge OCP
        s.charging_overcurrent_protection = getU16(index);
        index += 2;
        break;
      case 0x9B: // Start Balance Volts
        s.balancing_start_voltage = getU16(index) * 0.001;
        index += 2;
        break;
      case 0x9C: // Delta Balance Volts
        s.balancing_delta_voltage = getU16(index) * 0.001;
        index += 2;
        break;
      case 0x9D: // Active balance switch
        s.balancing_switch_enabled = data[index] > 0;
        index++;
        break;
      case 0xAA: // Full charge nominal capacity
        s.full_charge_capacity = getU32(index); // Ah
        index += 4;
        break;
      case 0xAB: // Charging switch RW
        s.charging_switch_enabled = data[index] > 0;
        index++;
        break;
      case 0xAC: // Discharging switch RW
        s.discharging_switch_enabled = data[index] > 0;
        index++;
        break;
      case 0xAE: // Board address
        index++;
        break;
      case 0xAF: { // Battery type
        const type = data[index];
        s.battery_type = type === 0 ? 'Lithium Iron Phosphate' : type === 1 ? 'Ternary Lithium' : 'Lithium Titanate';
        index++;
        break;
      }
      case 0xB0: // Sleep wait time
        index += 2;
        break;
      case 0xB1: // Low capacity alarm limit
        index++;
        break;
      case 0xB2: // Password
        index += 10;
        break;
      case 0xB4: // Device Type ID
        dev.vendor_id = getString(index, 8);
        index += 8;
        break;
      case 0xB6: // Runtime hours
        dev.uptime = getU32(index); // mins
        index += 4;
        break;
      case 0xB7: // Software version
        dev.sw_rev = getString(index, 15);
        index += 15;
        break;
      case 0xB9: // Actual battery capacity
        s.actual_battery_capacity = getU32(index);
        index += 4;
        break;
      case 0xBA: // Manufacturer name
        dev.production = getString(index, 24);
        index += 24;
        break;
      case 0xC0: // Protocol version
        index++;
        break;
      default:
        // If register size is unknown, skip by 1 byte to continue.
        // Known JKBMS registers are fully mapped above.
        index++;
        break;
    }
  }

  // Derived metrics calculations
  if (d.voltages.length > 0) {
    let max = -Infinity;
    let min = Infinity;
    let sum = 0;
    let maxIdx = 0;
    let minIdx = 0;

    for (let i = 0; i < d.voltages.length; i++) {
      const v = d.voltages[i];
      sum += v;
      if (v > max) { max = v; maxIdx = i + 1; }
      if (v < min) { min = v; minIdx = i + 1; }
    }

    d.average_cell_voltage = sum / d.voltages.length;
    d.delta_cell_voltage = max - min;
    d.max_voltage_cell = maxIdx;
    d.min_voltage_cell = minIdx;
  }

  // Update history
  addToHistory(d.total_voltage, d.current);

  updateUI();
}

// Disconnect helper
function disconnect() {
  if (state.connectionType === 'ble' && state.device) {
    log('Disconnecting Bluetooth...', 'info');
    try {
      state.device.gatt.disconnect();
    } catch (e) {}
  } else if (state.connectionType === 'serial' && state.device) {
    log('Disconnecting Serial Port...', 'info');
    clearInterval(state.serialPollInterval);
    try {
      if (state.serialReader) state.serialReader.cancel();
      state.device.close();
    } catch (e) {}
  }

  if (state.blePollInterval) {
    clearInterval(state.blePollInterval);
    state.blePollInterval = null;
  }

  state.connected = false;
  state.connectionType = null;
  state.device = null;
  state.bleWriteChar = null;
  state.bleNotifyChars = [];
  state.serialReader = null;
  state.serialPollInterval = null;

  log('Disconnected.', 'info');
  updateUI();
}



// ----------------------------------------------------
// TELEMETRY GRAPH CANVAS DRAWING
// ----------------------------------------------------
function addToHistory(volts, current) {
  state.history.voltage.push(volts);
  state.history.current.push(current);
  state.history.timestamps.push(new Date().toLocaleTimeString());
  
  if (state.history.voltage.length > state.history.maxPoints) {
    state.history.voltage.shift();
    state.history.current.shift();
    state.history.timestamps.shift();
  }
  drawChart();
}

function drawChart() {
  if (!ctx || !canvas) return;

  // Clear Canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const width = canvas.width;
  const height = canvas.height;
  const padding = { top: 20, right: 50, bottom: 25, left: 50 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  // Draw background grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (plotHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  // Draw axes borders
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.lineTo(width - padding.right, padding.top);
  ctx.stroke();

  const len = state.history.voltage.length;
  if (len < 2) {
    // Show empty state message
    ctx.fillStyle = 'var(--text-secondary)';
    ctx.font = '13px var(--font-sans)';
    ctx.textAlign = 'center';
    ctx.fillText('Real-time Telemetry Graph (Waiting for stream...)', width / 2, height / 2);
    return;
  }

  // Find min/max limits
  let minV = Math.min(...state.history.voltage) - 0.5;
  let maxV = Math.max(...state.history.voltage) + 0.5;
  let minA = Math.min(...state.history.current) - 5;
  let maxA = Math.max(...state.history.current) + 5;

  // Avoid identical min/max causing divide by zero
  if (Math.abs(maxV - minV) < 0.1) { minV -= 1; maxV += 1; }
  if (Math.abs(maxA - minA) < 0.1) { minA -= 5; maxA += 5; }

  // Draw Left Axis labels (Voltage) - Cyan
  ctx.fillStyle = 'var(--cyan-glow)';
  ctx.font = '10px var(--font-sans)';
  ctx.textAlign = 'right';
  ctx.fillText(`${maxV.toFixed(1)}V`, padding.left - 8, padding.top + 4);
  ctx.fillText(`${((maxV + minV) / 2).toFixed(1)}V`, padding.left - 8, padding.top + plotHeight / 2 + 4);
  ctx.fillText(`${minV.toFixed(1)}V`, padding.left - 8, height - padding.bottom);

  // Draw Right Axis labels (Current) - Amber/Green
  ctx.fillStyle = 'var(--green-glow)';
  ctx.textAlign = 'left';
  ctx.fillText(`${maxA.toFixed(1)}A`, width - padding.right + 8, padding.top + 4);
  ctx.fillText(`${((maxA + minA) / 2).toFixed(1)}A`, width - padding.right + 8, padding.top + plotHeight / 2 + 4);
  ctx.fillText(`${minA.toFixed(1)}A`, width - padding.right + 8, height - padding.bottom);

  // Draw Time Axis label
  ctx.fillStyle = 'var(--text-secondary)';
  ctx.font = '9px var(--font-sans)';
  ctx.textAlign = 'center';
  ctx.fillText('Real-time Stream History (Last 60 seconds)', width / 2, height - 6);

  // Plot Voltage Line - Cyan
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'var(--cyan-glow)';
  for (let i = 0; i < len; i++) {
    const x = padding.left + (plotWidth / (state.history.maxPoints - 1)) * i;
    const normY = (state.history.voltage[i] - minV) / (maxV - minV);
    const y = height - padding.bottom - normY * plotHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Plot Current Line - Green
  ctx.beginPath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'var(--green-glow)';
  for (let i = 0; i < len; i++) {
    const x = padding.left + (plotWidth / (state.history.maxPoints - 1)) * i;
    const normY = (state.history.current[i] - minA) / (maxA - minA);
    const y = height - padding.bottom - normY * plotHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ----------------------------------------------------
// BLE WRITE TIMEOUT WRAPPER
// ----------------------------------------------------
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// ----------------------------------------------------
// JIKONG BLE COMMAND FRAME BUILDERS
// ----------------------------------------------------
function buildLegacyReadCommand(command) {
  const frame = new Uint8Array(20);
  frame[0] = 0xAA;
  frame[1] = 0x55;
  frame[2] = 0x90;
  frame[3] = 0xEB;
  frame[4] = command;
  frame[5] = 0x00;
  let crc = 0;
  for (let i = 0; i < 19; i++) {
    crc = (crc + frame[i]) & 0xFF;
  }
  frame[19] = crc;
  return frame;
}

function buildLegacyReverseReadCommand(command) {
  const frame = new Uint8Array(20);
  frame[0] = 0x55;
  frame[1] = 0xAA;
  frame[2] = 0xEB;
  frame[3] = 0x90;
  frame[4] = command;
  frame[5] = 0x00;
  let crc = 0;
  for (let i = 0; i < 19; i++) {
    crc = (crc + frame[i]) & 0xFF;
  }
  frame[19] = crc;
  return frame;
}

function buildLegacyL1V1Command(command) {
  const frame = new Uint8Array(20);
  frame[0] = 0xAA;
  frame[1] = 0x55;
  frame[2] = 0x90;
  frame[3] = 0xEB;
  frame[4] = command;
  frame[5] = 0x01;
  frame[6] = 0x01;
  let crc = 0;
  for (let i = 0; i < 19; i++) {
    crc = (crc + frame[i]) & 0xFF;
  }
  frame[19] = crc;
  return frame;
}

function buildReadCommand() {
  return new Uint8Array([
    0x4E, 0x57, 0x00, 0x13, 0x00, 0x00, 0x00, 0x00,
    0x06, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x68, 0x00, 0x00, 0x01, 0x29
  ]);
}
