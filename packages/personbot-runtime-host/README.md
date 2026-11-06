# personbot runtime host

This package owns one runtime process and its NDJSON JSON-RPC transport. It has
no dependency on dsh or application state; the runtime plugin implements domain
commands.

```ts
import { spawnRuntime } from '@personbot/runtime-host';

const runtime = spawnRuntime({
  command: process.execPath,
  args: ['/absolute/path/to/runtime-entry.ts'],
  cwd: '/absolute/path/to/workspace',
  env: isolatedEnvironment,
});

const unsubscribe = runtime.onNotification(({ method, params }) => {
  projectRuntimeEvent(method, params);
});

await runtime.request('personbot.v1.initialize', { protocolVersion: 1 });
await runtime.close();
unsubscribe();
```

Requests use numeric IDs and correlate independently. A timeout or caller abort
only stops the local wait; send a domain stop command to stop actual work.
Notifications have no ID. Runtime-originated requests are unsupported: the
runtime publishes approval events and receives decisions as domain commands.

`close()` first asks `personbot.v1.shutdown`, then sends SIGTERM and SIGKILL
after bounded grace periods to the exact owned process. Callers can change the
shutdown method or disable it with `shutdownMethod: null`. Descendant work must
be stopped and reaped by the runtime's own shutdown lifecycle.

Malformed or oversized protocol output fails the connection and closes its
process. Diagnostic stderr is retained as a bounded tail. Child exit rejects
pending requests; `closed` resolves with its exit status and transport error.
Notification subscribers run synchronously; a subscriber exception affects
neither the child process nor other subscribers. Set
`onNotificationError` to record subscriber failures and repair the affected
projection from a runtime snapshot. Exceptions from that error hook are also
contained.

Run isolated child-process tests with:

```sh
node --test packages/personbot-runtime-host/test/host.node-test.ts
```
