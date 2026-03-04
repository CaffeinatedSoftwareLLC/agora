# agora-collab Modes

Each mode defines the collaboration's goal, default round limit, and required DONE output format.

---

## `plan` — Implementation Planning

**Purpose:** Break a task into actionable steps with owner assignments and constraints.

**Default max rounds:** 6 (3 per agent)

**TURN expectations:**
- Initiator: Propose steps, identify risks, suggest ownership.
- Peer: Challenge assumptions, refine steps, flag gaps.

**CHECKPOINT format:**
```
### Checkpoint
**Agreed steps:** <numbered list>
**Open questions:** <list>
**Unresolved disagreements:** <list or "none">
```

**DONE output format:**
```
## Plan: <task>

### Steps
1. [Owner: <agent>] <step description>
2. [Owner: <agent>] <step description>
...

### Open Questions
- <question>

### Agreed Constraints
- <constraint>

### Risks
- <risk>
```

---

## `review` — Code Review / Audit

**Purpose:** One agent audits code or a proposal; the other validates findings.

**Default max rounds:** 4 (2 per agent)

**TURN expectations:**
- Reviewer (initiator): Post findings organized by severity (critical / warning / nit).
- Author (peer): Respond to each finding — accept, dispute with reasoning, or propose alternative.

**CHECKPOINT format:**
```
### Checkpoint
**Accepted findings:** <count>
**Disputed findings:** <count>
**Remaining to discuss:** <count>
```

**DONE output format:**
```
## Review: <subject>

### Accepted
- [Critical] <finding> → <action>
- [Warning] <finding> → <action>

### Disputed (resolved)
- <finding> → <resolution>

### Deferred
- <finding> → <reason>

### Summary
<1-2 sentence overall assessment>
```

---

## `fix` — Bug Fix / Patch Collaboration

**Purpose:** One agent proposes a fix approach; the other challenges it and checks for regressions.

**Default max rounds:** 6 (3 per agent)

**TURN expectations:**
- Fixer (initiator): Describe root cause analysis, proposed fix, and affected areas.
- Challenger (peer): Identify edge cases, regression risks, test gaps.

**CHECKPOINT format:**
```
### Checkpoint
**Root cause agreed:** yes/no
**Fix approach agreed:** yes/no
**Regression risks identified:** <count>
**Test coverage gaps:** <list>
```

**DONE output format:**
```
## Fix: <bug description>

### Root Cause
<description>

### Fix Approach
<description of changes>

### Files to Modify
- `<path>`: <what changes>

### Regression Checks
- <check>

### Test Plan
- <test to add or run>
```

---

## `discuss` — Open-Ended Discussion

**Purpose:** Exploratory design, tradeoff analysis, or brainstorming without a fixed deliverable format.

**Default max rounds:** 8 (4 per agent)

**TURN expectations:**
- Either agent: Propose ideas, analyze tradeoffs, ask questions.
- Less structured than other modes — prioritize depth of analysis.

**CHECKPOINT format:**
```
### Checkpoint
**Key insights so far:** <list>
**Open threads:** <list>
**Direction leaning toward:** <summary or "undecided">
```

**DONE output format:**
```
## Discussion: <topic>

### Key Conclusions
- <conclusion>

### Tradeoffs Analyzed
| Option | Pros | Cons |
|---|---|---|
| <option> | <pros> | <cons> |

### Recommended Direction
<recommendation with reasoning>

### Open Questions
- <question>
```
