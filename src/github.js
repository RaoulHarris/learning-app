// The few GitHub REST calls the app makes, with a token pasted in once per
// device (a fine-grained token for the data repo only, Contents read and
// write). Reading: the branch's head commit, its whole file tree (paths and
// blob shas), and single blobs. Writing: one commit holding every file this
// device changed, made from a tree on top of the head; the branch moves only
// if nothing else was pushed meanwhile (else a Conflict, and the caller
// starts again from the new head).

import { sha1Bytes, utf8 } from '../engine/sha1.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status; // 0: no answer (offline)
  }
}

/** Someone else pushed between reading the head and moving the branch. */
export class Conflict extends GitHubError {
  constructor(message) {
    super(422, message);
    this.name = 'Conflict';
  }
}

/** The git blob sha of a text file: SHA-1 over "blob <bytes>\0" and its UTF-8 bytes. */
export function blobSha(text) {
  const body = utf8(text);
  const head = utf8(`blob ${body.length}\u0000`);
  return sha1Bytes([...head, ...body]);
}

export class GitHub {
  /** ``repo``: "owner/name". ``fetchFn`` stands in for fetch in tests. */
  constructor({ repo, token, branch = 'main', fetchFn }) {
    this.repo = repo;
    this.token = token;
    this.branch = branch;
    this.fetchFn = fetchFn || ((...args) => fetch(...args));
  }

  async call(method, path, body = null, accept = 'application/vnd.github+json') {
    const headers = {
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== null) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await this.fetchFn(API + path, {
        method, headers, body: body === null ? undefined : JSON.stringify(body), cache: 'no-store',
      });
    } catch (exc) {
      throw new GitHubError(0, 'GitHub could not be reached (offline?)');
    }
    if (!res.ok) {
      let message = res.statusText;
      try { message = (await res.json()).message || message; } catch (exc) { /* not JSON */ }
      if (res.status === 401) message = 'the token was refused (expired or revoked?)';
      if (res.status === 404) message = `not found: ${path} (is the repository name right, and does the token cover it?)`;
      throw new GitHubError(res.status, message);
    }
    return accept.includes('raw') ? res.text() : res.json();
  }

  get base() {
    return `/repos/${this.repo}`;
  }

  /** The repository, to check the token: .permissions.push says whether it can write. */
  info() {
    return this.call('GET', this.base);
  }

  /** {commit, tree}: the branch's head commit and its tree. */
  async head() {
    const ref = await this.call('GET', `${this.base}/git/ref/heads/${this.branch}`);
    const commit = await this.call('GET', `${this.base}/git/commits/${ref.object.sha}`);
    return { commit: ref.object.sha, tree: commit.tree.sha };
  }

  /** Every file in a tree: [{path, sha, size}]. */
  async tree(sha) {
    const t = await this.call('GET', `${this.base}/git/trees/${sha}?recursive=1`);
    if (t.truncated) throw new GitHubError(0, 'the repository is too big to list in one call');
    return t.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size }));
  }

  /** A file's text, by its blob sha. */
  blob(sha) {
    return this.call('GET', `${this.base}/git/blobs/${sha}`, null, 'application/vnd.github.raw+json');
  }

  /** One commit on top of ``head`` with ``files`` ([{path, text}]) written;
   * the branch moves to it unless it has moved since (then Conflict). */
  async commit({ head, files, message }) {
    const tree = await this.call('POST', `${this.base}/git/trees`, {
      base_tree: head.tree,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })),
    });
    const commit = await this.call('POST', `${this.base}/git/commits`, {
      message, tree: tree.sha, parents: [head.commit],
    });
    try {
      await this.call('PATCH', `${this.base}/git/refs/heads/${this.branch}`, { sha: commit.sha, force: false });
    } catch (exc) {
      if (exc.status === 422 || exc.status === 409) throw new Conflict(exc.message);
      throw exc;
    }
    return { commit: commit.sha, tree: tree.sha };
  }
}
