# Job State Machine

```text
CREATED -> VALIDATING -> QUEUED -> PREPROCESSING -> RENDERING
        -> POSTPROCESSING -> EXPORTING -> SUCCEEDED
```

Terminal alternatives from any active state:

- `FAILED`
- `CANCELLED`
- `EXPIRED`

## Rules

1. Active transitions are monotonic and single-step forward only.
2. Successful completion is permitted only as `EXPORTING -> SUCCEEDED`.
3. `FAILED`, `CANCELLED`, and `EXPIRED` are alternatives from any active state.
4. Terminal states have no successors.
5. Replaying an idempotent create command returns the same `jobId` and a
   `JobStatus` body on HTTP 200. The `Idempotency-Key` header must equal
   `JobRequest.idempotencyKey`.
6. `SUCCEEDED` always requires a `manifestId` and progress ratio `1`.
7. `FAILED` always requires an `error` object and forbids `manifestId`.
8. `CANCELLED` always has `cancelRequested: true` and forbids `error`/`manifestId`.
9. Active statuses forbid `manifestId`, `error`, and `finishedAt`.
10. Job event streams have unique, strictly increasing sequence numbers.
