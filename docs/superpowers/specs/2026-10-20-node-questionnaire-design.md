# Persistent node questionnaires

Approved in chat on 2026-10-20 after fourteen product decisions. Implementation reference for this change; not a replacement for current operating documentation.

## Goal and accepted behavior

Nodes publish all currently known employee-answerable blockers as typed questions. Text, textarea, number, date, single choice, multiple choice and boolean controls render in node details. All applicable mandatory questions must have valid answers before one complete submission. Unknown is an explicit answer with a reason, never an automatic acceptance.

Questions, accepted submissions, editable saved drafts, supplemental notes and correction history live together in the current task's SQLite JSON. Refresh, restart and task switching restore them. New tasks never inherit old task answers. Previously answered questions remain rendered and editable. Submission includes all current applicable answers, edited previous notes and a new optional note. Answer persistence precedes model execution; model failure must not erase a successful submission.

Material facts and employee answers retain separate provenance. Conflicts block rather than silently overriding material evidence. Correcting an accepted answer invalidates affected downstream receipts/results while preserving their history and unrelated answers. Stable question identity is node + field; question version records semantic changes. Changed types/options/constraints or explicit meaning-version changes require reconfirmation; cosmetic prompt changes alone do not. Explicitly inapplicable questions require a reason and remain historical, excluded from active answers. Reappearance requires revalidation.

Drafts can be edited while a node is executing, but cannot be submitted until execution has stopped. Optimistic questionnaire versions prevent another tab from silently overwriting answers or drafts; local conflicting edits survive and require explicit reconciliation. Duplicate submissions are idempotent. Repeated unanswered blockers must not cause automatic execution loops or newly invented duplicate questions.

Technical failures and unavailable capabilities remain system failures with recovery instructions; they do not become fabricated employee questions. Legacy supplemental strings retain their text, node and revision; only reliably attributable existing structured question/answer records migrate. Do not infer missing question types from prose.

Input/output sections are separately collapsed by default. Question decisions and feedback stay visible. Clear requires two employee clicks and confirmed execution quiescence, then deletes the current SQLite row and checkpoints, including drafts/questions/history. No question archive survives clear. Existing artifacts and other tasks remain intact.

## Architecture

Use a focused host-neutral questionnaire model and validation module. Expose an optional questionnaire projection in snapshot/progress for legacy compatibility. Add closed `questions-draft` and `questions-submit` actions to the existing transport; drafts bypass the execution queue but remain ownership/version checked. Formal submissions use the current authenticated workflow queue. A saved questionnaire owns its own optimistic version, independent of graph revision, and is persisted through the existing RunDTO into the current SQLite row.

Stage inference gets the complete effective answers plus material context. Its strict output accepts a typed questions collection. Host validation admits questions and creates an employee wait before computation. Model questions cannot override fixed program validation or privileged operations. Existing legacy clarification remains compatible and is admitted into the same stored questionnaire rather than being discarded when its transient clarification is cleared.

No new external commands, dependencies, runtime configuration changes, commits or publication. Source and all previous uncommitted work are preserved. Increment Workbench protocol for the changed wire contract. macOS is the available validation platform; do not claim Windows verification.

## Acceptance

Prove red then green: A answered, B asked, A still restored/editable and resubmitted with B; unknown required answers do not pass a node; choices/boolean false/numbers/dates validate; changed definitions reconfirm; inapplicable answers stay visible but are excluded; stale-tab writes preserve edits and fail; drafts survive restore but do not enter model facts; model failure preserves saved submissions; running drafts are allowed while submit is refused; technical failure generates no employee form; clear deletes the saved questionnaire with the task. Browser checks exercise real drawers, collapsed IO, all mandatory validation, old answer corrections, autosave feedback and reload.
