/**
 * The memory prompts.
 *
 * Most of the prose below is **verbatim from qodercli**, recovered by decoding
 * the bundle's obfuscated string table (see `docs/qoder-memory-model.md` and
 * `test/inspect-qodercli.mjs --strings`). It is marked `── qodercli verbatim`
 * where reproduced; connective lines this port adds are marked `── port`.
 *
 * Qoder assembles its prompt at runtime from these fragments, so this is not one
 * contiguous original document: it is the same sentences, wired together here.
 * Anything not recoverable is written to the same rules rather than invented
 * behaviour.
 *
 * @module @dsh-external/dsh-memory/memory-prompt
 */

import { MEMORY_INDEX_FILE } from './constants.js'

/** The four kinds, exactly as the recovered prompt spells them. */
export const TYPE_SECTION = `## Memory types

\`type: {{user, feedback, project, reference}}\`

- \`user\`: who the user is (role, expertise, preferences).
- \`feedback\`: guidance the user has given on how you should work, both corrections and confirmed
  approaches; include the why.
- \`project\`: ongoing work, goals, or constraints not derivable from the code or git history;
  convert relative dates to absolute ones.
- \`reference\`: resources in external systems and their purpose.

    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>

    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>

    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]

── qodercli verbatim: Save \`feedback\` or \`reference\` only when it applies across projects.
── qodercli verbatim: Save \`feedback\` or \`reference\` only when it is specific to this project.`

/** Why this mechanism exists, and when NOT to use it. */
export const PURPOSE_SECTION = `── qodercli verbatim

Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.

You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.

- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.

- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.`

/** How to treat a memory whose claim may have gone stale. */
export const STALENESS_SECTION = `── qodercli verbatim

A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer \`git log\` or reading the code over recalling the snapshot.

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it, verify it still exists.`

/** The index is a table of contents, never a dump. */
export const INDEX_SECTION = `── qodercli verbatim

The current ${MEMORY_INDEX_FILE} indexes are already included below. Never Read ${MEMORY_INDEX_FILE}. When changing an index, use its supplied content to write the complete updated index.

Keep each configured index concise: one line per memory, no frontmatter, and at most ⟨lines⟩ lines. Never put memory content directly in an index.

── qodercli verbatim (the recovered string starts mid-sentence; its opening clause is
still undecoded, so only this much is quoted): …lines and under about 25KB. It is an index, not a dump. Each entry should be one line under about 150 characters: \`- [Title](file.md) - one-line hook\`.

- Remove pointers to memories that are now stale, wrong, or superseded.
- Demote verbose entries: if an index line is over about 200 characters, move that detail into the topic file and shorten the index line.
- Add pointers to newly important memories.
- Resolve contradictions; if two files disagree, fix the wrong one.`

/**
 * The placeholder in {@link INDEX_SECTION} that qodercli fills at runtime.
 *
 * Its value is a JS constant interpolated into the prompt, not a string in the
 * bundle, so the string table cannot reveal it — the marker says so rather than
 * inventing a number.
 */
export const INDEX_SECTION_UNKNOWN_LINE_LIMIT = '⟨lines⟩'

/** Search before writing: Qoder's own anti-duplication rule. */
export const SEARCH_SECTION = `── qodercli verbatim

Use memory_search or memory_get first if duplication is likely.

- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.

── port: the two sentences above are Qoder's. Its family is \`memory\` / \`memory_search\` / \`memory_get\`; this deployment names them \`memory_search\`, \`memory_list\` and \`memory_read\`, so \`memory_get\` means "the read tool" here.`

/** How to spend tool calls. */
export const READING_SECTION = `── qodercli verbatim

Read only existing memory files whose full content is required and is not already supplied below. New files never need a prior Read. Do not read every file in a manifest.

- Use \`memory_list\` to see what exists. Do not read every topic file. Use \`${MEMORY_INDEX_FILE}\`, file names, and narrow reads to choose only the files that are likely to need work.
- Spend no more than a few tool rounds orienting. Once the relevant files are clear, move to writing. If nothing needs changing, stop and say so.
- When updating multiple files, issue the writes together when safe.`

/**
 * The write budget this deployment enforces, stated to the model.
 *
 * A `── port` section, not a qodercli string: Qoder states no per-pass write cap (neither the
 * SDK's `SerializableMemoryGenerationOptions` nor the qodercli bundle has one), so this cap is
 * the plugin's own runaway guard. A limit the model is never told about is a trap — a pass that
 * legitimately wanted five files looked like four writes and one refusal, and the panel showed
 * the refusal as a failure. The numbers the toolkit will hold it to are therefore stated here,
 * including the fact that the index counts as one of them.
 *
 * @param budget - `{ maxWrites, maxWriteBytes }`; a non-positive value means "no cap", which
 * is also nothing to teach.
 * @returns the section, or `''` when neither limit is in force.
 */
export function budgetSection(budget) {
  const writes = typeof budget?.maxWrites === 'number' && budget.maxWrites > 0 ? budget.maxWrites : 0
  const bytes = typeof budget?.maxWriteBytes === 'number' && budget.maxWriteBytes > 0 ? budget.maxWriteBytes : 0
  const rules = []
  if (writes > 0) rules.push(`at most ${writes} files per pass across every scope (the index counts as one of them)`)
  if (bytes > 0) rules.push(`at most ${bytes} bytes per file`)
  if (rules.length === 0) return ''
  return `── port (the budget this deployment enforces)

You may write ${rules.join(', and ')}. A write past the budget is not attempted: make the most important changes first, then say in your summary what is left — the next pass continues from your index.`
}

