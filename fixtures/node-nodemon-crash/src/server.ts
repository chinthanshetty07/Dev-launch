import http from 'http';

// A type error that changes nothing at run time: the value is a string either way.
// ts-node refuses to run this file while it type-checks, and runs it fine without.
const greeting: number = 'hello from a file that does not type-check' as unknown as string;

http
  .createServer((_req, res) => res.end(String(greeting)))
  .listen(Number(process.env.PORT) || 3000, '0.0.0.0');
