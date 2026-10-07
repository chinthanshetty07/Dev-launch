import { describe, it, expect } from 'vitest';
import { RunNetworks, pickRunSubnet, runNetworkName } from '../services/execution/RunNetworks.js';
import { config } from '../config/index.js';
import { networkGateway } from '../services/docker/DockerManager.js';

/**
 * A network of its own for every run (verifier D-8): with two runs at once, neither can
 * reach the other's databases or services by name — and neither leaves the egress rules,
 * which is checked on this VM before any run is given a network of its own.
 */

function fakeDocker(opts: { guarded?: boolean | null; failCreate?: string[]; sharedExists?: boolean } = {}) {
  const networks = new Map<string, { subnet: string; labels: Record<string, string> }>();
  if (opts.sharedExists !== false) networks.set(config.docker.networkName, { subnet: '172.31.250.0/24', labels: {} });
  const failures = [...(opts.failCreate ?? [])];
  const calls: string[] = [];
  const containers: { Labels: Record<string, string> }[] = [];
  const docker = {
    networks,
    calls,
    containers,
    listManaged: async () => containers,
    networkExists: async (name: string) => networks.has(name),
    usedSubnets: async () => new Set([...networks.values()].map((n) => n.subnet)),
    createRunNetwork: async (name: string, subnet: string, labels: Record<string, string>) => {
      calls.push(`create:${name}:${subnet}`);
      const failure = failures.shift();
      if (failure) throw new Error(failure);
      // Docker refuses an overlapping subnet; so does this.
      if ([...networks.values()].some((n) => n.subnet === subnet)) throw new Error('Pool overlaps with other one on this address space');
      networks.set(name, { subnet, labels });
    },
    removeNetwork: async (name: string) => {
      calls.push(`remove:${name}`);
      networks.delete(name);
    },
    vmGuardedFrom: async () => (opts.guarded === undefined ? true : opts.guarded),
    listRunNetworks: async () => [],
  };
  return docker;
}

describe('naming a run\'s network', () => {
  it('gives two runs whose ids start alike two different names', () => {
    // Seen on CI: `corpus-node-…` ids shared their first 12 characters, so the second run's
    // network "already existed" and it fell back to the shared one.
    expect(runNetworkName('corpus-node-aaa')).not.toBe(runNetworkName('corpus-node-bbb'));
    expect(runNetworkName('same-id')).toBe(runNetworkName('same-id'));
    expect(runNetworkName('x'.repeat(200)).length).toBeLessThanOrEqual(64);
    expect(runNetworkName('Weird/ID:1')).toMatch(/^[a-z0-9_.-]+$/);
  });
});

describe('picking a subnet', () => {
  it('takes the first /24 of the pool that nothing uses', () => {
    expect(pickRunSubnet('172.31.0.0/16', new Set())).toBe('172.31.1.0/24');
    expect(pickRunSubnet('172.31.0.0/16', new Set(['172.31.1.0/24', '172.31.2.0/24']))).toBe('172.31.3.0/24');
  });
  it('says so when the pool is full, or is not one it can carve', () => {
    const all = new Set(Array.from({ length: 254 }, (_, i) => `172.31.${i + 1}.0/24`));
    expect(pickRunSubnet('172.31.0.0/16', all)).toBeNull();
    expect(pickRunSubnet('10.0.0.0/8', new Set())).toBeNull();
  });
});

