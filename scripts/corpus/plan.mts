/**
 * Analyse and plan a local directory with the backend's own code, no server and no
 * containers — the fast loop for a planning change.
 *
 *   apps/backend/node_modules/.bin/tsx scripts/corpus/plan.mts <dir>
 */
import { RepositoryAnalyzer } from '../../apps/backend/src/services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../apps/backend/src/services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from '../../apps/backend/src/services/planning/ProjectPlanner.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: plan.mts <dir>');
const analyzer = new RepositoryAnalyzer();
const meta = await analyzer.analyze(dir);
console.log('services:', (meta.services ?? []).map((s) => `${s.dir}(${s.evidence})`).join(', ') || '—');
console.log('workspace:', JSON.stringify(meta.workspace?.runnable?.map((p) => p.dir) ?? null));
if ((meta.services?.length ?? 0) > 1) {
  const project = await new ProjectPlanner(analyzer).planProject(dir, meta);
  console.log(JSON.stringify(project, null, 2));
} else {
  const outcome = await new RuleBasedPlanner(analyzer).planRepository(dir);
  console.log(JSON.stringify({ ...outcome, plan: outcome.plan && { ...outcome.plan, healthCheck: undefined } }, null, 2));
}
