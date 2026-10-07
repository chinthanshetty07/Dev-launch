/**
 * A repository handed over by a link — the DevLaunch website's "Run on my computer" button
 * opens `http://127.0.0.1:3939/?repo=https://github.com/owner/repo`.
 *
 * The link only ever *fills in* the form. Starting a run stays the person's own click: any
 * website can open a link to 127.0.0.1, so a link that launched by itself would let any
 * page on the internet run code on this machine without being asked.
 *
 * Only a plain public GitHub repository URL is taken; anything else is ignored.
 */
const GITHUB_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;

export function repoFromLink(search: string): string | null {
  const value = new URLSearchParams(search).get('repo')?.trim();
  if (!value || value.length > 200) return null;
  return GITHUB_REPO.test(value) ? value.replace(/\.git$/, '').replace(/\/$/, '') : null;
}
