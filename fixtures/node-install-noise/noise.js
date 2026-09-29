// What a successful install printed in two real repositories, verbatim in shape: npm's
// engine *warnings* for transitive packages (fastify/demo), and husky's prepare step
// finding no git (gothinkster/angular-realworld-example-app). Neither is a failure — the
// install goes on to succeed — and both were reported as the reason the start failed.
const lines = [
  'npm warn EBADENGINE Unsupported engine {',
  "npm warn EBADENGINE   package: 'cookie@2.0.1',",
  "npm warn EBADENGINE   required: { node: '>=22' },",
  "npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }",
  'npm warn EBADENGINE }',
  'husky - install command is DEPRECATED',
  'git command not found',
];
for (const line of lines) console.log(line);
