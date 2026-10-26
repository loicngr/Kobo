# Mistral Vibe ACP compatibility evidence

Recorded on 2026-10-22 for the **PATH-resolved Vibe 3.0.1**. This supersedes the
planning observation of Nix Vibe 2.25.0. Both `vibe --version` and
`vibe-acp --version` returned 3.0.1 in an isolated `VIBE_HOME`, with HOME unchanged.
No native installation, credential store, user config or user conversation was
changed. The user approved **native execution only**: Kōbō must reject Plan,
readOnly and Mistral reviewer launches before spawning. Native `ask` is not Plan.

## Reproduce

`fake-agent.mjs` is the deterministic Task 4 subprocess peer, using the same
official SDK as production and never contacting a provider. Its scenario argument
selects normal transport, pending initialize/setup/prompt/close, permission/form
callbacks, load replay, malformed JSON/updates/responses, EOF, diagnostic stderr,
or a deliberately surviving in-group descendant. Runtime tests separately use
fake timers/probes for signal escalation and inspection failures. See
`mistral-vibe/client.test.ts` and `mistral-vibe/spawn.test.ts`; these tests do not
run the native Python probes below.

```sh
# Requires the user's already-installed vibe-acp 3.0.1 on PATH; no provider key.
python3 src/__tests__/fixtures/mistral-acp/native-protocol.py /tmp/mistral-capture.ndjson

# Select the Python interpreter of the existing Vibe 3.0.1 installation.
/path/to/vibe-venv/bin/python src/__tests__/fixtures/mistral-acp/native-restrictions.py

npx vitest run src/__tests__/mistral-vibe/protocol-contract.test.ts
npm run typecheck:tests
```

`native-protocol.py` launches the real CLI twice in a temporary directory. A
stdlib HTTP server on loopback acts as a deterministic, unpaid OpenAI-compatible
provider; a stdlib stdio MCP server returns synthetic launch markers. Environment
inheritance is restricted to PATH/HOME, native state goes under temporary
VIBE_HOME, telemetry/update checks are disabled, and native skills are disabled
for this probe. Provider configuration is supplied only through temporary process
environment. No production config is proposed by this test setup. The production
adapter must inherit native provider configuration and use `auto` unchanged.

`transcript.ndjson` is captured runtime traffic, not fabricated protocol data.
Each line records direction and provenance. Temporary paths, Python executable
path, session IDs and UUIDs are replaced; unrelated available-command updates are
omitted. The source and the transcript contain only synthetic prompts, tool
arguments, answers and markers. The provider receives local native instructions,
but provider requests/system prompts are not retained in the fixture.

The Vitest test replays these frames through the SDK's actual fluent
`client().onRequest().onNotification().connectWith()` and `agent().onRequest()`
APIs. The SDK validates incoming request parameters and updates with its schemas,
but stable fluent responses pass through without response-schema validation.
The test explicitly checks selected response fields: negotiated version, new
session identity, advertised modes/configuration values, terminal outcome and
finite, nonnegative cumulative usage. It compares every received notification's
session, update discriminant and available tool/message identity in order after
setup and prompt completion, allowing SDK normalization rather than byte equality.
A negative test verifies that a malformed update, logged and dropped by the SDK,
fails that completeness assertion even though the prompt succeeds. This is
selected contract coverage, not complete response-schema validation. The separate
native smoke provides execution and MCP evidence. Neither is a paid-provider
certification.

## Verified execution contract

- ACP wire version 1; `agentInfo.version` is 3.0.1 and
  `agentCapabilities.loadSession` is true.
- The isolated install advertises exactly `ask`, `accept-edits`, `auto-approve`.
  Map Kōbō interactive/strict/bypass respectively, only when the selected native
  mode is actually advertised. `configOptions` contains mode/model/thinking.
  A custom profile/admin policy can change effective permissions; retain native
  semantics, never advertise a Kōbō read-only guarantee.
- Native `write_file` (provider argument `path`, not `file_path`) creates a file;
  native `bash` writes another. Both contents are asserted on disk, before and
  after resume. No ACP client fs or terminal capabilities are advertised.
- Real permission callbacks retain only `toolCall.toolCallId`. Prior updates
  contain `_meta.tool_name` and `_meta.effect_kind`; correlate by session and ID.
  The captured offered IDs are `allow_once`, `allow_always`,
  `allow_always_permanent`, `reject_once`. The probe selects only `allow_once`.
  Source `acp/utils.py` also offers scoped IDs for path scopes:
  `allow_session_exact`, `allow_session_directory_recursive`,
  `allow_permanent_exact`, `allow_permanent_directory_recursive`. These scoped
  variants are source observations, not represented as captured requests here.
