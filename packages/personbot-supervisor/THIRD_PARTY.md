# Super Agent attribution

The persistent transaction/effect/outbox arrangement is adapted from the
DeepSeek Harness Team's `dsh-superagent-prototype` at commit
`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`, specifically the mechanisms in
`src/core/ports.ts`, `src/app/store.ts`, `src/app/effects.ts`, and
`src/app/outbox.ts`.

Personbot uses immutable effect IDs bound to an execution and task revision
instead of updating one queue key in place. Callback settlement checks the
exact effect and current execution, preserving the upstream protection
against an old attempt overwriting newer work. Domain transactions enqueue
effects and immutable outbound receipts; asynchronous native execution is
owned by the runtime bridge after commit.

The full prototype bundle is not loaded. Worker reports require human
acceptance before completion, interrupted execution with unknown effects
requires explicit recovery, and per-task pause/cancel records native stop
confirmation.

Upstream license:

```text
MIT License

Copyright (c) 2026 DeepSeek Harness Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
