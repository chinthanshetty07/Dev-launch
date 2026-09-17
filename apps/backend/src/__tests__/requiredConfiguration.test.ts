import { describe, it, expect } from 'vitest';
import {
  ProjectPlanSchema,
  type BackingService,
  type ProjectPlan,
  type ServiceCandidate,
} from '@devlaunch/shared';
import {
  applyConfiguration,
  requiredConfiguration,
  requiredConfigurationForSingle,
} from '../services/planning/RequiredConfiguration.js';

const plan = (services: { name: string; role: 'web' | 'api' | 'worker'; dir: string; env?: Record<string, string> }[]): ProjectPlan =>
  ProjectPlanSchema.parse({
    planSource: 'rule-based',
    services: services.map((s) => ({
      runtime: { language: 'node', version: '20' },
      packageManager: 'npm',
      installCommand: null,
      buildCommand: null,
      startCommand: 'npm run dev',
      workingDirectory: s.dir,
      expectedPort: 3000,
      planSource: 'rule-based',
      name: s.name,
      role: s.role,
      environmentVariables: Object.entries(s.env ?? {}).map(([key, value]) => ({
        key,
        value,
        required: false,
      })),
    })),
  });

const candidate = (over: Partial<ServiceCandidate> & Pick<ServiceCandidate, 'dir'>): ServiceCandidate => ({
  name: over.dir,
  role: 'api',
  language: 'node',
  scripts: [],
  evidence: 'test',
  ...over,
});

describe('what a project still needs from a person', () => {
  it('asks for a secret declared beside the service that reads it', () => {
    // The gap this closes: GROQ_API_KEY lives in backend/.env.example, the gate read
    // only the repository root, so nothing was asked and the container started without
    // it — surfacing later as an application crash with the reason in its own logs.
    const missing = requiredConfiguration(
      plan([
        { name: 'frontend', role: 'web', dir: 'frontend' },
        { name: 'backend', role: 'api', dir: 'backend' },
      ]),
      [
        candidate({ dir: 'frontend', role: 'web' }),
        candidate({ dir: 'backend', envExample: [{ key: 'GROQ_API_KEY', hasDefault: false }] }),
      ],
      [],
    );

    expect(missing).toEqual([{ key: 'GROQ_API_KEY', hasDefault: false, service: 'backend' }]);
  });

  it('does not ask for a variable that ships a value', () => {
    const missing = requiredConfiguration(
      plan([{ name: 'backend', role: 'api', dir: 'backend' }, { name: 'web', role: 'web', dir: 'web' }]),
      [
        candidate({ dir: 'backend', envExample: [{ key: 'LOG_LEVEL', hasDefault: true }] }),
        candidate({ dir: 'web', role: 'web' }),
      ],
      [],
    );
    expect(missing).toEqual([]);
  });

  it('never asks for the database URL it is about to inject', () => {
    // Asking would be asking a person to guess a hostname on a network they cannot see,
    // and any value they gave would be overridden.
    const backing: BackingService[] = [
      { kind: 'mongodb', evidence: 'depends on mongoose', urlEnvKeys: ['MONGODB_URI'], neededBy: ['backend'] },
    ];
    const missing = requiredConfiguration(
      plan([{ name: 'backend', role: 'api', dir: 'backend' }, { name: 'web', role: 'web', dir: 'web' }]),
      [
        candidate({ dir: 'backend', envExample: [{ key: 'MONGODB_URI', hasDefault: false }] }),
        candidate({ dir: 'web', role: 'web' }),
      ],
      backing,
    );
    expect(missing).toEqual([]);
  });

  it('never asks for a sibling address it has not chosen yet', () => {
    // CORS_ORIGIN and VITE_API_URL are decided when ports are allocated. A value supplied
    // here would either be overridden or, worse, respected and wrong.
    const missing = requiredConfiguration(
      plan([
        { name: 'frontend', role: 'web', dir: 'frontend' },
        { name: 'backend', role: 'api', dir: 'backend' },
      ]),
      [
        candidate({
          dir: 'frontend',
          role: 'web',
          envKeys: ['VITE_API_URL'],
          envExample: [{ key: 'VITE_API_URL', hasDefault: false }],
        }),
        candidate({
          dir: 'backend',
          envKeys: ['CORS_ORIGIN'],
          envExample: [{ key: 'CORS_ORIGIN', hasDefault: false }],
        }),
      ],
      [],
    );
    expect(missing).toEqual([]);
  });

  it('never asks for PORT, which it sets itself', () => {
    const missing = requiredConfiguration(
      plan([{ name: 'backend', role: 'api', dir: 'backend' }, { name: 'web', role: 'web', dir: 'web' }]),
      [
        candidate({ dir: 'backend', envExample: [{ key: 'PORT', hasDefault: false }] }),
        candidate({ dir: 'web', role: 'web' }),
      ],
      [],
    );
    expect(missing).toEqual([]);
  });

  it('asks each service separately when both need the same key', () => {
    // The same name can mean different things in two services, so each is asked in its
    // own right rather than collapsed into one question.
    const missing = requiredConfiguration(
      plan([
        { name: 'api-a', role: 'api', dir: 'a' },
        { name: 'api-b', role: 'api', dir: 'b' },
      ]),
      [
        candidate({ dir: 'a', envExample: [{ key: 'API_KEY', hasDefault: false }] }),
        candidate({ dir: 'b', envExample: [{ key: 'API_KEY', hasDefault: false }] }),
      ],
      [],
    );
    expect(missing.map((m) => m.service)).toEqual(['api-a', 'api-b']);
  });

  it('leaves a single-service repository asking the same question as before', () => {
    expect(
      requiredConfigurationForSingle({
        envExample: [
          { key: 'SECRET', hasDefault: false },
          { key: 'PORT', hasDefault: false },
          { key: 'NICE_TO_HAVE', hasDefault: true },
        ],
      } as never),
    ).toEqual([{ key: 'SECRET', hasDefault: false }]);
  });
});