- Form elicitation is real: `q0` string choices use `oneOf`, `q1` multiple choices
  use `items.anyOf`; both are required. The native wire omits the schema's
  top-level `type`; SDK 2.0.1 supplies `object`. Answers preserve property IDs.
- One prompt per process completes with `end_turn`; a new process loads the
  same native session and replays its prior history before accepting a new turn.
- **Fresh stdio MCP env on resume is proven by an actual call**: the first launch
  returns `first-launch`; after process-group stop, `session/load` supplies a new
  `{name, value}[]` environment and the next MCP call returns `second-launch`.
  Discovery uses a cache and may not spawn the resumed MCP process until its
  first actual call. Checking process startup immediately after load is
  insufficient. Native MCP tools are exposed through discovery plus
  `run_typescript` (`tools.mcp_kobo_probe.env_probe` in this probe).
- Live assistant chunks and tool lifecycle updates pass the stable SDK's incoming
  schemas; terminal responses have explicit selected contract assertions. Replay
  includes tool history and must be suppressed by Kōbō during load.

## Usage and authentication

`usage_update.used` is context occupancy, not consumed input tokens. Cumulative
counts are available in its `_meta.promptTokens`, `completionTokens`,
`cachedTokens` and `totalTokens`. In this capture the first turn ends at input=50,
output=25; load emits that baseline before its response; the resumed turn ends at
100/50. Only compute deltas from an observed valid pre-dispatch baseline.
Source `_send_usage_update` schedules an asynchronous send, so do not assume that
every version/scheduling order supplies the baseline before prompt dispatch.
If absent, omit unavailable counters. Do not infer provider billing from these
synthetic counts or context occupancy.

The native prompt response also includes cumulative `usage`, but SDK 2.0.1's
**stable `PromptResponse` type does not declare it**. It survives because responses
pass through unchecked, not because a response parser validates it. Later adapters
must validate the response fields they consume, including native extensions.
Use validated native extensions or the typed usage update's bounded `_meta`;
do not import private SDK schema paths or silently change to ACP v2. Stable root
exports include `InitializeResponse`, `NewSessionRequest/Response`,
`LoadSessionRequest/Response`, `RequestPermissionRequest/Response`,
`CreateElicitationRequest/Response`, `SessionNotification`, `PromptResponse`,
`McpServerStdio`, and the `CreateElicitationRequest.isForm` guard. Zod schemas are
internal; fluent handlers apply them to incoming parameters/updates, not responses.
Dependency 2.0.1 reuses existing Zod 4.6.7.

An additional isolated real initialization without any API key advertised
`browser-auth`; `session/new` returned JSON-RPC code -32000, message
`Missing API key for mistral provider.`, data null. No onboarding or provider call
was attempted. Missing executable/transport and paid-provider errors remain
adapter tests; do not classify every -32000 response as an authentication error.

## Restricted-launch limit and remaining checks

`native-restrictions.py` exercises actual installed configuration and native
permission resolver code, with socket connections forbidden. It proves:
environment overrides permissive temporary user/project configs; explicit never
denies the tested file and shell operations and removes delegation from the
tested catalogue; remembered whole-tool grants override file permissions;
custom profiles override environment; enforced admin overrides a restrictive
profile. The final native Rust tool-mode projection is `allow` in that admin case.
This is a permission-decision test, not execution of that final mutation or an OS
sandbox test. Vibe 3.0.1 removed builtin Plan and maps the old default to ask.

Source order is defaults/model catalogue/GrowthBook < user < project < VIBE_*
environment < runtime overrides < agent profile < enforced admin.
ACP CLI exposes only --version/--setup. ACP configuration setters accept
mode/model/thinking/max_turns/max_tokens; `_config/schema` exposes schema, not
an effective-permission attestation. These facts explain the approved exclusion.

The native smoke terminates each owned process group with SIGTERM, escalating
to SIGKILL after three seconds. Native ACP embeds its local harness in process;
MCP and shell work create subprocesses. **This probe does not certify full
descendant shutdown, cancellation escalation, macOS or destructive lifecycle
operations.** Those remain the adapter lifecycle tests. Cancelled/limit/refusal
terminal variants, unavailable modes, account quota/authentication failures and
paid-provider behavior are also not runtime-certified by this capture.

Source inspected: installed 3.0.1 `vibe/acp/{entrypoint,agent,utils}.py`,
`core/agents/{models,registry}.py`, `core/config/default_orchestrator.py`,
`app_server/{local,_runtime,_unified_permissions}.py`. The old 2.25.0 upstream
commit is historical planning context only; no result here certifies that version.

Installed-source SHA-256 fingerprints:

