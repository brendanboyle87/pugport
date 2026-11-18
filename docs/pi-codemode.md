# Pi mixed Code Mode

PugPort enables Pi's `on` Code Mode for tool-enabled API runs. The model can keep using individual tools or use `codemode` to combine calls and filter their results. This is not a routing profile or a user-facing mode selector. Native Claude, Codex and other CLI executors keep their own execution loops.

## Integration

- `src/server/adapters/pi.ts` adds `codemode` to the explicit tool list and sets the host-owned `COMBORUNNER_PI_CODEMODE` flag. Pure-text and untrusted-input runs clear the flag and keep tools disabled.
- `src/server/pi-extension.mjs` uses the installed Pi SDK's `createCodemodeExtension({ mode: 'on', models: false })`. Ambient extensions remain disabled. Startup verifies the extension-owned `studio-codemode-v1` marker before prompting the model.
- Direct `models.*` calls inside scripts are disabled: these would create additional model requests outside PugPort's routing and usage accounting. Ordinary API model calls continue through the existing budget guard.
- Every nested tool call returns through Pi's tool pipeline. PugPort's read-only, workspace write, individual approval, cancellation and budget rules still apply. Allowing the `codemode` container does not authorize its nested actions.
- Nested events keep their `parentToolCallId` and original tool output in the run trace even when the script prints only a summary. This reduces what is returned to the model without deleting the diagnostic record.
- The build leaves Pi package imports external so its QuickJS worker and assets resolve from the installed dependency.

## Verification

Use the project's required Node 24 or newer runtime. On a Windows development checkout with `.runtime/node.exe`, use that binary instead of an older system `node`.

`tests/pi-codemode.test.ts` uses the actual installed Pi session and QuickJS runtime with a synthetic model stream, isolated settings and no real API credentials. `tests/pi.test.ts` checks adapter activation and fail-closed startup. The explicit CLI probe can also check the built extension without a model request:

```sh
node tests/pi-native-probe.mjs --codemode --built
```

These checks establish execution and permission behavior, not a measured latency or token-saving claim for a real provider. Code Mode does not make plain text generation inherently faster; its main opportunity is reducing repeated tool round trips and excessive tool output.
