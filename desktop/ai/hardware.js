'use strict';
// Reads what the computer has, and says which engine build fits it.
const nodeOs = require('node:os');

const VENDORS = { 0x10de: 'nvidia', 0x1002: 'amd', 0x1022: 'amd', 0x8086: 'intel', 0x106b: 'apple' };

async function defaultGpuInfo() {
  try { return await require('electron').app.getGPUInfo('basic'); } catch (e) { return null; }
}

function parseGpu(info) {
  const list = info && Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  if (!list.length) return { present: false, vendor: 'unknown', name: '' };
  // prefer a card that is in use, and a discrete vendor over Intel integrated graphics
  const rank = d => (d.active ? 2 : 0) + (VENDORS[d.vendorId] === 'nvidia' || VENDORS[d.vendorId] === 'amd' ? 1 : 0);
  const d = list.slice().sort((a, b) => rank(b) - rank(a))[0];
  return { present: true, vendor: VENDORS[d.vendorId] || 'unknown', name: String(d.deviceString || d.driverVendor || '') };
}

async function readHardware(deps = {}) {
  const os = deps.os || nodeOs;
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  let gpu;
  try { gpu = parseGpu(await (deps.getGpuInfo || defaultGpuInfo)()); } catch (e) { gpu = { present: false, vendor: 'unknown', name: '' }; }
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  if (appleSilicon) gpu = { present: true, vendor: 'apple', name: 'Apple GPU' };
  return { platform, arch, totalRamBytes: os.totalmem(), freeRamBytes: os.freemem(), cores: Math.max(1, os.cpus().length), gpu, appleSilicon };
}

// Local AI exists only for Windows (x64) and Mac.
function engineAssetFor(hw) {
  if (hw.platform === 'win32') return hw.arch === 'x64' ? (hw.gpu && hw.gpu.present ? 'win-x64-vulkan' : 'win-x64-cpu') : null;
  if (hw.platform === 'darwin') return hw.appleSilicon || hw.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return null;
}

module.exports = { readHardware, engineAssetFor, parseGpu };
