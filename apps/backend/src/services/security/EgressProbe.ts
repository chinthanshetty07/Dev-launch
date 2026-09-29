import type { DockerManager } from '../docker/DockerManager.js';
import { config } from '../../config/index.js';

/**
 * Whether the egress policy is actually in force, established by trying to break it.
 *
 * `scripts/setup-network-policy.sh` installs iptables rules that stop a container
 * reaching RFC1918, the cloud-metadata address, or the VM host. `docs/limitations.md`
 * warned the rules "do not survive recreating that VM". They do not survive *restarting*
 * it either, which is far more common — after one `colima stop && colima start` the
 * network still existed and its chain was empty:
 *
 *     colima ssh -- sudo iptables -S DOCKER-USER
 *       -N DOCKER-USER                      ← no rules at all
 *
 * Every run in between used the weaker isolation the docs warn about, and nothing said
 * so. The silence was the defect, not the missing rules.
 *
 * Checked by behaviour rather than by reading the rules. The rules live inside the VM
 * and the backend runs on the host, so inspecting them would mean shelling out to
 * `colima ssh` — tying the product to one VM manager and to a binary it has no business
 * invoking. Trying to reach a blocked address from a container proves the same thing,
 * works whatever installed the rules, and is exactly the evidence a person would gather
 * by hand.
 *
 * 169.254.169.254 is the target because it is the cloud-metadata address: link-local,
 * routed nowhere on a developer's machine, and the single most valuable thing for an
 * untrusted container to reach. If the policy is live, the connection hangs and the
 * timeout fires. If it answers or is refused *quickly*, something is forwarding it.
 */
export type EgressVerdict = 'enforced' | 'absent' | 'unknown';

export interface ProbeResult {
  verdict: EgressVerdict;
  /** What was observed, for the log line and for `/api/health`. */
  detail: string;
}

/** Decide from what the probe container did. Pure, so the judgement is testable. */
export function verdictFrom(outcome: {
  networkPresent: boolean;
  reachedMetadata: boolean | null;
}): ProbeResult {
  if (!outcome.networkPresent) {
    return {
      verdict: 'absent',
      detail:
        `The "${config.docker.networkName}" network does not exist, so containers run on ` +
        'the default bridge with no egress policy at all. Run scripts/setup-network-policy.sh.',
    };
  }
  if (outcome.reachedMetadata === null) {
    return { verdict: 'unknown', detail: 'The egress policy could not be checked.' };
  }
  if (outcome.reachedMetadata) {
    return {
      verdict: 'absent',
      detail:
        'A container reached 169.254.169.254 (the cloud-metadata address), so the egress ' +
        'policy is not in force — its rules do not survive restarting the VM. ' +
        'Run scripts/setup-network-policy.sh.',
    };
  }
  return { verdict: 'enforced', detail: 'Containers cannot reach link-local or private addresses.' };
}

/**
 * Run the probe. Never throws: a check that cannot run reports `unknown`, because a
 * startup that fails because its self-check failed is worse than one that says so.
 */
export async function probeEgress(docker: DockerManager, image: string): Promise<ProbeResult> {
  let networkPresent = false;
  try {
    networkPresent = await docker.networkExists(config.docker.networkName);
  } catch {
    return verdictFrom({ networkPresent: true, reachedMetadata: null });
  }
  if (!networkPresent) return verdictFrom({ networkPresent: false, reachedMetadata: null });

  try {
    const reached = await docker.canReachFromNetwork(
      image,
      config.docker.networkName,
      '169.254.169.254',
      80,
    );
    return verdictFrom({ networkPresent: true, reachedMetadata: reached });
  } catch {
    // No image pulled yet, Docker busy, anything else. Not evidence either way.
    return verdictFrom({ networkPresent: true, reachedMetadata: null });
  }
}
