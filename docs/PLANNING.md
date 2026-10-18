# Task previews

Natural language requests create previews. They do not start tasks. Send `/plan` followed by the intended task, review the proposed workflow, case name, parameters and attachment selections, then send `/submit <plan-id>` to submit that exact saved preview. A preview expires after one hour.

Only configured workflows are available. A preview cannot introduce another program, executable, input path or output directory. Parameters must satisfy the workflow's declared type, range, length and enum rules. String parameters reject filesystem path separators and shell control syntax. Case names contain at most 40 ASCII letters, digits, underscores or hyphens and begin with a letter or digit.

Missing required parameters remain missing until the user supplies them. A matching attachment is selected automatically only when exactly one attachment has an allowed extension. When multiple files match, the user must select an attachment ID. Explicit IDs must belong to the current conversation and match the input role's allowed extension. An incomplete preview cannot be submitted.

## Module interfaces

`buildPlan(workflows, attachments, candidate)` accepts an object with only `workflow`, `caseName`, `params` and `files`. The `files` object maps input roles to attachment IDs. It returns an immutable ordinary object:

```json
{
  "workflow": "measure",
  "caseName": "sample",
  "request": {
    "params": { "frequency": 5 },
    "files": { "source": "0123456789abcdef" }
  },
  "ready": true,
  "missing": [],
  "attachments": [
    {
      "role": "source",
      "id": "0123456789abcdef",
      "sha256": "<attachment digest>"
    }
  ]
}
```

Each missing entry has `kind` (`parameter` or `input`), `name` and `reason` (`required`, `missing` or `ambiguous`). Input entries also contain `attachmentIds`, listing the available matches. These entries support a user request for the missing information; they never provide fabricated defaults.

`planningInstructions(workflows, attachments)` returns instructions and a JSON catalog containing workflow identifiers, permitted parameter rules, input extensions and attachment IDs and names. Executor settings, filesystem locations and unrelated configuration are excluded. Treat this prompt as assistance for generating a candidate; the deterministic validator enforces the boundary.

`parseCandidate(text)` accepts a strict JSON object, optionally enclosed in a JSON Markdown fence. It rejects surrounding prose, invalid JSON, unknown top-level properties, nonobjects and responses longer than 32,768 characters. Pass its result through `buildPlan` before saving it. It never evaluates source text.

`new PlanStore(local)` uses the existing conversation workspace. Its root is `local.root`; it does not use the task execution root. Files are written atomically under `local.path(conversation)/plans/<plan-id>.json`, with workspace containment and symbolic link checks.

- `save(conversation, plan)` returns `{id, conversation, createdAt, expiresAt, fingerprint, plan}`. IDs contain 16 lowercase hexadecimal characters. The saved preview lasts one hour.
- `get(conversation, id)` returns the saved immutable record after checking conversation ownership, expiry, the preview fingerprint and attachment ownership and content digests.
- `consume(conversation, id, submitFn)` invokes `submitFn(plan)` once for an eligible preview. The callback should submit the configured task and return an object with a string `id`. This method returns only `{id}`, both initially and on subsequent submissions, so executor paths and extra callback data do not become saved preview data.

The planning module never executes a task. Application routing must require the explicit `/submit` action before calling `consume`; its callback is the existing trusted task submission function. Workflow validation must also happen during ordinary task submission so a changed configuration cannot authorize a stale preview.

## Duplicate prevention and recovery

An exclusive claim file prevents two processes from consuming the same preview simultaneously. Successful submissions save the task ID; repeated submissions return that ID. Every callback error retains the claim because an error can occur after the task has already been persisted, such as when writing its archive fails.

Callback errors, process termination, a callback returning no task ID or a failure to persist a successful submission leave the claim in place. A pending claim is never automatically expired or retried. The operator must inspect the task records and reconcile an uncertain outcome before removing a claim or issuing a replacement preview. This conservative behavior prevents an error or crash from silently creating a duplicate task.

Previews bind attachment IDs and SHA-256 digests. Changing an attachment after preview requires creating a fresh preview. Saved fingerprints detect changed preview data; they do not authenticate arbitrary local disk edits by someone who already has access to the workspace.

Run the isolated planner checks with `node --test test/plans.test.mjs`.