describe('a network of its own for every run', () => {
  it('gives two runs two networks, on two subnets, labelled as theirs', async () => {
    const docker = fakeDocker();
    const nets = new RunNetworks(docker as never, () => undefined);
    const [a, b] = await Promise.all([nets.forSession('aaaaaaaaaaaa-1'), nets.forSession('bbbbbbbbbbbb-2')]);
    expect(a).toBe(runNetworkName('aaaaaaaaaaaa-1'));
    expect(b).toBe(runNetworkName('bbbbbbbbbbbb-2'));
    expect(a).not.toBe(config.docker.networkName);
    expect(docker.networks.get(a!)!.subnet).not.toBe(docker.networks.get(b!)!.subnet);
    expect(docker.networks.get(a!)!.labels).toMatchObject({
      [config.docker.sessionLabel]: 'aaaaaaaaaaaa-1',
      [config.docker.instanceLabel]: config.docker.instanceId,
    });
  });

  it('gives one run the same network every time it asks', async () => {
    const docker = fakeDocker();
    const nets = new RunNetworks(docker as never, () => undefined);
    const first = await nets.forSession('s-1');
    expect(await nets.forSession('s-1')).toBe(first);
    expect(docker.calls.filter((c) => c.startsWith(`create:${first}`))).toHaveLength(1);
  });

  it('takes the next subnet when another process took this one first', async () => {
    const docker = fakeDocker({ failCreate: [] });
    const nets = new RunNetworks(docker as never, () => undefined);
    await nets.forSession('warm-up'); // the check's probe network, made and removed
    const taken = docker.usedSubnets;
    let once = true;
    docker.usedSubnets = async () => {
      // A look that misses a network another process is creating at this moment.
      if (once) { once = false; const s = await taken(); docker.networks.set('someone-else', { subnet: '172.31.2.0/24', labels: {} }); return s; }
      return taken();
    };
    const name = await nets.forSession('s-2');
    expect(name).toBe(runNetworkName('s-2'));
    expect(docker.networks.get(name!)!.subnet).toBe('172.31.3.0/24');
  });

  it('removes a run\'s network when it ends', async () => {
    const docker = fakeDocker();
    const nets = new RunNetworks(docker as never, () => undefined);
    const name = await nets.forSession('s-1');
    await nets.release('s-1');
    expect(docker.networks.has(name!)).toBe(false);
  });

  it('keeps a run\'s network while one of its containers still exists, so a start racing a stop never loses it', async () => {
    // Seen in the suite: a stop removed the network between a database's create and its
    // start (Docker removes a network a created-but-not-started container is on).
    const docker = fakeDocker();
    const nets = new RunNetworks(docker as never, () => undefined);
    const name = await nets.forSession('s-1');
    docker.containers.push({ Labels: { [config.docker.sessionLabel]: 's-1' } });
    await nets.release('s-1');
    expect(docker.networks.has(name!)).toBe(true);
    docker.containers.length = 0;
    await nets.release('s-1');
    expect(docker.networks.has(name!)).toBe(false);
  });

  it('gives nothing when there is no protected network at all, as before', async () => {
    const nets = new RunNetworks(fakeDocker({ sharedExists: false }) as never, () => undefined);
    expect(await nets.forSession('s-1')).toBeUndefined();
  });
});

describe('never a network outside the egress rules', () => {
  it('shares the protected network, saying why, when a pool network is not under the rules', async () => {
    const warnings: string[] = [];
    const docker = fakeDocker({ guarded: false });
    const nets = new RunNetworks(docker as never, (m) => warnings.push(m));
    expect(await nets.forSession('s-1')).toBe(config.docker.networkName);
    expect(warnings.join('\n')).toMatch(/not under DevLaunch's network rules.*\.\/devlaunch install/);
    // The probe network is never left behind.
    expect([...docker.networks.keys()]).toEqual([config.docker.networkName]);
  });

  it('treats a check that could not run as not under the rules, says it could not check, and tries again soon', async () => {
    let now = 0;
    const warnings: string[] = [];
    const docker = fakeDocker({ guarded: null });
    const nets = new RunNetworks(docker as never, (m) => warnings.push(m), () => now);
    expect(await nets.forSession('s-1')).toBe(config.docker.networkName);
    // Not the "rules missing" message: a check that did not run says nothing about them.
    expect(warnings.join('\n')).toMatch(/Could not check .*said nothing/);
    expect(warnings.join('\n')).not.toMatch(/are not under/);
    docker.vmGuardedFrom = async () => true;
    now = 31_000;
    expect(await nets.forSession('s-2')).toBe(runNetworkName('s-2'));
  });

  it('checks again later, so ./devlaunch install takes effect without a restart', async () => {
    let now = 0;
    const docker = fakeDocker({ guarded: false });
    const nets = new RunNetworks(docker as never, () => undefined, () => now);
    expect(await nets.forSession('s-1')).toBe(config.docker.networkName);
    docker.vmGuardedFrom = async () => true;
    now = 60_000;
    expect(await nets.forSession('s-2')).toBe(config.docker.networkName);
    now = 6 * 60_000;
    expect(await nets.forSession('s-3')).toBe(runNetworkName('s-3'));
  });

  it('shares the protected network, saying why, when its own cannot be made', async () => {
    const warnings: string[] = [];
    const docker = fakeDocker();
    const nets = new RunNetworks(docker as never, (m) => warnings.push(m));
    await nets.forSession('warm-up');
    docker.createRunNetwork = async () => { throw new Error('daemon said no'); };
    expect(await nets.forSession('s-1')).toBe(config.docker.networkName);
    expect(warnings.join('\n')).toMatch(/daemon said no/);
  });
});

describe('the gateway the rules check is made against', () => {
  // Seen on CI (Docker 28, Linux): the check "said nothing" and every run fell back to the
  // shared network. A network created with only a subnet need not report its gateway.
  it('uses the gateway Docker reports, or else the subnet\'s first address, where Docker puts it', () => {
    expect(networkGateway([{ Subnet: '172.31.4.0/24', Gateway: '172.31.4.1' }])).toBe('172.31.4.1');
    expect(networkGateway([{ Subnet: '172.31.4.0/24' }])).toBe('172.31.4.1');
  });
  it('ignores an IPv6 entry, and says when there is nothing to check against', () => {
    expect(networkGateway([{ Subnet: 'fd00::/64', Gateway: 'fd00::1' }, { Subnet: '172.31.9.0/24' }])).toBe('172.31.9.1');
    expect(networkGateway([])).toBeNull();
  });
});
