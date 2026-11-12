import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

type BootstrapResult = {
  command: string | null;
  environmentFileReads: number;
  mode: string | null;
  authNextCalled: boolean;
  authStatus: number;
  authenticatedUsername: string | null;
  runtime: string;
};

const RESULT_PREFIX = '__CLOUDCLI_BOOTSTRAP_RESULT__';
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(testDirectory, '..', '..', '..', '..');

function sourceModuleUrl(...segments: string[]): string {
  return pathToFileURL(path.join(applicationRoot, ...segments)).href;
}

async function runCliBootstrapFixture(isPlatform: boolean): Promise<BootstrapResult> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-cli-bootstrap-'));
  const fixtureServerDirectory = path.join(fixtureRoot, 'server');
  const fixtureCliDirectory = path.join(fixtureServerDirectory, 'modules', 'cli');
  const fixtureDatabasePath = path.join(fixtureRoot, 'auth.db');

  try {
    await Promise.all([
      mkdir(fixtureCliDirectory, { recursive: true }),
      mkdir(path.join(fixtureRoot, '.config', 'cli'), { recursive: true }),
      mkdir(path.join(fixtureRoot, '.cache'), { recursive: true }),
      mkdir(path.join(fixtureRoot, '.local', 'share'), { recursive: true }),
      mkdir(path.join(fixtureRoot, 'tmp'), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(
        path.join(applicationRoot, 'server', 'load-env.ts'),
        path.join(fixtureServerDirectory, 'load-env.ts'),
      ),
      copyFile(
        path.join(applicationRoot, 'server', 'modules', 'cli', 'cli.ts'),
        path.join(fixtureCliDirectory, 'cli.ts'),
      ),
    ]);
    await writeFile(
      path.join(fixtureRoot, '.env'),
      [
        `VITE_IS_PLATFORM=${String(isPlatform)}`,
        `DATABASE_PATH=${fixtureDatabasePath.replace(/\\/g, '/')}`,
      ].join('\n'),
      'utf8',
    );

    const fixtureIndexSource = `
import { createCliService } from ${JSON.stringify(sourceModuleUrl('server', 'modules', 'cli', 'cli.service.ts'))};
import { authenticateToken } from ${JSON.stringify(sourceModuleUrl('server', 'modules', 'auth', 'auth.middleware.ts'))};
import { getBrowserUseRuntime } from ${JSON.stringify(sourceModuleUrl('server', 'modules', 'browser-use', 'browser-use-runtime.ts'))};
import { initializeDatabase } from ${JSON.stringify(sourceModuleUrl('server', 'modules', 'database', 'init-db.ts'))};
import { closeConnection } from ${JSON.stringify(sourceModuleUrl('server', 'modules', 'database', 'connection.ts'))};
import { userDb } from ${JSON.stringify(sourceModuleUrl('server', 'modules', 'database', 'repositories', 'users.ts'))};

let environmentFileReads = 0;

export function createCliApplication() {
  const service = createCliService({
    applicationRoot: ${JSON.stringify(fixtureRoot)},
    defaultDatabasePath: ${JSON.stringify(fixtureDatabasePath)},
    homeDirectory: ${JSON.stringify(fixtureRoot)},
    packageMetadata: { version: '1.0.0' },
    environment: process.env,
    fileSystem: {
      readTextFile: () => {
        environmentFileReads += 1;
        return '';
      },
      pathExists: () => false,
      getFileStats: () => ({ size: 0, modifiedAt: new Date(0) }),
    },
    output: { log: () => undefined, error: () => undefined },
    sandboxService: { execute: async () => 0 },
    getLatestPackageVersion: async () => '1.0.0',
    updateGlobalPackage: () => undefined,
    startServer: async () => undefined,
    startBrowserUseMcp: async () => undefined,
  });

  return {
    async run(argumentsList: string[]) {
      const exitCode = await service.run(argumentsList);
      await initializeDatabase();
      userDb.createUser('bootstrap-user', 'password-hash');

      const request: any = { headers: {}, query: {} };
      const response: any = {
        statusCode: 200,
        body: null,
        headers: {},
        setHeader(name: string, value: string) {
          this.headers[name] = value;
        },
        status(statusCode: number) {
          this.statusCode = statusCode;
          return this;
        },
        json(body: unknown) {
          this.body = body;
          return this;
        },
      };
      let authNextCalled = false;
      await authenticateToken(request, response, () => {
        authNextCalled = true;
      });
      const runtime = getBrowserUseRuntime();

      console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({
        command: argumentsList[0] ?? null,
        environmentFileReads,
        mode: process.env.VITE_IS_PLATFORM ?? null,
        authNextCalled,
        authStatus: response.statusCode,
        authenticatedUsername: request.user?.username ?? null,
        runtime,
      }));
      closeConnection();
      return exitCode;
    },
  };
}
`;
    await writeFile(path.join(fixtureCliDirectory, 'index.ts'), fixtureIndexSource, 'utf8');

    const childEnvironment = { ...process.env };
    for (const name of [
      'VITE_IS_PLATFORM',
      'DATABASE_PATH',
      'NODE_OPTIONS',
      'NODE_TEST_CONTEXT',
      'CLI_HUB_EVENTS_LOG',
      'WORKSPACES_ROOT',
      'LABS_CONTROL_URL',
      'LABS_CONTROL_TOKEN',
      'LABS_TOKEN',
      'TOKEN_URL',
      'TRIPAM_API_URL',
      'TRIPAM_PLANS_CLIENT_ID',
      'TRIPAM_PLANS_CLIENT_SECRET',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
    ]) {
      delete childEnvironment[name];
    }
    childEnvironment.HOME = fixtureRoot;
    childEnvironment.USERPROFILE = fixtureRoot;
    childEnvironment.XDG_CONFIG_HOME = path.join(fixtureRoot, '.config');
    childEnvironment.XDG_CACHE_HOME = path.join(fixtureRoot, '.cache');
    childEnvironment.XDG_DATA_HOME = path.join(fixtureRoot, '.local', 'share');
    childEnvironment.TMPDIR = path.join(fixtureRoot, 'tmp');
    childEnvironment.TEMP = childEnvironment.TMPDIR;
    childEnvironment.TMP = childEnvironment.TMPDIR;
    childEnvironment.NODE_ENV = 'test';
    let stdout: string;
    try {
      stdout = execFileSync(
        process.execPath,
        [
          path.join(applicationRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          '--no-cache',
          '--tsconfig',
          path.join(applicationRoot, 'server', 'tsconfig.json'),
          path.join(fixtureCliDirectory, 'cli.ts'),
          'status',
        ],
        {
          cwd: applicationRoot,
          encoding: 'utf8',
          env: childEnvironment,
          timeout: 30_000,
        },
      );
    } catch (error) {
      const failure = error as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
      const childStdout = failure.stdout?.toString() ?? '';
      const childStderr = failure.stderr?.toString() ?? '';
      throw new Error(
        `CLI bootstrap fixture failed: ${failure.message ?? String(error)}\n`
        + `stdout:\n${childStdout}\nstderr:\n${childStderr}`,
      );
    }
    const resultLine = stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(RESULT_PREFIX));
    assert.ok(resultLine, `Missing bootstrap result in child output:\n${stdout}`);
    return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as BootstrapResult;
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

test('CLI bootstrap selects Platform authentication and cloud runtime from .env', async () => {
  const result = await runCliBootstrapFixture(true);

  assert.deepEqual(result, {
    command: 'status',
    environmentFileReads: 0,
    mode: 'true',
    authNextCalled: true,
    authStatus: 200,
    authenticatedUsername: 'bootstrap-user',
    runtime: 'cloud',
  });
});

test('CLI bootstrap selects OSS authentication and local runtime from .env', async () => {
  const result = await runCliBootstrapFixture(false);

  assert.deepEqual(result, {
    command: 'status',
    environmentFileReads: 0,
    mode: 'false',
    authNextCalled: false,
    authStatus: 401,
    authenticatedUsername: null,
    runtime: 'local',
  });
});
