import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProblemReport,
  validateProblemReport,
  validateProblemImages,
  type ProblemReportPayload,
} from '../src/shared/problem-report.ts';

const state = {
  app: { name: 'PugPort', version: '1.0', platform: 'win32', dataDir: 'C:/Users/example/private' },
  runtimes: [],
};
test('report projection redacts structured values and excludes conversation by default', () => {
  const payload = buildProblemReport({
    installId: 'synthetic',
    state,
    description: 'Reach user@example.test',
    errors: Array.from({ length: 250 }, (_, i) => `error ${i}`).join('\n'),
    task: {
      error: 'https://example.test/fail?access_token=private',
      location: 'C:/Users/example/repo/file.ts',
      secret: 'Bearer secret-value',
    },
  });
  assert.doesNotMatch(JSON.stringify(payload), /user@example|access_token|private|secret-value|dataDir/);
  assert.equal((payload.diagnostics.errors as string).split('\n').length, 200);
  assert.equal(payload.diagnostics.conversation, undefined);
  assert.match(JSON.stringify(payload), /\[path\]/);
  assert.doesNotMatch(JSON.stringify(payload), /repo|file\.ts/);
  const withConversation = buildProblemReport({
    installId: 'synthetic',
    state,
    description: 'Failure',
    conversation: [{ content: 'name@example.test' }],
  });
  assert.deepEqual(withConversation.diagnostics.conversation, [{ content: '[email]' }]);
});
test('report and image limits reject empty and oversized input', () => {
  const payload: ProblemReportPayload = {
    installId: 'test',
    version: '1',
    os: 'test',
    description: '',
    diagnostics: {},
  };
  assert.throws(() => validateProblemReport(payload, []), /EMPTY_REPORT/);
  validateProblemReport({ ...payload, description: 'a'.repeat(4000) }, []);
  assert.throws(() => validateProblemReport({ ...payload, description: 'a'.repeat(4001) }, []));
  assert.throws(
    () => validateProblemReport({ ...payload, description: 'x', diagnostics: { text: '中'.repeat(100000) } }, []),
    /DIAGNOSTICS_TOO_LARGE/,
  );
  const image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==' };
  validateProblemReport(payload, [image]);
  validateProblemImages(Array(4).fill(image));
  assert.throws(() => validateProblemImages(Array(5).fill(image)));
  assert.throws(() =>
    validateProblemImages([{ dataUrl: `data:image/jpeg;base64,${Buffer.alloc(1024 * 1024 + 1).toString('base64')}` }]),
  );
  assert.throws(() => validateProblemImages([{ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }]));
});
