"use client";

import React, { useState, useEffect, useRef } from "react";

// =================================================================
// PROTOCOL DEFINITIONS & PACKET HELPERS
// =================================================================

interface BMSStats {
  voltage: number;
  current: number;
  power: number;
  soc: number;
  remainingAh: number;
  capacityAh: number;
  cellTemp: number;
  bmsTemp: number;
  cycles: number;
  cellCount: number;
  cells: number[];
  minCell: { idx: number; volt: number } | null;
  maxCell: { idx: number; volt: number } | null;
}

const initialStats: BMSStats = {
  voltage: 0,
  current: 0,
  power: 0,
  soc: 0,
  remainingAh: 0,
  capacityAh: 0,
  cellTemp: 0,
  bmsTemp: 0,
  cycles: 0,
  cellCount: 0,
  cells: [],
  minCell: null,
  maxCell: null,
};

// Helper to convert byte array to Hex String
function toHexString(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

// Helper to read Big-Endian multi-byte values
function getUint16BE(data: number[] | Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function getInt16BE(data: number[] | Uint8Array, offset: number): number {
  const val = (data[offset] << 8) | data[offset + 1];
  return val >= 0x8000 ? val - 0x10000 : val;
}

function getUint32BE(data: number[] | Uint8Array, offset: number): number {
  return (
    (data[offset] << 24) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  );
}

function getInt32BE(data: number[] | Uint8Array, offset: number): number {
  const val =
    (data[offset] << 24) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3];
  return val >= 0x80000000 ? val - 0x100000000 : val;
}

// JK BMS Temperature Parser helper
// 99 = 99°C, 100 = 100°C, 101 = -1°C, 140 = -40°C
function parseJKTemp(val: number): number {
  if (val <= 100) return val;
  return 100 - val;
}

// Compute Min/Max Cell voltages
function calculateMinMaxCells(cells: number[]) {
  if (cells.length === 0) return { minCell: null, maxCell: null };
  let minVolt = Infinity;
  let maxVolt = -Infinity;
  let minIdx = -1;
  let maxIdx = -1;

  cells.forEach((v, idx) => {
    if (v < minVolt) {
      minVolt = v;
      minIdx = idx + 1;
    }
    if (v > maxVolt) {
      maxVolt = v;
      maxIdx = idx + 1;
    }
  });

  return {
    minCell: { idx: minIdx, volt: minVolt },
    maxCell: { idx: maxIdx, volt: maxVolt },
  };
}

export default function BMSConnectApp() {
  // Navigation Screens: "scan" | "connecting" | "detecting" | "dashboard"
  const [screen, setScreen] = useState<"scan" | "connecting" | "detecting" | "dashboard">("scan");
  
  // App State
  const [isBluetoothSupported, setIsBluetoothSupported] = useState(true);
  const [connectingMsg, setConnectingMsg] = useState("");
  const [detectingStatus, setDetectingStatus] = useState("");
  const [connectedServiceUUID, setConnectedServiceUUID] = useState("");
  const [detectedProtocol, setDetectedProtocol] = useState<string>("Unknown");
  const [stats, setStats] = useState<BMSStats>(initialStats);
  const [deviceName, setDeviceName] = useState("Unknown Device");
  const [deviceId, setDeviceId] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "error" | "info" | "success" } | null>(null);
  const [rawPackets, setRawPackets] = useState<{ timestamp: string; hex: string }[]>([]);
  const [isDebugOpen, setIsDebugOpen] = useState(false);

  // Web Bluetooth references
  const deviceRef = useRef<any>(null);
  const writeCharRef = useRef<any>(null);
  const notifyCharRef = useRef<any>(null);
  const loopActiveRef = useRef<boolean>(false);
  const bufferAccumulatorRef = useRef<number[]>([]);
  
  // Keep track of latest values for polling loop
  const protocolRef = useRef<string>("Unknown");
  protocolRef.current = detectedProtocol;

  // Non-blocking toast helper
  const showToast = (message: string, type: "error" | "info" | "success" = "info") => {
    setToast({ message, type });
    setTimeout(() => {
      setToast((prev) => (prev && prev.message === message ? null : prev));
    }, 3000);
  };

  // Check browser Bluetooth support and register Service Worker on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (!(navigator as any).bluetooth) {
        setIsBluetoothSupported(false);
      }
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .register("/sw.js")
          .then((reg) => console.log("Service Worker registered:", reg.scope))
          .catch((err) => console.error("Service Worker registration failed:", err));
      }
    }
  }, []);

  // GATT Disconnect handler
  const handleDisconnect = () => {
    cleanupConnection();
    setScreen("scan");
    showToast("Device disconnect ho gaya", "error");
  };

  const cleanupConnection = () => {
    loopActiveRef.current = false;
    bufferAccumulatorRef.current = [];
    if (deviceRef.current && deviceRef.current.gatt.connected) {
      try {
        deviceRef.current.gatt.disconnect();
      } catch (e) {
        console.error("Disconnect error:", e);
      }
    }
    deviceRef.current = null;
    writeCharRef.current = null;
    notifyCharRef.current = null;
    setStats(initialStats);
    setDetectedProtocol("Unknown");
    setConnectedServiceUUID("");
  };

  // =================================================================
  // SCAN & CONNECT FLOW
  // =================================================================

  const handleScanAndConnect = async () => {
    if (!(navigator as any).bluetooth) {
      showToast("Web Bluetooth support nahi hai", "error");
      return;
    }

    try {
      setConnectingMsg("Searching for BLE devices...");
      setScreen("connecting");

      // Scan request
      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [
          { services: [0xFF00] },
          { services: [0xFFE0] },
          { services: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'] }
        ],
        optionalServices: [
          0xff00, // JBD Primary
          0xffe0, // JBD fallback / DALY / ANT / Generic
          "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // JK BMS (Nordic UART)
        ],
      });

      deviceRef.current = device;
      setDeviceName(device.name || "Unknown Device");
      setDeviceId(device.id);

      // Listen to disconnect events
      device.addEventListener("gattserverdisconnected", handleDisconnect);

      setConnectingMsg("Connecting to GATT server...");
      const server = await device.gatt.connect();

      // Service UUID discovery chain
      const uuidsToTry = [0xff00, 0xffe0, "6e400001-b5a3-f393-e0a9-e50e24dcca9e"];
      let service: any = null;
      let connectedUUID = "";

      for (const uuid of uuidsToTry) {
        try {
          setConnectingMsg(`Trying service UUID: ${typeof uuid === "number" ? "0x" + uuid.toString(16).toUpperCase() : "Nordic UART"}`);
          service = await server.getPrimaryService(uuid);
          connectedUUID = typeof uuid === "number" ? "0x" + uuid.toString(16).toUpperCase() : uuid;
          break;
        } catch (e) {
          console.log(`Service ${uuid} not found, checking next...`);
        }
      }

      if (!service) {
        throw new Error("Required BMS Services (0xFF00, 0xFFE0, or Nordic UART) not found on device.");
      }

      setConnectedServiceUUID(connectedUUID);
      setConnectingMsg(`Connected to Service ${connectedUUID}. Setting up characteristics...`);

      // Determine write/notify characteristic UUIDs based on connected service
      let writeUuid: string | number = 0xffe2;
      let notifyUuid: string | number = 0xffe1;

      if (connectedUUID.includes("FF00")) {
        writeUuid = 0xff02;
        notifyUuid = 0xff01;
      } else if (connectedUUID.includes("FFE0")) {
        writeUuid = 0xffe2;
        notifyUuid = 0xffe1;
      } else if (connectedUUID === "6e400001-b5a3-f393-e0a9-e50e24dcca9e") {
        writeUuid = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
        notifyUuid = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
      }

      const writeChar = await service.getCharacteristic(writeUuid);
      const notifyChar = await service.getCharacteristic(notifyUuid);

      writeCharRef.current = writeChar;
      notifyCharRef.current = notifyChar;

      // Start notifications
      setConnectingMsg("Starting notifications...");
      await notifyChar.startNotifications();
      notifyChar.addEventListener("characteristicvaluechanged", handleNotification);

      // Transition to Protocol Detection
      setScreen("detecting");
      await detectProtocol();

    } catch (error: any) {
      console.error(error);
      cleanupConnection();
      setScreen("scan");
      if (error.name === "NotFoundError" || error.message?.includes("User cancelled")) {
        showToast("Scan cancel kiya", "info");
      } else {
        showToast("Connect nahi hua, retry karein", "error");
      }
    }
  };

  // Notification value listener
  const handleNotification = (event: any) => {
    const value = event.target.value;
    const uint8 = new Uint8Array(value.buffer);
    
    // Add packet to debug log
    const hexStr = toHexString(uint8);
    const timestamp = new Date().toLocaleTimeString();
    
    setRawPackets((prev) => {
      const next = [{ timestamp, hex: hexStr }, ...prev];
      return next.slice(0, 5); // Keep last 5
    });

    // Push bytes to buffer accumulator
    for (let i = 0; i < uint8.length; i++) {
      bufferAccumulatorRef.current.push(uint8[i]);
    }

    processBufferedPackets();
  };

  // Helper to safely write commands
  const writeCommand = async (bytes: number[]) => {
    if (!writeCharRef.current) {
      showToast("Write characteristic not available", "error");
      return;
    }
    try {
      const dataArray = new Uint8Array(bytes);
      if (typeof writeCharRef.current.writeValueWithResponse === "function") {
        await writeCharRef.current.writeValueWithResponse(dataArray);
      } else {
        await writeCharRef.current.writeValue(dataArray);
      }
    } catch (e) {
      console.error("Write failed:", e);
      showToast("Command failed, retry", "error");
    }
  };

  // =================================================================
  // PROTOCOL DETECTION
  // =================================================================

  const detectProtocol = async () => {
    setDetectingStatus("Sending auto-detect commands...");
    
    // List of probe commands to send to connected battery
    const detectionCommands = [
      { name: "JBD", data: [0xdd, 0xa5, 0x03, 0x00, 0xff, 0xfd] },
      { name: "DALY", data: [0xa5, 0x40, 0x90, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7d] },
      { name: "JK BMS", data: [0xaa, 0x55, 0x90, 0xeb] },
      { name: "ANT BMS", data: [0x5a, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5a] },
      { name: "Generic", data: [0x00, 0x00, 0x01, 0x04, 0x55, 0x13, 0x17, 0xaa] },
    ];

    let detected = "Unknown";

    for (const cmd of detectionCommands) {
      setDetectingStatus(`Checking for ${cmd.name} Protocol...`);
      bufferAccumulatorRef.current = []; // Clear buffer
      
      await writeCommand(cmd.data);
      
      // Wait 2 seconds for matching bytes
      const detectedProto = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          resolve("None");
        }, 2000);

        // Periodically check if matching packet header entered the buffer
        const checkInterval = setInterval(() => {
          const buf = bufferAccumulatorRef.current;
          if (buf.length > 0) {
            const b0 = buf[0];
            const b1 = buf[1] || 0;
            
            if (b0 === 0xdd) {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              resolve("JBD");
            } else if (b0 === 0xa5) {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              resolve("DALY");
            } else if ((b0 === 0x55 && b1 === 0xaa) || (b0 === 0xaa && b1 === 0x55)) {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              resolve("JK BMS");
            } else if (b0 === 0xaa || b0 === 0x5a) {
              // Standard headers for ANT BMS
              clearInterval(checkInterval);
              clearTimeout(timeout);
              resolve("ANT BMS");
            }
          }
        }, 100);
      });

      if (detectedProto !== "None") {
        detected = detectedProto;
        break;
      }
    }

    if (detected === "Unknown" && bufferAccumulatorRef.current.length > 0) {
      // Received response but no explicit header matched, fall back to Generic
      detected = "Generic";
    }

    setDetectedProtocol(detected);
    showToast(`${detected} Protocol detected!`, "success");
    setScreen("dashboard");
    
    // Start Polling Loop
    loopActiveRef.current = true;
    startPollingLoop();
  };

  // =================================================================
  // POLLING LOOP & COMMAND INTERVALS
  // =================================================================

  const startPollingLoop = async () => {
    let tick = 0;
    while (loopActiveRef.current) {
      try {
        const protocol = protocolRef.current;
        console.log(`Polling tick: ${tick}, Protocol: ${protocol}`);

        if (protocol === "JBD") {
          // JBD: Alternate queries or send both.
          if (tick % 2 === 0) {
            await writeCommand([0xdd, 0xa5, 0x03, 0x00, 0xff, 0xfd]); // Basic Info
          } else {
            await writeCommand([0xdd, 0xa5, 0x04, 0x00, 0xff, 0xfc]); // Cell Voltages
          }
        } else if (protocol === "DALY") {
          // DALY: Send SOC, then Min/Max, then Status sequentially
          await writeCommand([0xa5, 0x40, 0x90, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7d]);
          await new Promise((r) => setTimeout(r, 200));
          await writeCommand([0xa5, 0x40, 0x91, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7e]);
          await new Promise((r) => setTimeout(r, 200));
          await writeCommand([0xa5, 0x40, 0x94, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x81]);
        } else if (protocol === "JK BMS") {
          await writeCommand([0xaa, 0x55, 0x90, 0xeb]);
        } else if (protocol === "ANT BMS") {
          await writeCommand([
            0x5a, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5a,
          ]);
        } else {
          // Generic / Unknown Fallback
          await writeCommand([0x00, 0x00, 0x01, 0x04, 0x55, 0x13, 0x17, 0xaa]);
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
      
      tick++;
      // Wait 3 seconds before next poll
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  };

  // =================================================================
  // PACKET PROCESSING & PARSING
  // =================================================================

  const processBufferedPackets = () => {
    const buf = bufferAccumulatorRef.current;
    if (buf.length === 0) return;

    let parsed = false;

    // 1. JBD Processing
    if (buf[0] === 0xdd) {
      if (buf.length >= 4) {
        const payloadLen = buf[3];
        const packetLen = payloadLen + 7;
        if (buf.length >= packetLen) {
          const packet = buf.slice(0, packetLen);
          bufferAccumulatorRef.current = buf.slice(packetLen); // Shift buffer
          if (packet[packetLen - 1] === 0x77) {
            parseJBDPacket(packet);
            parsed = true;
          }
        }
      }
    }
    // 2. DALY Processing (always 13 bytes fixed)
    else if (buf[0] === 0xa5) {
      if (buf.length >= 13) {
        const packet = buf.slice(0, 13);
        bufferAccumulatorRef.current = buf.slice(13); // Shift buffer
        parseDALYPacket(packet);
        parsed = true;
      }
    }
    // 3. JK BMS Processing
    else if ((buf[0] === 0x55 && buf[1] === 0xaa) || (buf[0] === 0xaa && buf[1] === 0x55)) {
      if (buf.length >= 4) {
        // Read 16-bit packet length at offset 2 & 3
        const packetLen = (buf[2] << 8) | buf[3];
        if (packetLen > 0 && buf.length >= packetLen) {
          const packet = buf.slice(0, packetLen);
          bufferAccumulatorRef.current = buf.slice(packetLen);
          parseJKPacket(packet);
          parsed = true;
        }
      }
    }
    // 4. ANT BMS Processing (standard 140 bytes)
    else if (buf[0] === 0xaa || buf[0] === 0x5a) {
      if (buf.length >= 140) {
        const packet = buf.slice(0, 140);
        bufferAccumulatorRef.current = buf.slice(140);
        parseANTPacket(packet);
        parsed = true;
      }
    }
    // 5. Generic / Fallback Processing
    else {
      // If buffer is long (>= 66 bytes), let's parse as Generic
      if (buf.length >= 66) {
        const packet = buf.slice(0, 66);
        bufferAccumulatorRef.current = buf.slice(66);
        parseGenericPacket(packet);
        parsed = true;
      } else {
        // Clear buffer if it doesn't align to any protocol headers and grows too big
        if (buf.length > 500) {
          bufferAccumulatorRef.current = [];
        }
      }
    }

    // Recursively check for more packets in buffer
    if (parsed && bufferAccumulatorRef.current.length > 0) {
      processBufferedPackets();
    }
  };

  // --- PARSER: JBD ---
  const parseJBDPacket = (packet: number[]) => {
    const cmd = packet[1];
    const data = packet.slice(4, packet.length - 3); // Extract payload
    
    setStats((prev) => {
      const next = { ...prev };
      
      if (cmd === 0x03) {
        // Basic Info
        next.voltage = getUint16BE(data, 0) / 100;
        next.current = getInt16BE(data, 2) / 100;
        next.power = Math.round(next.voltage * next.current * 10) / 10;
        next.remainingAh = getUint16BE(data, 4) / 100;
        next.capacityAh = getUint16BE(data, 6) / 100;
        next.soc = next.capacityAh > 0 ? Math.round((next.remainingAh / next.capacityAh) * 100) : 0;
        next.cycles = getUint16BE(data, 8);
        next.cellCount = data[21]; // byte 21 of payload is cell count
        const tempCount = data[22];
        const temps: number[] = [];
        for (let i = 0; i < tempCount; i++) {
          const tVal = getUint16BE(data, 23 + i * 2);
          temps.push(Math.round(((tVal - 2731) / 10) * 10) / 10);
        }
        next.cellTemp = temps[0] || 0;
        next.bmsTemp = temps[1] || temps[0] || 0;
      } else if (cmd === 0x04) {
        // Cell Voltages
        const cellCount = data[0];
        next.cellCount = cellCount;
        const cellVolts: number[] = [];
        for (let i = 0; i < cellCount; i++) {
          cellVolts.push(getUint16BE(data, 1 + i * 2) / 1000);
        }
        next.cells = cellVolts;
        const minMax = calculateMinMaxCells(cellVolts);
        next.minCell = minMax.minCell;
        next.maxCell = minMax.maxCell;
      }
      
      return next;
    });
  };

  // --- PARSER: DALY ---
  const parseDALYPacket = (packet: number[]) => {
    const cmd = packet[2];
    const data = packet.slice(4, 12); // Payload is bytes 4 to 11

    setStats((prev) => {
      const next = { ...prev };
      
      if (cmd === 0x90) {
        // SOC & Stats
        next.voltage = getUint16BE(data, 0) / 10;
        next.current = Math.round(((getUint16BE(data, 2) - 30000) / 10) * 10) / 10;
        next.power = Math.round(next.voltage * next.current * 10) / 10;
        next.soc = getUint16BE(data, 4) / 10;
      } else if (cmd === 0x91) {
        // Min/Max Cell voltages
        const maxV = getUint16BE(data, 0) / 1000;
        const maxIdx = data[2];
        const minV = getUint16BE(data, 3) / 1000;
        const minIdx = data[5];
        next.minCell = { idx: minIdx, volt: minV };
        next.maxCell = { idx: maxIdx, volt: maxV };
      } else if (cmd === 0x94) {
        // Status: Cell Count & Temperature count
        next.cellCount = data[0];
        // Populate mock cell list around average if actual cells list is empty
        if (next.cells.length !== next.cellCount && next.voltage > 0) {
          const avg = next.voltage / (next.cellCount || 1);
          const cellList = Array(next.cellCount).fill(0).map(() => Math.round(avg * 1000) / 1000);
          
          // Inject min/max if we parsed them
          if (next.minCell && next.minCell.idx <= cellList.length) {
            cellList[next.minCell.idx - 1] = next.minCell.volt;
          }
          if (next.maxCell && next.maxCell.idx <= cellList.length) {
            cellList[next.maxCell.idx - 1] = next.maxCell.volt;
          }
          next.cells = cellList;
        }
      }

      return next;
    });
  };

  // --- PARSER: JK BMS ---
  const parseJKPacket = (data: number[]) => {
    // Dynamic tag parsing loop
    setStats((prev) => {
      const next = { ...prev };
      
      // Look for individual cell voltages tag 0x79
      const cIdx = data.indexOf(0x79);
      if (cIdx !== -1 && cIdx + 1 < data.length) {
        const len = data[cIdx + 1];
        if (cIdx + 1 + len < data.length) {
          const cellVolts: number[] = [];
          for (let i = 0; i < len; i += 3) {
            const cellIdx = data[cIdx + 2 + i];
            const v = getUint16BE(data, cIdx + 2 + i + 1) / 1000;
            if (cellIdx > 0) {
              cellVolts[cellIdx - 1] = v;
            }
          }
          // Clean undefined items in cellVolts
          const cleanCells = cellVolts.filter((v) => typeof v === "number");
          next.cells = cleanCells;
          next.cellCount = cleanCells.length;
          
          const minMax = calculateMinMaxCells(cleanCells);
          next.minCell = minMax.minCell;
          next.maxCell = minMax.maxCell;
        }
      }

      // 0x83: Total Voltage
      const vIdx = data.indexOf(0x83);
      if (vIdx !== -1 && vIdx + 2 < data.length) {
        next.voltage = getUint16BE(data, vIdx + 1) * 0.01;
      }

      // 0x84: Current
      const curIdx = data.indexOf(0x84);
      if (curIdx !== -1 && curIdx + 2 < data.length) {
        const rawCurrent = getUint16BE(data, curIdx + 1);
        next.current = Math.round((rawCurrent - 32768) * 0.01 * 10) / 10;
        next.power = Math.round(next.voltage * next.current * 10) / 10;
      }

      // 0x85: SOC
      const sIdx = data.indexOf(0x85);
      if (sIdx !== -1 && sIdx + 1 < data.length) {
        next.soc = data[sIdx + 1];
      }

      // 0x80: MOSFET Temp
      const t0Idx = data.indexOf(0x80);
      if (t0Idx !== -1 && t0Idx + 2 < data.length) {
        next.bmsTemp = parseJKTemp(getUint16BE(data, t0Idx + 1));
      }

      // 0x81: Temp 1
      const t1Idx = data.indexOf(0x81);
      if (t1Idx !== -1 && t1Idx + 2 < data.length) {
        next.cellTemp = parseJKTemp(getUint16BE(data, t1Idx + 1));
      }

      // 0x87: Cycles
      const cyIdx = data.indexOf(0x87);
      if (cyIdx !== -1 && cyIdx + 2 < data.length) {
        next.cycles = getUint16BE(data, cyIdx + 1);
      }

      return next;
    });
  };

  // --- PARSER: ANT BMS ---
  const parseANTPacket = (data: number[]) => {
    setStats((prev) => {
      const next = { ...prev };
      
      // Cell Voltages from offset 4 (up to 32 cells)
      const cellVolts: number[] = [];
      for (let i = 0; i < 32; i++) {
        const v = getUint16BE(data, 4 + i * 2);
        if (v > 0 && v < 5000) {
          cellVolts.push(v / 1000);
        }
      }
      next.cells = cellVolts;
      next.cellCount = cellVolts.length;
      
      const minMax = calculateMinMaxCells(cellVolts);
      next.minCell = minMax.minCell;
      next.maxCell = minMax.maxCell;

      // Current at offset 70 (4 bytes, unit: 0.1 A)
      next.current = Math.round((getInt32BE(data, 70) * 0.1) * 10) / 10;

      // SOC at offset 74 (1 byte)
      next.soc = data[74];

      // Capacity at offset 75 (4 bytes, unit: Ah)
      next.capacityAh = getUint32BE(data, 75) / 1000; // AH in mAh usually

      // Remaining Capacity at offset 79 (4 bytes, unit: Ah)
      next.remainingAh = getUint32BE(data, 79) / 1000;

      // Voltage sum of cells
      next.voltage = cellVolts.reduce((sum, v) => sum + v, 0);
      next.power = Math.round(next.voltage * next.current * 10) / 10;

      // Temps from offset 91 (each 2-byte short)
      next.cellTemp = getInt16BE(data, 91);
      next.bmsTemp = getInt16BE(data, 93);

      return next;
    });
  };

  // --- PARSER: Generic Fallback ---
  const parseGenericPacket = (data: number[]) => {
    setStats((prev) => {
      const next = { ...prev };
      
      // Voltage: Uint32 at offset 12 / 1000
      next.voltage = getUint32BE(data, 12) / 1000;

      // Current: Int32 at offset 48 / 1000
      next.current = Math.round((getInt32BE(data, 48) / 1000) * 10) / 10;
      next.power = Math.round(next.voltage * next.current * 10) / 10;

      // Remaining: Uint16 at offset 62 / 100
      next.remainingAh = getUint16BE(data, 62) / 100;

      // Capacity: Uint16 at offset 64 / 100
      next.capacityAh = getUint16BE(data, 64) / 100;
      next.soc = next.capacityAh > 0 ? Math.round((next.remainingAh / next.capacityAh) * 100) : 0;

      // Temps: offset 52 (cell), offset 54 (bms)
      next.cellTemp = getInt16BE(data, 52);
      next.bmsTemp = getInt16BE(data, 54);

      // Cells: 16x Uint16 from offset 16
      const cellVolts: number[] = [];
      for (let i = 0; i < 16; i++) {
        const v = getUint16BE(data, 16 + i * 2) / 1000;
        if (v > 0) {
          cellVolts.push(v);
        }
      }
      next.cells = cellVolts;
      next.cellCount = cellVolts.length;

      const minMax = calculateMinMaxCells(cellVolts);
      next.minCell = minMax.minCell;
      next.maxCell = minMax.maxCell;

      return next;
    });
  };

  // =================================================================
  // CONTROLS (ON/OFF COMMANDS)
  // =================================================================

  const handleChargeToggle = async (turnOn: boolean) => {
    const protocol = protocolRef.current;
    showToast(`Sending Charge ${turnOn ? "ON" : "OFF"} command...`, "info");
    
    let cmd: number[] = [];
    if (protocol === "JBD") {
      cmd = turnOn
        ? [0xdd, 0x5a, 0xe1, 0x02, 0x00, 0x01, 0xff, 0x1c, 0x77] // Charge ON
        : [0xdd, 0x5a, 0xe1, 0x02, 0x00, 0x00, 0xff, 0x1d, 0x77]; // Charge OFF
    } else if (protocol === "DALY") {
      cmd = turnOn
        ? [0xa5, 0x40, 0x97, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x85] // MOS ON
        : [0xa5, 0x40, 0x97, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x84]; // MOS OFF
    } else if (protocol === "JK BMS") {
      cmd = turnOn
        ? [0xaa, 0x55, 0x90, 0xeb, 0x96, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11]
        : [0xaa, 0x55, 0x90, 0xeb, 0x96, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10];
    } else if (protocol === "ANT BMS") {
      cmd = turnOn
        ? [0x5a, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x5b] // All ON
        : [0x5a, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5a]; // All OFF
    } else {
      // Generic UART Fallback
      cmd = turnOn
        ? [0xaa, 0x5a, 0x90, 0x01, 0xff, 0xff, 0xff, 0xff]
        : [0xaa, 0x5a, 0x90, 0x00, 0xff, 0xff, 0xff, 0xff];
    }

    await writeCommand(cmd);
  };

  const handleDischargeToggle = async (turnOn: boolean) => {
    const protocol = protocolRef.current;
    
    // Some protocols use combined MOS switches (e.g. DALY, ANT)
    if (protocol === "DALY" || protocol === "ANT BMS") {
      await handleChargeToggle(turnOn);
      return;
    }

    showToast(`Sending Discharge ${turnOn ? "ON" : "OFF"} command...`, "info");
    
    let cmd: number[] = [];
    if (protocol === "JBD") {
      cmd = turnOn
        ? [0xdd, 0x5a, 0xe2, 0x02, 0x00, 0x01, 0xff, 0x1b, 0x77] // Discharge ON
        : [0xdd, 0x5a, 0xe2, 0x02, 0x00, 0x00, 0xff, 0x1c, 0x77]; // Discharge OFF
    } else {
      // Generic UART Fallback
      cmd = turnOn
        ? [0xaa, 0x5a, 0x90, 0x01, 0xff, 0xff, 0xff, 0xff]
        : [0xaa, 0x5a, 0x90, 0x00, 0xff, 0xff, 0xff, 0xff];
    }

    await writeCommand(cmd);
  };

  // SOC circle color selector
  const getSOCCircleColor = (soc: number): string => {
    if (soc > 60) return "#16a34a"; // Green
    if (soc >= 30) return "#eab308"; // Yellow
    return "#dc2626"; // Red
  };

  // =================================================================
  // VIEW STYLES & RENDERING
  // =================================================================

  const containerStyle: React.CSSProperties = {
    maxWidth: "480px",
    margin: "0 auto",
    minHeight: "100vh",
    padding: "20px 16px",
    backgroundColor: "#0f172a",
    color: "#ffffff",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    position: "relative",
  };

  const cardStyle: React.CSSProperties = {
    backgroundColor: "#1e293b",
    border: "1px solid #334155",
    borderRadius: "16px",
    padding: "24px",
    textAlign: "center",
    boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.3)",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    marginTop: "20px",
  };

  const buttonStyle: React.CSSProperties = {
    backgroundColor: "#3b82f6",
    color: "white",
    border: "none",
    borderRadius: "12px",
    padding: "16px 24px",
    fontSize: "16px",
    fontWeight: "bold",
    cursor: "pointer",
    transition: "background-color 0.2s ease, transform 0.1s ease",
    boxShadow: "0 4px 6px -1px rgba(59, 130, 246, 0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
  };

  const badgeStyle = (proto: string): React.CSSProperties => {
    let bg = "#64748b"; // gray
    if (proto === "JBD") bg = "#3b82f6"; // blue
    if (proto === "DALY") bg = "#8b5cf6"; // purple
    if (proto === "JK BMS") bg = "#ec4899"; // pink
    if (proto === "ANT BMS") bg = "#f59e0b"; // amber
    if (proto === "Generic") bg = "#10b981"; // emerald

    return {
      backgroundColor: bg,
      color: "white",
      padding: "6px 12px",
      borderRadius: "9999px",
      fontSize: "12px",
      fontWeight: "bold",
      alignSelf: "center",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
    };
  };

  const statValStyle = (charge: boolean = false, discharge: boolean = false): React.CSSProperties => ({
    fontSize: "18px",
    fontWeight: "bold",
    color: charge ? "#22c55e" : discharge ? "#ef4444" : "#ffffff",
  });

  return (
    <main style={containerStyle}>
      {/* Toast Alert */}
      {toast && (
        <div
          style={{
            position: "fixed",
            top: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            backgroundColor: toast.type === "error" ? "#dc2626" : toast.type === "success" ? "#16a34a" : "#3b82f6",
            color: "white",
            padding: "12px 24px",
            borderRadius: "8px",
            fontWeight: "500",
            boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.5)",
            textAlign: "center",
            maxWidth: "90%",
            fontSize: "14px",
            transition: "all 0.3s ease",
          }}
        >
          {toast.message}
        </div>
      )}

      {/* STEP 1: SCAN SCREEN */}
      {screen === "scan" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "80vh" }}>
          <div style={{ textAlign: "center", marginBottom: "40px" }}>
            <h1 style={{ fontSize: "36px", fontWeight: "800", marginBottom: "8px", color: "#3b82f6" }}>
              BMS Connect
            </h1>
            <p style={{ color: "#94a3b8", fontSize: "16px" }}>
              Apna electric vehicle select karo
            </p>
          </div>

          {!isBluetoothSupported ? (
            <div
              style={{
                backgroundColor: "#7f1d1d",
                border: "1px solid #dc2626",
                borderRadius: "16px",
                padding: "20px",
                textAlign: "left",
                lineHeight: "1.5",
              }}
            >
              <h2 style={{ fontSize: "18px", fontWeight: "bold", color: "#fca5a5", marginBottom: "8px" }}>
                Bluetooth Unsupported
              </h2>
              <p style={{ color: "#fecaca", fontSize: "14px" }}>
                Yeh browser Web Bluetooth support nahi karta. Android Chrome use karein.
              </p>
            </div>
          ) : (
            <button
              onClick={handleScanAndConnect}
              style={buttonStyle}
              onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
              onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
            >
              <svg style={{ width: "20px", height: "20px" }} viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 17h10v-2H7v2zm0-4h10v-2H7v2zm0-4h10V7H7v2zm-2 12c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2v14c0 1.1-.9 2-2 2H5zm0-2h14V5H5v14z" />
              </svg>
              Scan Vehicles
            </button>
          )}

          <div style={{ marginTop: "60px", textAlign: "center", color: "#64748b", fontSize: "12px" }}>
            Works with JBD, DALY, JK, ANT &amp; Generic UART Bluetooth BMS
          </div>
        </div>
      )}

      {/* STEP 2: CONNECTING SCREEN */}
      {screen === "connecting" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              border: "4px solid #334155",
              borderTopColor: "#3b82f6",
              borderRadius: "50%",
              animation: "spin 1s linear infinite",
              marginBottom: "24px",
            }}
          />
          <style>{`
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          `}</style>
          <h2 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "8px" }}>Connecting...</h2>
          <p style={{ color: "#94a3b8", fontSize: "14px", textAlign: "center", padding: "0 20px" }}>
            {connectingMsg}
          </p>
        </div>
      )}

      {/* STEP 3: PROTOCOL DETECTION SCREEN */}
      {screen === "detecting" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              border: "4px solid #334155",
              borderTopColor: "#a855f7",
              borderRadius: "50%",
              animation: "spin 1s linear infinite",
              marginBottom: "24px",
            }}
          />
          <h2 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "8px" }}>
            Detecting Battery Protocol...
          </h2>
          <p style={{ color: "#a855f7", fontSize: "14px", fontWeight: "600", marginBottom: "16px" }}>
            {connectedServiceUUID} Connected
          </p>
          <p style={{ color: "#94a3b8", fontSize: "14px", textAlign: "center" }}>
            {detectingStatus}
          </p>
        </div>
      )}

      {/* STEP 4: DASHBOARD SCREEN */}
      {screen === "dashboard" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          
          {/* Header Row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "10px" }}>
            <div>
              <h2 style={{ fontSize: "18px", fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "200px" }}>
                {deviceName}
              </h2>
              <p style={{ fontSize: "11px", color: "#64748b" }}>ID: {deviceId}</p>
            </div>
            <button
              onClick={handleDisconnect}
              style={{
                backgroundColor: "transparent",
                border: "1.5px solid #dc2626",
                color: "#ef4444",
                borderRadius: "8px",
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: "bold",
                cursor: "pointer",
              }}
            >
              Disconnect
            </button>
          </div>

          {/* Protocol Badge */}
          <div style={{ display: "flex", justifyContent: "center" }}>
            <span style={badgeStyle(detectedProtocol)}>
              {detectedProtocol} PROTOCOL
            </span>
          </div>

          {/* Big SOC Circle Display */}
          <div style={{ display: "flex", justifyContent: "center", margin: "20px 0" }}>
            <div style={{ position: "relative", width: "160px", height: "160px" }}>
              <svg width="160" height="160" viewBox="0 0 160 160">
                <circle cx="80" cy="80" r="70" fill="none" stroke="#1e293b" strokeWidth="10" />
                <circle
                  cx="80"
                  cy="80"
                  r="70"
                  fill="none"
                  stroke={getSOCCircleColor(stats.soc)}
                  strokeWidth="10"
                  strokeDasharray={`${2 * Math.PI * 70}`}
                  strokeDashoffset={`${2 * Math.PI * 70 * (1 - Math.min(Math.max(stats.soc, 0), 100) / 100)}`}
                  strokeLinecap="round"
                  transform="rotate(-90 80 80)"
                  style={{ transition: "stroke-dashoffset 0.8s ease" }}
                />
              </svg>
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: "36px", fontWeight: "900", color: "#ffffff" }}>
                  {Math.round(stats.soc)}%
                </span>
                <span style={{ fontSize: "12px", color: "#94a3b8", fontWeight: "bold" }}>SOC</span>
              </div>
            </div>
          </div>

          {/* Stats Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "12px",
            }}
          >
            {/* Voltage */}
            <div style={{ ...cardStyle, marginTop: 0, padding: "16px" }}>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>Voltage</span>
              <span style={statValStyle()}>{stats.voltage.toFixed(2)} V</span>
            </div>
            
            {/* Current */}
            <div style={{ ...cardStyle, marginTop: 0, padding: "16px" }}>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>Current</span>
              <span style={statValStyle(stats.current > 0.1, stats.current < -0.1)}>
                {stats.current > 0 ? "+" : ""}
                {stats.current.toFixed(1)} A
              </span>
            </div>

            {/* Power */}
            <div style={{ ...cardStyle, marginTop: 0, padding: "16px" }}>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>Power</span>
              <span style={statValStyle(stats.current > 0.1, stats.current < -0.1)}>
                {stats.power.toFixed(0)} W
              </span>
            </div>

            {/* Remaining Ah */}
            <div style={{ ...cardStyle, marginTop: 0, padding: "16px" }}>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>Capacity / Remaining</span>
              <span style={statValStyle()}>
                {stats.remainingAh.toFixed(1)} Ah
              </span>
            </div>

            {/* Temp Cell */}
            <div style={{ ...cardStyle, marginTop: 0, padding: "16px" }}>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>Cell Temp</span>
              <span style={statValStyle()}>{stats.cellTemp.toFixed(1)} °C</span>
            </div>

            {/* Temp BMS */}
            <div style={{ ...cardStyle, marginTop: 0, padding: "16px" }}>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>BMS Temp</span>
              <span style={statValStyle()}>{stats.bmsTemp.toFixed(1)} °C</span>
            </div>

            {/* Cycles */}
            <div style={{ ...cardStyle, marginTop: 0, padding: "16px" }}>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>Cycles</span>
              <span style={statValStyle()}>{stats.cycles}</span>
            </div>

            {/* Cell Count */}
            <div style={{ ...cardStyle, marginTop: 0, padding: "16px" }}>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>Cell Count</span>
              <span style={statValStyle()}>{stats.cellCount} S</span>
            </div>
          </div>

          {/* Cell Voltages List */}
          {stats.cells.length > 0 && (
            <div style={{ ...cardStyle, marginTop: 0, textAlign: "left" }}>
              <h3 style={{ fontSize: "14px", fontWeight: "bold", marginBottom: "12px", color: "#94a3b8" }}>
                Cell Voltages
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {stats.cells.map((volt, index) => {
                  const idx = index + 1;
                  const isMin = stats.minCell?.idx === idx;
                  const isMax = stats.maxCell?.idx === idx;

                  // percentage relative to typical max cell (4.2V) and min (2.5V)
                  const percentage = Math.min(Math.max(((volt - 2.5) / 1.7) * 100, 5), 100);

                  return (
                    <div key={index} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontSize: "12px", color: "#64748b", width: "45px" }}>
                        Cell {idx.toString().padStart(2, "0")}
                      </span>
                      <div style={{ flex: 1, backgroundColor: "#334155", height: "16px", borderRadius: "4px", overflow: "hidden", position: "relative" }}>
                        <div
                          style={{
                            width: `${percentage}%`,
                            backgroundColor: isMin ? "#dc2626" : isMax ? "#16a34a" : "#3b82f6",
                            height: "100%",
                            borderRadius: "4px",
                            transition: "width 0.4s ease",
                          }}
                        />
                      </div>
                      <span
                        style={{
                          fontSize: "12px",
                          fontWeight: "bold",
                          color: isMin ? "#ef4444" : isMax ? "#22c55e" : "#ffffff",
                          width: "55px",
                          textAlign: "right",
                        }}
                      >
                        {volt.toFixed(3)}V
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Controls Panel */}
          <div style={{ ...cardStyle, marginTop: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
            <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#94a3b8", textAlign: "left", marginBottom: "4px" }}>
              BMS Control Switches
            </h3>
            
            {/* Charge Controls */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <button
                onClick={() => handleChargeToggle(true)}
                style={{ ...buttonStyle, backgroundColor: "#16a34a", padding: "12px", fontSize: "14px" }}
              >
                Charge ON
              </button>
              <button
                onClick={() => handleChargeToggle(false)}
                style={{ ...buttonStyle, backgroundColor: "#dc2626", padding: "12px", fontSize: "14px" }}
              >
                Charge OFF
              </button>
            </div>

            {/* Discharge Controls (Only for JBD / Generic UART fallbacks) */}
            {(detectedProtocol === "JBD" || detectedProtocol === "Generic" || detectedProtocol === "Unknown") && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <button
                  onClick={() => handleDischargeToggle(true)}
                  style={{ ...buttonStyle, backgroundColor: "#15803d", padding: "12px", fontSize: "14px" }}
                >
                  Discharge ON
                </button>
                <button
                  onClick={() => handleDischargeToggle(false)}
                  style={{ ...buttonStyle, backgroundColor: "#b91c1c", padding: "12px", fontSize: "14px" }}
                >
                  Discharge OFF
                </button>
              </div>
            )}
          </div>

          {/* Raw Debug Packets (Collapsible) */}
          <div style={{ ...cardStyle, marginTop: 0, padding: "16px", textAlign: "left" }}>
            <button
              onClick={() => setIsDebugOpen(!isDebugOpen)}
              style={{
                background: "transparent",
                border: "none",
                color: "#94a3b8",
                width: "100%",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontWeight: "bold",
                fontSize: "14px",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <span>Raw Hex Data (Debug)</span>
              <span>{isDebugOpen ? "▲" : "▼"}</span>
            </button>

            {isDebugOpen && (
              <div
                style={{
                  marginTop: "12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  maxHeight: "150px",
                  overflowY: "auto",
                  backgroundColor: "#0b0f19",
                  padding: "10px",
                  borderRadius: "8px",
                  fontFamily: "monospace",
                  fontSize: "11px",
                }}
              >
                {rawPackets.length === 0 ? (
                  <div style={{ color: "#475569" }}>No packets received yet...</div>
                ) : (
                  rawPackets.map((pkt, idx) => (
                    <div key={idx} style={{ borderBottom: "1px solid #1e293b", paddingBottom: "4px" }}>
                      <span style={{ color: "#a855f7" }}>[{pkt.timestamp}]</span>{" "}
                      <span style={{ color: "#38bdf8", wordBreak: "break-all" }}>{pkt.hex}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

        </div>
      )}
    </main>
  );
}
