# Background tasks

Task execution uses a bounded FIFO queue. Submitting a task creates its input copy and a `queued` record. Enqueueing acknowledges admission after validation; it does not wait for the executor. A full queue rejects admission and leaves the submitted task available for a later attempt.

```js
const queue = new TaskQueue(tasks, {
  concurrency: 1,
  maxPending: 50,
  onFinished: async (job) => {
    // Send an authorized completion notification using selected public fields.
  },
});

// Hold the gateway's exclusive service lease throughout this lifecycle.
await queue.recover();
await queue.enqueue(conversation, taskId);
await queue.cancel(conversation, taskId);
await queue.idle();
await queue.shutdown();
```

`concurrency` is an integer from 1 to 64. `maxPending` is an integer from 0 to 10000 and counts waiting jobs, excluding running jobs. The defaults are 1 and 50. With `maxPending: 0`, admission requires a free execution slot. Concurrent admission calls are serialized, so capacity and duplicate checks remain consistent.

`snapshot()` returns `{running, pending, concurrency}`. `idle()` waits for jobs admitted when it takes its snapshot, including their completion callbacks. Callback failures are caught and stored as `queue.lastError`; a failed notification does not stop the next task. `shutdown()` rejects further admission, persists cancellation for the queue's own waiting and running tasks, aborts its executors, waits for their completion callbacks, and releases queue ownership. Shutdown is idempotent.

## Ownership and task records

Every get, admission, cancellation and list operation is scoped to a conversation. Task IDs never grant access to another conversation's task. `TaskWorkspace.list(conversation, limit = 20)` returns at most 100 records, newest first, without adding the internal task directory. Gateway replies must select public fields from records rather than serialize executor metadata or paths.

The task root contains `.queue-owner.json`, an exclusive owner record with a process ID and random token. Another live owner blocks admission and recovery. A missing or inaccessible process identity is treated conservatively as alive. Startup recovery may reclaim an owner only when its recorded process no longer exists. A reused process ID therefore blocks recovery until an operator resolves the stale owner under exclusive access.

The gateway must acquire its exclusive service lease before `queue.recover()` and retain that lease until shutdown finishes. Stale owner reclamation depends on that service lease to serialize startup. Direct `TaskWorkspace.recover()` also refuses a different live queue owner. Run recovery once during startup, before accepting work; do not run it concurrently with external workers operating on the same task root.

Each executor must exclusively create the task's permanent `state/run.claim`. That file prevents repeated execution, including execution by a different process. Admission rejects previously claimed tasks. Claims are retained for completed and interrupted tasks. To retry, submit a new task with a new ID.

## Cancellation and recovery

Cancellation creates `state/cancel.request` before recording the terminal `cancelled` state. The executor checks that marker when finishing, so a crash after the cancellation request can still be recognized at startup. Running tasks receive an `AbortSignal`; queued tasks are removed before execution. A task that has already reached a terminal state keeps that state. Only `succeeded` tasks can supply deliverable outputs.

`TaskWorkspace.run(conversation, id, {signal})` remains available for an explicit worker. An already aborted signal produces a cancelled task without launching the command. Direct workers must coordinate with the service lease when sharing the task root.

Recovery marks a task `interrupted` when its state was `running` or a run claim exists. A pending cancellation request produces `cancelled`. Unclaimed queued tasks remain queued and are not automatically scheduled. Recovery does not rerun tasks, deliver old outputs, or kill processes from persisted IDs. An executor surviving its original service must be inspected by the operator before submitting replacement work.

Task inputs are checked against attachment size and SHA-256 metadata after copying, and checked again before execution. Altered input bytes fail the task before the executor launches.

The process runner starts commands without a shell and hides Windows subprocess windows. On cancellation or timeout, Windows uses `taskkill /T /F` against the child it just spawned; POSIX executors run in their own process group and that group receives `SIGKILL`. Abort listeners and runner timers are removed on completion. This process ownership is local to the current runner and is never reconstructed from a task archive.
