import { underTest, testPath, testDirectory } from '../../src/server/platform/under-test.mjs';

process.send({
  test: underTest(),
  flag: process.env.PUGPORT_UNDER_TEST,
  context: process.env.NODE_TEST_CONTEXT,
  script: testPath(process.argv[1]),
  directory: testDirectory(),
});
