import { Sentinel, WrapperExit, type RunPlan } from '@devlaunch/shared';

export const WRAPPER_FILENAME = 'run.sh';

/**
 * The container entrypoint script.
 *
 * Two properties matter here:
 *
 * 1. **Commands arrive through environment variables, never interpolated into the
 *    script body.** The script is byte-identical on every run, so a repository cannot
 *    break out of its intended structure by crafting a command string.
 *
 * 2. **The start command is `exec`d**, so signals reach the application directly and
 *    `docker stop` shuts it down cleanly. That means the container's exit code belongs
 *    to the app, not to this script — which is exactly why the phase sentinels exist.
 *    Exit code alone cannot tell you *which* phase failed; sentinel + code together can.
 *
 * Shell metacharacters inside `$DL_*` are intentionally allowed: real dev scripts chain
 * commands (`tsc && vite build`). The allowlist guards what DevLaunch composes; the
 * container guards what the repository does. See docs/planning-strategy.md.
 */
/**
 * Reach an app that listens on loopback only.
 *
 * Docker forwards a published port to the container's own address, and an app bound to
 * 127.0.0.1 or ::1 is not there: `localhost:3000` from the browser reached nothing. Flags
 * fix that when DevLaunch can pass them, but not always — a `concurrently` script hands
 * them to the runner, never to Vite (`Avinava/simple-vite-react-express`), and some
 * servers hardcode `localhost`.
 *
 * This waits for something to listen on the app's port. If it is reachable already (any
 * address but loopback) it does nothing and exits. If it is loopback only, it opens the
 * same port on the container's own addresses and passes each connection through. It
 * never binds first, so it cannot take the port from the app; it forwards only to the
 * app's own port, inside its own container — what DevLaunch publishes anyway.
 *
 * No single quotes: the wrapper passes it to `node -e` inside them.
 */
export const LOOPBACK_BRIDGE = [
  'const fs=require("fs"),net=require("net"),os=require("os");',
  'const port=Number(process.env.DL_BRIDGE_PORT);',
  'const hex=port.toString(16).toUpperCase().padStart(4,"0");',
  'const LOOP4=new Set(["0100007F","0000000000000000FFFF00000100007F"]);',
  'const LOOP6="00000000000000000000000001000000";',
  'function seen(){const r={l4:false,l6:false,out:false};',
  ' for(const f of ["/proc/net/tcp","/proc/net/tcp6"]){let t="";try{t=fs.readFileSync(f,"utf8")}catch(e){continue}',
  '  for(const line of t.split("\\n").slice(1)){const c=line.trim().split(/\\s+/);if(c.length<4||c[3]!=="0A")continue;',
  '   const [a,p]=c[1].split(":");if(p!==hex)continue;',
  '   if(LOOP4.has(a))r.l4=true;else if(a===LOOP6)r.l6=true;else r.out=true;}}',
  ' return r;}',
  'function bridge(target){const addrs=[];',
  ' for(const list of Object.values(os.networkInterfaces()))for(const i of list||[])if(!i.internal&&i.family==="IPv4")addrs.push(i.address);',
  ' for(const a of addrs){net.createServer((c)=>{const u=net.connect(port,target);c.pipe(u);u.pipe(c);',
  '  const end=()=>{c.destroy();u.destroy()};c.on("error",end);u.on("error",end);c.on("close",end);u.on("close",end);})',
  '  .on("error",()=>{}).listen(port,a);}',
  ' console.log("[devlaunch] Port "+port+" is listening on loopback only, which Docker cannot reach; forwarding "+addrs.join(", ")+":"+port+" to it.");}',
  'const timer=setInterval(()=>{const r=seen();if(r.out){clearInterval(timer);return}',
  ' if(r.l4||r.l6){clearInterval(timer);bridge(r.l4?"127.0.0.1":"::1")}},500);',
].join('');

