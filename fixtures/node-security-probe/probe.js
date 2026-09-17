// Reports what the kernel actually enforces, rather than what Docker was asked for.
// A security control that is configured but not in effect must fail the test.
const fs = require('node:fs');
const os = require('node:os');

function emit(key, value) {
  console.log(`PROBE ${key}=${value}`);
}

emit('uid', process.getuid());
emit('gid', process.getgid());

const status = fs.readFileSync('/proc/self/status', 'utf8');

// CapEff is the *effective* set. For a non-root process it is zero regardless of
// --cap-drop, so asserting it alone proves only that we are not root.
emit('capeff', (status.match(/^CapEff:\s*(\S+)/m) || [, 'unknown'])[1]);

// CapBnd is the *bounding* set: the ceiling on what this process could ever acquire,
// including via a setuid binary. This is the value --cap-drop ALL actually zeroes, so
// it is the one that proves capabilities were dropped rather than merely unused.
emit('capbnd', (status.match(/^CapBnd:\s*(\S+)/m) || [, 'unknown'])[1]);

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

// no-new-privileges, as the kernel records it. Asserting the Docker flag instead would
// only prove what was requested.
emit('no_new_privs', (status.match(/^NoNewPrivs:\s*(\d+)/m) || [, 'unknown'])[1]);

// /tmp must be mounted noexec,nosuid, so it cannot be used to stage a payload.
let tmpOpts = 'unknown';
try {
  const mount = fs
    .readFileSync('/proc/mounts', 'utf8')
    .split('\n')
    .find((l) => l.split(' ')[1] === '/tmp');
  if (mount) tmpOpts = mount.split(' ')[3];
} catch { /* fall through as unknown */ }
emit('tmp_mount_opts', tmpOpts);

// And prove it, rather than trusting the mount flags: staging an executable and running
// it must be refused.
try {
  fs.writeFileSync('/tmp/probe-exec', '#!/bin/sh\necho ran\n', { mode: 0o755 });
  require('node:child_process').execFileSync('/tmp/probe-exec');
  emit('tmp_exec', 'allowed');
} catch {
  emit('tmp_exec', 'refused');
}

// CPU quota as the cgroup reports it: "<quota> <period>", so 200000 100000 is 2 cores.
let cpuMax = 'unknown';
for (const p of ['/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/cpu/cpu.cfs_quota_us']) {
  try { cpuMax = fs.readFileSync(p, 'utf8').trim(); break; } catch { /* next */ }
}
emit('cpu_max', cpuMax);

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
