# OpenMausBot Super Agent runtime

The original OpenMausBot product consumes `createSuperagentGateway`
from `src/index.ts`. Native execution and task state belong to the
vendored DeepSeek Harness team's Super Agent research prototype.
See [UPSTREAM.md](UPSTREAM.md) for source provenance, exact patches,
permissions, process ownership and verification.

The gateway offers direct input, interruption, native approval/question
responses, normalized events and tool-free text generation. The
embedding product supplies its original memory port and a durable source
delivery callback. Bot/thread/context identity stays in the parent
process; the native source uses opaque binding IDs.

`home` and `workspace` must be absolute. The parent never imports the
upstream runtime into its own process. Managed child homes contain
official task SQLite state and native DSH Session persistence; the
gateway's `bindings.sqlite` contains binding/request/delivery receipts.

The deterministic test adapter is enabled only by the explicit fixture
option. `echo hello` tests ordinary conversation, `task write file.txt`
tests a native DSH write through an actual official ticket, `task memory
query` tests the original memory bridge, `task approval` and `task
question` test native decisions, and `task attention` followed by
`attention answer Mars` tests official ticket clarification and final
delivery.