/** The content-file format. */
export const FORMAT_SECTION = `── port (matches qodercli's parser exactly)

A content file lives at the top level of a memory root and starts with front-matter:

\`\`\`
---
name: Build commands
description: How to build and test this repository
type: project
---

The body.
\`\`\`

\`type\` is one of the four kinds; a missing or unrecognized value is read as \`project\`, and a missing
\`name\` falls back to the file name. Update an existing topic file rather than creating a near-duplicate.`

/**
 * The per-scope note Qoder prints for a root.
 *
 * @param root - a resolved root `{ id, path }`.
 * @returns the scope paragraph, or `''` for a custom root id.
 */
export function scopeSection(root) {
  if (root.id === 'user') {
    return `Memory scope: USER (shared across all projects)

This root is for stable cross-project user facts: identity, long-lived preferences, collaboration style, and reusable workflows. Do not store project-specific implementation details here. When several small \`type: user\` files describe the same person/profile area, prefer merging them into a single canonical user profile or preference file and tombstoning the superseded fragments.`
  }
  if (root.id === 'project') {
    return `Memory scope: PROJECT (only this project)

This root is for project-specific facts, repo paths, debugging conclusions, commands, and workflow preferences tied to this project. Do not move project-only facts into USER scope.`
  }
  return `Memory scope: ${String(root.id).toUpperCase()} (a custom root at \`${root.path}\`)`
}

/**
 * The auto-memory system prompt used for one generation pass.
 *
 * @param roots - the resolved roots.
 * @param customPrompt - the operator's `generation.prompt`, when set.
 * @param budget - `{ maxWrites, maxWriteBytes }`, taught as the enforced budget.
 * @returns the instruction text.
 */
export function autoMemorySystemPrompt(roots, customPrompt, budget) {
  const rootLines = roots.map((root) => {
    const index = root.indexFile !== undefined ? `, index file \`${root.indexFile}\`` : ', no index file'
    return `- id "${root.id}": ${root.access}, at \`${root.path}\`${index}`
  })
  const scopes = roots.map(scopeSection).join('\n\n')
  const operator =
    typeof customPrompt === 'string' && customPrompt.trim().length > 0
      ? `\n\n── operator policy for this deployment\n\n${customPrompt.trim()}`
      : ''
  return [
    'You maintain long-term memory for an AI coding assistant.',
    '',
    PURPOSE_SECTION,
    '',
    TYPE_SECTION,
    '',
    FORMAT_SECTION,
    '',
    INDEX_SECTION,
    '',
    SEARCH_SECTION,
    '',
    READING_SECTION,
    '',
    budgetSection(budget),
    '',
    STALENESS_SECTION,
    '',
    `## Roots\n\n${rootLines.join('\n')}\n\n${scopes}${operator}`,
  ].join('\n')
}

/**
 * The consolidation (dream) system prompt.
 *
 * @param roots - the resolved roots.
 * @param budget - `{ maxWrites, maxWriteBytes }`, taught as the enforced budget.
 * @returns the instruction text.
 */
export function dreamSystemPrompt(roots, budget) {
  const directory = roots.map((root) => `- \`${root.path}\` (root id "${root.id}")`).join('\n')
  return [
    '# Dream: Memory Consolidation',
    '',
    'You are performing a dream: a reflective pass over persistent memory files. Synthesize what you learned recently into durable, well-organized memories so future sessions can orient quickly.',
    '',
    `Memory directory:\n${directory}`,
    '',
    '---',
    '',
    '## Operating Budget',
    '',
    '- Work in batches: when several file reads are independent, request all of them in the same assistant turn.',
    `- Do not read every topic file. Use \`${MEMORY_INDEX_FILE}\`, file names, and narrow reads to choose only the files that are likely to need consolidation.`,
    '- Spend no more than a few tool rounds orienting. Once the relevant files are clear, move to writing. If nothing needs changing, stop and say so.',
    '- When updating multiple files, issue the writes together when safe.',
    '',
    budgetSection(budget),
    '',
    '## Phase 1 - Orient',
    '',
    '- Use `memory_list` to list top-level memory Markdown files when needed.',
    `- Read \`${MEMORY_INDEX_FILE}\` only if it was not supplied. It is supplied below, so do not read it.`,
    '',
    '## Phase 2 - Look For Signal',
    '',
    '1. Facts that contradict or supersede what is already recorded.',
    '2. Topics that have grown large enough to split, or small enough to merge.',
    '3. Recent repeated preferences, workflows, commands, paths, IDs, or debugging conclusions that would help a future session.',
    '',
    'Do not exhaustively read transcripts. Look only for things you already suspect matter.',
    '',
    '## Phase 3 - Consolidate',
    '',
    "For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the file format and type conventions below.",
    '',
    'Focus on:',
    '',
    '- Merging new signal into existing topic files rather than creating near-duplicates.',
    '- Converting relative dates like "yesterday" or "last week" to absolute dates.',
    '- Deleting or correcting contradicted facts at the source.',
    '- Keeping memories operational: exact repo paths, commands, artifacts, and verification evidence matter more than vague summaries.',
    '',
    '## Phase 4 - Prune And Index',
    '',
    INDEX_SECTION,
    '',
    'Return a brief summary of what you consolidated, updated, or pruned. If nothing changed, say so.',
    '',
    '---',
    '',
    TYPE_SECTION,
    '',
    FORMAT_SECTION,
    '',
    // Verbatim from qodercli, and the sentence that makes deletion part of the
    // model's job rather than an operator-only action.
    'Only create, edit, or delete memory files and indexes in directories marked read-write; directories marked read are read-only.',
    '',
    'Pruning is deletion, not abandonment: when a memory is stale, wrong, or superseded,',
    'delete the file and rewrite the index without its entry. A file left behind still',
    'matches searches, still counts against the context budget, and can be pointed at',
    'again by mistake — so never claim a memory is retired while its file remains.',
  ].join('\n')
}
