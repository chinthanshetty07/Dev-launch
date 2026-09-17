// Reports what the kernel actually enforces, rather than what Docker was asked for.
// A security control that is configured but not in effect must fail the test.
const fs = require('node:fs');
const os = require('node:os');

function emit(key, value) {
  console.log(`PROBE ${key}=${value}`);
}

emit('uid', process.getuid());
emit('gid', process.getgid());

// CapEff is the effective capability bitmask: 0 means every capability was dropped.
const status = fs.readFileSync('/proc/self/status', 'utf8');
emit('capeff', (status.match(/^CapEff:\s*(\S+)/m) || [, 'unknown'])[1]);

// The read-only rootfs must actually refuse writes.
try {
  fs.writeFileSync('/probe-root', 'x');
  emit('rootfs_writable', 'true');
} catch {
  emit('rootfs_writable', 'false');
}

// The workspace must remain writable, or nothing can be installed.
try {
  fs.writeFileSync('/workspace/.probe', 'x');
  fs.unlinkSync('/workspace/.probe');
  emit('workspace_writable', 'true');
} catch {
  emit('workspace_writable', 'false');
}

emit('docker_socket', fs.existsSync('/var/run/docker.sock') ? 'present' : 'absent');

// Memory ceiling as the cgroup reports it, which is what the kernel will enforce.
let memLimit = 'unknown';
for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
  try { memLimit = fs.readFileSync(p, 'utf8').trim(); break; } catch { /* next */ }
}
emit('memory_max', memLimit);

let pidsMax = 'unknown';
for (const p of ['/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max']) {
  try { pidsMax = fs.readFileSync(p, 'utf8').trim(); break; } catch { /* next */ }
}
emit('pids_max', pidsMax);

emit('total_mem_reported', os.totalmem());
emit('done', 'true');

// --- egress policy -----------------------------------------------------------
// Distinguishing "blocked" from "nothing there" needs a target that would otherwise
// answer. The container's own default gateway is reachable and has no listener on
// port 9, so without a policy it refuses immediately; with a DROP rule it times out.
const net = require('node:net');

function defaultGateway() {
  const routes = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
  for (const line of routes) {
    const f = line.trim().split(/\s+/);
    if (f.length > 2 && f[1] === '00000000') {
      const hex = f[2];
      return [6, 4, 2, 0].map((i) => parseInt(hex.substr(i, 2), 16)).join('.');
    }
  }
  return null;
}

const gw = defaultGateway();
emit('gateway', gw || 'unknown');

if (!gw) {
  emit('egress_private', 'unknown');
  process.exit(0);
}

const sock = new net.Socket();
let settled = false;
const finish = (verdict) => {
  if (settled) return;
  settled = true;
  emit('egress_private', verdict);
  sock.destroy();
  process.exit(0);
};

sock.setTimeout(3000);
sock.once('connect', () => finish('connected'));
sock.once('timeout', () => finish('blocked'));
sock.once('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'refused' : `error:${e.code}`));
sock.connect(9, gw);
