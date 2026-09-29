import { describe, it, expect } from 'vitest';
import { probeEgress, verdictFrom } from '../services/security/EgressProbe.js';

/**
 * `docs/limitations.md` warned the iptables rules "do not survive recreating that VM".
 * They do not survive *restarting* it either, which is far more common. After one
 * `colima stop && colima start` the network still existed and `iptables -S DOCKER-USER`
 * returned `-N DOCKER-USER` and nothing else. Every run in between used weaker isolation
 * than documented, and nothing said so. The silence was the defect.
 */
describe('deciding whether the egress policy is in force', () => {
  it('calls it absent when a container reached the metadata address', () => {
    // The whole point of the probe. 169.254.169.254 is link-local, routed nowhere on a
    // laptop, and the single most valuable address for an untrusted container to reach.
    const r = verdictFrom({ networkPresent: true, reachedMetadata: true });
    expect(r.verdict).toBe('absent');
    expect(r.detail).toMatch(/169\.254\.169\.254/);
    expect(r.detail, 'must say how to fix it').toMatch(/setup-network-policy\.sh/);
  });

  it('calls it enforced when the container could not', () => {
    expect(verdictFrom({ networkPresent: true, reachedMetadata: false }).verdict).toBe('enforced');
  });

  it('calls it absent when the network itself is missing', () => {
    // Without the network, containers fall back to the default bridge and there is no
    // policy at all — a worse state than a network with empty rules, and it must not be
    // reported as merely unknown.
    const r = verdictFrom({ networkPresent: false, reachedMetadata: null });
    expect(r.verdict).toBe('absent');
    expect(r.detail).toMatch(/default bridge/);
  });

  it('says unknown when it could not find out, rather than guessing either way', () => {
    // Docker busy, image absent, probe container refused. Reporting `enforced` would be
    // a false all-clear; reporting `absent` would cry wolf and get the warning ignored.
    const r = verdictFrom({ networkPresent: true, reachedMetadata: null });
    expect(r.verdict).toBe('unknown');
  });
});

/**
 * The verdict function is the easy half. These cover the part that decides what to feed
 * it — where a probe that never ran was being read as a clean bill of health.
 */
describe('running the probe', () => {
  const fake = (over: Record<string, unknown>) =>
    ({ networkExists: async () => true, canReachFromNetwork: async () => false, ...over }) as never;

  it('says enforced only when the container actually said so', async () => {
    expect((await probeEgress(fake({}), 'img')).verdict).toBe('enforced');
  });

  it('says absent when the container reached the metadata address', async () => {
    expect((await probeEgress(fake({ canReachFromNetwork: async () => true }), 'img')).verdict)
      .toBe('absent');
  });

  it('says unknown — never enforced — when the probe produced no verdict', async () => {
    // The dangerous case. A missing binary, a failed network attach, an unreadable log:
    // all produce silence, and silence was being read as "blocked", which is a false
    // all-clear from the check whose entire job is catching a false sense of safety.
    expect((await probeEgress(fake({ canReachFromNetwork: async () => null }), 'img')).verdict)
      .toBe('unknown');
  });

  it('says unknown when the probe threw', async () => {
    const thrower = fake({ canReachFromNetwork: async () => { throw new Error('no image'); } });
    expect((await probeEgress(thrower, 'img')).verdict).toBe('unknown');
  });

  it('says absent when the hardened network is not there at all', async () => {
    const noNetwork = fake({ networkExists: async () => false });
    const r = await probeEgress(noNetwork, 'img');
    expect(r.verdict).toBe('absent');
    expect(r.detail).toMatch(/default bridge/);
  });

  it('never throws, because a failed self-check must not fail startup', async () => {
    const broken = fake({ networkExists: async () => { throw new Error('docker gone'); } });
    await expect(probeEgress(broken, 'img')).resolves.toMatchObject({ verdict: 'unknown' });
  });
});
