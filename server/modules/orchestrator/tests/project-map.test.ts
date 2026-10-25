import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareJobProjectMap } from '../services/project-map.service.js';

test('optional map preparation handles disabled, missing, malformed and failing tools without blocking jobs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-map-'));
  try {
    assert.equal(await prepareJobProjectMap(root, root), '');
    const script = path.join(root, 'project-map.py');
    for (const body of ['print(\'{"state":"disabled"}\')', 'print("not json")', 'raise RuntimeError("unavailable")']) {
      await writeFile(script, body);
      assert.equal(await prepareJobProjectMap(root, root), '');
    }
    await writeFile(script, 'import json, sys\nprint(json.dumps({"state":"ready"} if sys.argv[1] == "prepare" else {"guidance":"Query symbols; inspect exact source."}))');
    assert.equal(await prepareJobProjectMap(root, root), 'Query symbols; inspect exact source.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
