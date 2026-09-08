# DWS Source and Download Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DingTalk the only knowledge-body source, remove local/offline and full-library mirror semantics, and support single-file plus directory entries in every audit download manifest.

**Architecture:** `crwu-dws` keeps only directory metadata caching and per-audit body downloads. Audit skills declare DingTalk-internal file or directory paths; the downloader resolves file entries to one document and directory entries recursively, while refusing local-body fallback. Active design documents and a repository contract test keep all consumers aligned.

**Tech Stack:** Markdown Skills and references, Python `unittest`, repository validation scripts.

---

### Task 1: Add a failing source-contract regression test

**Files:**
- Create: `tools/kb/test_dws_source_contract.py`

- [ ] **Step 1: Write the failing test**

Create a `unittest` that scans the active DWS/audit contract files, rejects `CRWU_KB_ROOT`, `M2-B`, `全量镜像`, `本地静态副本`, and `维护/离线归档`, and asserts that `skills/crwu-dws/SKILL.md` defines single-file, recursive-directory, mixed-manifest, and manifest-exclusion behavior.

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m unittest tools.kb.test_dws_source_contract -v`

Expected: FAIL because current active files contain local/offline and M2-B semantics and do not define single-file entries in the M2 manifest contract.

- [ ] **Step 3: Commit the red test**

Run:

```bash
git add tools/kb/test_dws_source_contract.py
git commit -m "test(skills): lock dws knowledge source contract"
```

### Task 2: Update the DWS entrypoint and references

**Files:**
- Modify: `skills/crwu-dws/SKILL.md`
- Modify: `skills/crwu-dws/references/00-目录快照schema.md`
- Modify: `skills/crwu-dws/references/01-镜像与manifest规范.md`
- Modify: `skills/crwu-dws/references/02-缓存与兜底查找规范.md`
- Modify: `skills/README.md`

- [ ] **Step 1: Replace the M2 model**

Make M2 a single per-audit manifest download mode. Remove M2-B, full-library mirror, backup, offline archive, and any local knowledge-body fallback. Preserve M1/M3 directory metadata caching and the rule that cache directories never contain body text.

- [ ] **Step 2: Define manifest entry semantics**

Specify:

```text
file path without trailing slash -> resolve and download exactly that file
directory path ending in slash -> recursively download supported documents below it
one manifest may mix both entry types
files outside the expanded manifest -> do not download
```

Require unresolved paths, unsupported types, and download failures to be reported without local fallback or invented content.

- [ ] **Step 3: Update manifest provenance**

Keep `nodeId`, DingTalk-internal path, `exportedAt`, local working-file path, size, and status for each downloaded document. Describe current-audit files as an audit working set that must be refreshed for every audit, not as a mirror or offline library.

- [ ] **Step 4: Run the contract test**

Run: `python3 -m unittest tools.kb.test_dws_source_contract -v`

Expected: still FAIL only for audit-family and design-document occurrences not yet migrated.

- [ ] **Step 5: Commit DWS changes**

Run:

```bash
git add skills/crwu-dws skills/README.md
git commit -m "fix(skills): make dingtalk the only knowledge body source"
```

### Task 3: Align audit-family consumers

**Files:**
- Modify: `skills/crwu-audit/SKILL.md`
- Modify: `skills/crwu-audit/references/04-待建子技能提案.md`
- Modify: `skills/crwu-audit/references/99-维护说明.md`
- Modify: `skills/crwu-audit-realestate/SKILL.md`
- Modify: `skills/crwu-audit-realestate/references/00-KB装配表.md`
- Modify: `skills/crwu-audit-realestate-rent/SKILL.md`
- Modify: `skills/crwu-audit-realestate-rent/references/00-KB装配表.md`
- Modify: `skills/crwu-audit-datacheck/SKILL.md`
- Modify: `skills/crwu-audit-datacheck/references/00-KB装配表.md`
- Modify: `skills/crwu-audit-optimize/SKILL.md`
- Modify: `skills/crwu-audit-optimize/references/00-优化规范与文件落点.md`
- Modify: `skills/crwu-audit-optimize/references/01-反馈定位与画像流程.md`

- [ ] **Step 1: Replace source-boundary wording**

State that knowledge bodies are downloaded from DingTalk for the current audit and that directory metadata caches cannot provide body text. Remove every active local-static/offline-body fallback statement.

- [ ] **Step 2: Align every assembly table**

Replace directory-only semantics with the shared rule that an assembly table may contain file and directory paths. Use file entries where the table names one exact document; retain directory entries only where the whole directory is intentionally required.

- [ ] **Step 3: Preserve the existing user modification**

Keep the uncommitted review-opinion isolation text currently present in `skills/crwu-audit/SKILL.md`; change only overlapping knowledge-source/download wording.

- [ ] **Step 4: Re-run the contract test**

Run: `python3 -m unittest tools.kb.test_dws_source_contract -v`

Expected: FAIL only for active design documents not yet migrated.

### Task 4: Align active designs and record the change

**Files:**
- Modify: `docs/design-audit-live-kb-protocol.md`
- Modify: `docs/design-crwu-dws.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Update the live-KB protocol**

Define DingTalk as the only body source, remove local-body/offline and M2-B semantics, and document file/directory/mixed manifest entries.

- [ ] **Step 2: Update the DWS design**

Reduce M2 to per-audit manifest download, preserve metadata-only cache, and remove the full-mirror evolution path and body-source precedence chain.

- [ ] **Step 3: Append a changelog entry**

Add a new top entry that records the user-confirmed contract. Do not rewrite old changelog entries because they are historical records.

- [ ] **Step 4: Run the contract test**

Run: `python3 -m unittest tools.kb.test_dws_source_contract -v`

Expected: PASS.

### Task 5: Validate the complete change

**Files:**
- Verify all files changed in Tasks 1-4.

- [ ] **Step 1: Validate affected Skills**

Run `quick_validate.py` for `crwu-dws`, `crwu-audit`, `crwu-audit-realestate`, `crwu-audit-realestate-rent`, `crwu-audit-datacheck`, and `crwu-audit-optimize`.

Expected: every invocation exits 0.

- [ ] **Step 2: Run repository knowledge/Skill validation**

Run:

```bash
python3 tools/kb/kb_tool.py --root /Users/mungdong/code/knowledge-base validate --skill-root skills
```

Expected: no new Skill protocol errors. Existing stale-index errors may remain and must be reported separately rather than hidden.

- [ ] **Step 3: Run final consistency checks**

Run:

```bash
python3 -m unittest tools.kb.test_dws_source_contract -v
git diff --check
git status --short --branch
```

Expected: contract test PASS, no whitespace errors, and only intentional changes plus the preserved pre-existing user edit.

- [ ] **Step 4: Review the final diff**

Confirm the two user requirements are satisfied, active files contain no alternate body source, both path types are supported consistently, and no unrelated files or runtime skill directories were modified.