export function buildWrapperScript(): string {
  return [
    '#!/bin/sh',
    '# DevLaunch container wrapper. Generated from shared sentinel constants.',
    '# Do not edit inside the container; regenerate from wrapper.ts.',
    'set -u',
    '',
    'if ! cd "$DL_WORKDIR" 2>/dev/null; then',
    `  printf '%s\\n' "${Sentinel.FATAL}"`,
    `  printf 'workdir not found: %s\\n' "$DL_WORKDIR"`,
    `  exit ${WrapperExit.WORKDIR_MISSING}`,
    'fi',
    '',
    // The image points TMPDIR at the volume, but the volume shadows the image path it
    // mounts over, so the directory has to be made here rather than assumed to exist.
    'if [ -n "${TMPDIR:-}" ]; then mkdir -p "$TMPDIR" 2>/dev/null || true; fi',
    '',
    'if [ -n "$DL_INSTALL_CMD" ]; then',
    `  printf '%s\\n' "${Sentinel.INSTALL_BEGIN}"`,
    // A workspace installs once at its root, not once per package: its packages depend
    // on each other through `workspace:*`, which no package manager can resolve for a
    // single package in isolation. So the install may run somewhere other than the
    // directory the service starts from. A subshell keeps that move local — the build
    // and start steps must still run in DL_WORKDIR.
    // Reused: the workspace volume already holds what this exact install command
    // produced, finished, in an earlier container of the same session. ExecutionManager
    // decides that, never a plan — DL_ is a control prefix no plan may set.
    '  if [ "${DL_INSTALL_REUSED:-0}" = "1" ]; then',
    "    printf '%s\\n' '[devlaunch] The packages are already installed: an earlier attempt in this session ran the same install command to completion. Not installing again.'",
    `    printf '%s\\n' "${Sentinel.INSTALL_OK}"`,
    '  elif (cd "$DL_INSTALL_DIR" && sh -c "$DL_INSTALL_CMD"); then',
    `    printf '%s\\n' "${Sentinel.INSTALL_OK}"`,
    '  else',
    `    printf '%s\\n' "${Sentinel.INSTALL_FAIL}"`,
    `    exit ${WrapperExit.INSTALL_FAILED}`,
    '  fi',
    'fi',
    '',
    'if [ -n "$DL_BUILD_CMD" ]; then',
    `  printf '%s\\n' "${Sentinel.BUILD_BEGIN}"`,
    '  if sh -c "$DL_BUILD_CMD"; then',
    `    printf '%s\\n' "${Sentinel.BUILD_OK}"`,
    '  else',
    `    printf '%s\\n' "${Sentinel.BUILD_FAIL}"`,
    `    exit ${WrapperExit.BUILD_FAILED}`,
    '  fi',
    'fi',
    '',
    // The loopback bridge (`LOOPBACK_BRIDGE`), for a Node app: started beside it, and doing
    // nothing unless the app ends up listening on loopback only.
    'if [ -n "${DL_BRIDGE_PORT:-}" ] && command -v node >/dev/null 2>&1; then',
    `  node -e '${LOOPBACK_BRIDGE}' &`,
    'fi',
    '',
    `printf '%s\\n' "${Sentinel.START_BEGIN}"`,
    'exec sh -c "$DL_START_CMD"',
    '',
  ].join('\n');
}

/**
 * Environment handed to the wrapper. `set -u` in the script means every DL_* variable
 * must be defined, so absent commands are passed as empty strings rather than omitted.
 */
export function buildWrapperEnv(
  plan: RunPlan,
  workdir: string,
  installDir?: string,
  control: { nodeHeapMb?: number; installReused?: boolean; legacyOpenssl?: boolean } = {},
): string[] {
  const env: Record<string, string> = {};

  // Application variables first.
  for (const v of plan.environmentVariables) {
    if (v.value !== null && v.value !== undefined) env[v.key] = v.value;
  }

  if (plan.expectedPort !== null) {
    // Express and similar read PORT; harmless for frameworks that ignore it.
    env.PORT ??= String(plan.expectedPort);
    env.HOST ??= '0.0.0.0';
  }

  // Control variables LAST, and unconditionally.
  //
  // Assignment order is the security boundary here: the wrapper takes its commands
  // from these names, so a plan variable called DL_START_CMD would otherwise replace
  // an allowlisted command with arbitrary text. ExecutionManager also rejects the
  // DL_ prefix outright — this ordering is the second layer, so a future caller that
  // skips validation still cannot be exploited.
  env.DL_WORKDIR = workdir;
  // Defaults to the working directory, so a single-service plan behaves exactly as it
  // did before this existed.
  env.DL_INSTALL_DIR = installDir ?? workdir;
  env.DL_INSTALL_CMD = plan.installCommand ?? '';
  env.DL_BUILD_CMD = plan.buildCommand ?? '';
  env.DL_START_CMD = plan.startCommand;
  // The port the loopback bridge watches: a Node app's, when it has one. Empty otherwise,
  // and set here so a plan can never choose it.
  env.DL_BRIDGE_PORT = plan.runtime.language === 'node' && plan.expectedPort !== null ? String(plan.expectedPort) : '';
  // Set either way, so nothing else can supply it.
  env.DL_INSTALL_REUSED = control.installReused === true ? '1' : '0';

  // A larger V8 heap, after a heap OOM, set by DevLaunch and never by a plan: the validator
  // refuses NODE_OPTIONS from every plan, because `--require` in it runs code before the
  // start command. This composes one flag from one integer, and is assigned here, with
  // the other control variables, so nothing a plan carries can replace it.
  //
  // And OpenSSL's legacy algorithms, for webpack 4 (`RunPlan.legacyOpenssl`): one fixed flag,
  // composed here the same way — a plan says yes or no, never what goes in.
  const nodeOptions: string[] = [];
  if (control.nodeHeapMb !== undefined && Number.isInteger(control.nodeHeapMb) && control.nodeHeapMb > 0) {
    nodeOptions.push(`--max-old-space-size=${control.nodeHeapMb}`);
  }
  if (control.legacyOpenssl === true) nodeOptions.push('--openssl-legacy-provider');
  if (nodeOptions.length > 0) env.NODE_OPTIONS = nodeOptions.join(' ');

  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}