| File | SHA-256 |
| --- | --- |
| `acp/agent.py` | `30ad5b3d57cd77f3c36e43cb2920c273a8eb2828ec8416b9ff7b611e7e57d76f` |
| `acp/entrypoint.py` | `473beac8681a04167e0c2156e60b505de64598cf1b8e34dcbfe4fbf14280a21e` |
| `core/config/default_orchestrator.py` | `f7e3f5750634e367203239e65b3256c008c10c723acad2b734e0bd04b3f2f620` |


## Real Kōbō adapter offline smoke (2026-10-23)

**Passed: Vibe 3.0.1, SDK 2.0.1, Linux x86_64, Node 26.12.1.** The target is
3.0.1, not a claim about the latest release. This test invokes the production
`createMistralVibeEngine`, not just a raw ACP client. It uses the installed
`vibe-acp` through PATH, a deterministic loopback SSE provider, a dummy key and
`marker-mcp.mjs` (the existing MCP SDK, synthetic stdio responses only). HOME and
PATH are inherited unchanged from the test process. Both VIBE_HOME and KOBO_HOME
are disposable; provider credentials/configuration from the ambient environment
are removed for the offline child. No install, update, real credential inspection,
production database, source-checkout mutation or remote inference occurs.

Exact command run (2026-10-23, 12:25 Europe/Paris):

```sh
PATH=/home/loicngr/.local/share/fnm/node-versions/v26.12.1/installation/bin:$PATH \
  KOBO_LIVE_MISTRAL_OFFLINE=1 npm run test:mcp:live -- src/__tests__/live/mistral-acp.live.ts
```

Result: **1 passed, 1 skipped**, 15.46 seconds. A final repeat after test-only
formatting/compatibility edits also passed in 15.91 seconds, using the same
command with `KOBO_LIVE_MISTRAL_PROVIDER=0` explicitly set. The skipped test is the separate
real-provider mission. Evidence asserted by the offline test:

- Actual adapter start, prompt acceptance, terminal completion and `runtime.closed`.
- Native file-write denial leaves no file; approval creates the expected bytes;
  native read and form-question/answer paths complete.
- A new process resumes the same native session. Replayed first-turn text never
  reaches the resumed adapter event stream; exactly one new question is exposed.
- An actual resumed MCP call returns `second-launch` instead of `first-launch`;
  the deterministic provider observes each marker in a tool response.
- Interactive, Strict and Bypass each complete with MCP available. Successful
  adapter setup confirms the requested native mode through the real native
  configuration response; this is not a policy/sandbox attestation.
- Native `tools.process.start` starts a known long-lived job. Stop while a native
  question is pending waits for actual runtime closure; the job, native parent
  and all recorded synthetic MCP process IDs no longer exist. Shutdown follows
  the production stdin-EOF/stdout-drain path, not a session-close ACK assertion.
- Plan and readOnly adapter calls reject without changing directory contents.

This verifies the tested **managed** lifecycle only. It does not certify arbitrary
unmanaged descendants, macOS, a paid provider, rate limits/billing, native
credentials or all possible profiles/admin policies. The older Python capture
above has its own signal-based teardown; it is not the adapter shutdown proof.

## Real-provider scenario: opt-in, NOT RUN

Real-provider end-to-end compatibility remains **unverified** and the release gate
stays open. `KOBO_LIVE_MISTRAL_PROVIDER=1` authorizes real inference charges. Supply
native provider authentication/configuration in the server environment (for
example MISTRAL_API_KEY through your secure environment, never in this command
or source). This scenario uses a temporary VIBE_HOME, so it intentionally does
not copy or read a saved native credential file. Existing user HOME/PATH stay
unchanged. The project, worktree and Kōbō database are all temporary.

```sh
# Requires explicit authorization for provider calls; NOT executed for this record.
KOBO_LIVE_MISTRAL_PROVIDER=1 npm run test:mcp:live -- src/__tests__/live/mistral-acp.live.ts
# Optional additional authorization for BOTH handoff providers:
KOBO_LIVE_MISTRAL_PROVIDER=1 KOBO_LIVE_HANDOFF_ENGINE=codex \
  KOBO_LIVE_HANDOFF_MODEL=auto npm run test:mcp:live -- src/__tests__/live/mistral-acp.live.ts
# Separate existing authenticated HTTP/global-stdio dialogue/restart scenario:
KOBO_LIVE_ENGINE=mistral-vibe npm run test:mcp:live -- src/__tests__/live/external-mcp.live.ts
```

The provider scenario bounds each mission at 150 seconds (600-second total test
budget). It requests text/read/edit, deny/allow, one question, managed tasks,
workspace memory and progress; checks rejected Plan/review requests preserve Git
status and start no session; resumes without repeated first-turn assistant text;
and stops a managed job while a question is pending. Optional engine handoff
runs to/from Claude Code or Codex only when its engine/model opt-in is supplied.
Provider compliance is asserted, never assumed; none of these paid scenarios or
handoffs has been executed here.