describe('routing supplied values', () => {
  it('gives a value only to the services that declare it', () => {
    // One service's API key must not land in another's environment.
    const project = plan([
      { name: 'frontend', role: 'web', dir: 'frontend' },
      { name: 'backend', role: 'api', dir: 'backend' },
    ]);
    const applied = applyConfiguration(
      project,
      [
        candidate({ dir: 'frontend', role: 'web' }),
        candidate({ dir: 'backend', envExample: [{ key: 'GROQ_API_KEY', hasDefault: false }] }),
      ],
      { GROQ_API_KEY: 'sk-test' },
    );

    const backend = applied.services.find((s) => s.name === 'backend')!;
    const frontend = applied.services.find((s) => s.name === 'frontend')!;
    expect(backend.environmentVariables).toContainEqual({
      key: 'GROQ_API_KEY',
      value: 'sk-test',
      required: true,
    });
    expect(frontend.environmentVariables.map((v) => v.key)).not.toContain('GROQ_API_KEY');
  });

  it('replaces a placeholder rather than adding a second entry', () => {
    const project = plan([
      { name: 'backend', role: 'api', dir: 'backend', env: {} },
      { name: 'web', role: 'web', dir: 'web' },
    ]);
    const withPlaceholder: ProjectPlan = {
      ...project,
      services: project.services.map((s) =>
        s.name === 'backend'
          ? { ...s, environmentVariables: [{ key: 'SECRET', value: null, required: true }] }
          : s,
      ),
    };

    const applied = applyConfiguration(
      withPlaceholder,
      [candidate({ dir: 'backend', envExample: [{ key: 'SECRET', hasDefault: false }] }), candidate({ dir: 'web', role: 'web' })],
      { SECRET: 'value' },
    );
    const backend = applied.services.find((s) => s.name === 'backend')!;
    expect(backend.environmentVariables.filter((v) => v.key === 'SECRET')).toEqual([
      { key: 'SECRET', value: 'value', required: true },
    ]);
  });
});
