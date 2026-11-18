/** Only for pure path tests on synthetic hosts; never wrap a backend or a network/process call. */
export function productionPaths<T>(check: () => T): T {
  const context = process.env.NODE_TEST_CONTEXT;
  const flag = process.env.PUGPORT_UNDER_TEST;
  const argv = process.argv;
  const execArgv = process.execArgv;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    delete process.env.PUGPORT_UNDER_TEST;
    process.argv = [process.execPath, 'synthetic-path-fixture'];
    process.execArgv = [];
    return check();
  } finally {
    if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = context;
    if (flag === undefined) delete process.env.PUGPORT_UNDER_TEST;
    else process.env.PUGPORT_UNDER_TEST = flag;
    process.argv = argv;
    process.execArgv = execArgv;
  }
}