The external MCP fixture creates a dedicated credential only in its temporary
KOBO_HOME: three dialogue tools, one workspace, 30-minute expiry. HTTP uses
Authorization and global stdio uses KOBO_MCP_TOKEN. No authentication guard is
disabled. `external-mcp-live-fixture.test.ts` passed an unpaid auth-only check:
unauthenticated loopback HTTP is rejected and authorized HTTP/stdio discovery
works without starting an engine.

Default backend Vitest includes only `src/__tests__/**/*.test.ts`; client tests
use their separate config. The live config alone includes `live/**/*.live.ts`.
The native and provider flags default off, so default `npm test`/`test:all` never
schedule these native/provider scenarios. Helpers do not import ignored SDD files.


### Review follow-up (2026-10-23)

The real-adapter offline scenario passed again after adding explicit assertions
that the provider receives `native-file` from native read_file and `One` from
the answered question, on both the first and resumed turns: **1 passed, 1
real-provider test skipped, 14.89 seconds**. Same Linux x86_64 / Node 26.12.1 /
PATH-resolved Vibe 3.0.1 target and explicit offline flag; no paid call.

Fixture cleanup now attempts every owned stop and resource close independently,
restores KOBO_HOME/VIBE_HOME even when cleanup rejects, and preserves original
and cleanup failures in an AggregateError. Unconfirmed runtime shutdown retains
the temporary native directory and reports its path instead of deleting files
that a process may still use. Two deterministic cleanup contract tests cover
rejecting stops/resource closes and original-error preservation without native
inference; the authenticated HTTP/stdio fixture contract still passes.

## Native model and thinking controls (2026-10-23)

The production adapter now reads bounded native `configOptions`, supports flat
and grouped choices, and confirms mode → explicit model → explicit thinking before
prompting. `auto` sends neither model nor thinking setter. The static Auto entry
is only a fallback, not the complete native catalogue. Explicit public ACP
model/thinking setters can persist native preferences; discovery must not call
them. The native setup and review restrictions above remain in effect.

Executed the real adapter offline on Linux with Node 26.12.1, SDK 2.0.1 and the
installed Vibe 3.0.1, using temporary VIBE_HOME/KOBO_HOME and unchanged HOME/PATH:

```sh
PATH=/home/loicngr/.local/share/fnm/node-versions/v26.12.1/installation/bin:$PATH \
KOBO_LIVE_MISTRAL_OFFLINE=1 npx vitest run --config vitest.live.config.ts \
src/__tests__/live/mistral-acp.live.ts
```

Result: 2 passed, 1 paid-provider scenario skipped (27.68 seconds). The added
native-controls scenario verifies discovery in interactive/strict/bypass, native
model-specific thinking (`probe_a`: off/high; `probe_b`: off/low/max), exact
unchanged temporary configuration bytes and zero loopback provider requests during
discovery. A real explicit model/thinking launch persists probe_b/max in that
temporary user config; Auto resumes the same native conversation without changing
those bytes. Exactly two synthetic provider requests serve the explicit launch
and resumed turn. Cleanup confirms native closure before deleting temporary state.
No paid provider, real account switch or real user configuration inspection ran.

### Saved native settings after defaults change (2026-10-23 fix review)

The native-controls scenario additionally changes only its temporary config from
probe_b/max to default probe_a/high and probe_b/low. The saved source still runs
probe_b/max for both Auto/Auto and explicit probe_b/Auto returns. Auto/max resume
preflight defers new-session catalogue membership; the loaded session accepts max.
All five loopback provider requests confirm model probe_b and reasoning_effort max.
The Auto/Auto resume leaves the changed temporary configuration bytes untouched.

Executed the same offline command with `-t 'discovers native model-specific'`:
1 passed, 2 filtered/skipped, 22.61 seconds. No paid provider was enabled.

## Native review permissions (2026-10-23)

The offline adapter scenario now also starts a fresh review with the private
managed review marker in Interactive mode. A scripted loopback provider requests
a forbidden file write despite the review instructions. Native ACP emits an
approval request and remains active; the fixture explicitly denies it, the file
never appears, and physical closure is awaited. This demonstrates native approval
behavior, not a filesystem sandbox or provider obedience to review instructions.
Backend review-return tests separately intercept real orchestrator-created MCP and
memory capabilities for no-return, returning and final reviewers under Automatic
memory mode, exercise read/write authorization and stopping revocation, and resume
native final reviewers in Interactive before returning to the exact source session.
The separately gated paid-provider scenario is still unrun; its rejection check
now explicitly requests unsupported native Plan rather than native review itself.
