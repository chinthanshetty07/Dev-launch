import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * A throwaway self-signed certificate and key for `localhost`, made with openssl, so no
 * private key is ever committed. Returns the two paths.
 */
export async function selfSignedCert(dir: string, cert = 'localhost.pem', key = 'localhost-key.pem') {
  await mkdir(dir, { recursive: true });
  const certPath = join(dir, cert);
  const keyPath = join(dir, key);
  await promisify(execFile)('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
  ]);
  return { certPath, keyPath };
}
