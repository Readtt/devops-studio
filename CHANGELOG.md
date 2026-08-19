# Changelog

All notable changes to DevOps Studio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release workflow extracts the section matching the pushed tag and uses it
as the GitHub release body, so keep the heading format exact: `## [x.y.z] - YYYY-MM-DD`.

## [0.22.1] - 2026-08-19

### Changed

- Commit Review findings are now written to be understood in one read. Each finding opens by tying your change to what now goes wrong, explanations are capped at two short paragraphs of plain full sentences — no fragments, no arrow-chain shorthand, no markdown artifacts — and evidence is a short file:line trace of what was actually checked instead of a wall of text.
- Finding titles state the consequence: declaratively when the failure was fully traced, as an explicit "can ..." when it depends on a situation the review didn't confirm. Maintainability findings state their ongoing cost instead of an invented failure.
- Generic filler that only sounds helpful is banned from findings, and in a multi-commit review every finding names the commit it concerns.

## [0.22.0] - 2026-08-19

### Added

- **DevOps Studio now works across several repositories at once.** The app used to point at exactly one source folder, so a feature whose code spans repositories was analyzed against a fragment of itself — silently, with nothing to tell you coverage had been lost. Settings now holds a list of source repos, and every surface that reads code reads all of them: the generator, Suite Chat, Commit Review, confidence evaluation, the code viewer and the terminal. Your existing source folder migrates by itself into a one-repo workspace, and at one repo the app looks and behaves exactly as it did.
- **A Source repos block in Settings** — add a folder, rename it, remove it, or point "Scan a folder…" at a parent directory and pick up every repo cloned inside it in one go. Each row shows the repo's current branch and which Azure DevOps repository it's bound to. This also closes the dead end where opening a commit review with nothing configured sent you to a Settings tab that had no source-directory control at all.
- **The status bar shows and switches the branch of every repo.** Past one repo the folder segment reads "N repos" and the branch segment summarises where they are — the shared branch when they agree, "N branches" when they don't — opening a list you drill into per repo. Repos move independently: a switch running in one can't cancel or steal the toast of one running in another, and the dirty-tree prompt asks about one repo at a time and names it.
- **Commit Review spans the whole workspace.** The commit picker merges every repo's history into one timeline, so a change that touches three repositories can finally be reviewed as one change. Every repo is guaranteed a share of the list, so a repo nobody has touched in months stays reachable instead of being crowded out by the busy ones. Which repos the reviewer may *read* is a separate control from which commits are under review — a commit in one repo often can't be judged without reading another that has no commit in the selection at all.
- **Runs can be narrowed to the repos you care about.** The generator, Suite Chat and Commit Review each carry a Repos chip row (shown past one repo): every repo is on by default, and unticking one keeps that run out of it. The generator persists the choice into its checkpoint, so a resumed run keeps the scope it started with instead of quietly widening back to everything.
- **Published code links now deep-link into the right Azure DevOps repository.** Each source repo binds to its ADO repo and project, matched from the repo's own `origin` remote against your organisation's repository list — normalised URL first, then the project and repo parsed out of either URL shape (SSH and legacy `visualstudio.com` remotes never string-matched the HTTPS one), then a folder-name match that must be unique across the organisation, so a name two projects share is left unbound rather than bound to the wrong one. Every link into a repository living outside the connection's project was previously dead. Settings' repo row is the manual override, with a repository picker grouped by project and a "Detect from remote" action.
- **"Get source code…" is reachable once you already have a repo.** It used to hang off the status-bar segment that only appears when *no* repo is configured, so it vanished the moment a tester had one. It's now in the repo list footer, in the Settings source-repos block, and still in the empty state.
- **The custom-provider Test button now performs a real model call.** It fired a bare reachability ping that discarded the response, sent no authorization header, and reported "Reachable — server responded" for any reply at all — so a wrong key, a 404 and a 500 all read as success, and the model ID was never exercised. Test now runs the same one-token generation a real run would, against the base URL, key and model you've drafted, and reports what actually came back. The Model ID field also suggests the models your endpoint lists, while still accepting anything you type.
- **The AI's read-only git access is considerably wider** — 31 subcommands instead of 19, so it can answer questions with `for-each-ref`, `show-branch`, `check-ignore`, `check-attr` and the diff plumbing rather than working around their absence. Write forms remain blocked outright, and `ls-remote` stays out because it reaches the network, where a credential prompt can hang the call.

### Fixed

- **The AI's read gate could be escaped three ways, and each is now closed.** A symlink or junction inside a repo (`vendor/cache` pointing at your home directory) made every file on the machine readable through a path that looked entirely repo-local — the gate checked the literal path and the read followed the link. It now runs on the resolved path, and the read uses that same resolved form so it can't land on a different file than the one just cleared. Separately, files the app refuses to open by name were still readable through the command runner (`cat .env`, `git show HEAD:.env`, `git log -p credentials.pem`), and the source-code exemption that keeps `Credentials.cs` readable also let `.env.ts` and `.npmrc.js` through. Finally, `git --git-dir=C:\…\other-repo\.git log` pointed the whole command at a different repository, because the guard checking for escapes never looked at a path glued to a flag.
- **Every Azure DevOps deep link built from a published source link was dead.** Publishing escaped each `/` in a path or branch name and nothing ever unescaped it, so the links read back mangled. Two more defects in the same block: unticking "Tag with source branch" — or generating from a non-git or detached-HEAD folder — published links the app itself then refused to read back, and the commit stamp was written empty even though publish had already captured it.
- **Code links were stamped with the wrong repo's branch.** A case citing two repositories recorded both links against whichever repo happened to be first. Each link now carries the branch and commit of the repo it actually names, read from that repo's working directory at publish time, and one unreadable folder only costs its own links their stamp.
- **Confidence verdicts read as permanently stale, and every bulk run re-scored the whole suite.** A verdict was compared against a single repo's HEAD regardless of what it had read, so past one repo the "skip verdicts that are still fresh" gate never fired — on the app's most expensive path. A verdict now records the repos its own evidence cites and goes stale only when one of those moves. Re-checking that also used to cost a git call per repo per case; a bulk run resolves it once.
- **A suggested fix could be written into the wrong repository.** Commit Review's Apply button resolved the patch path against whatever the status bar pointed at rather than the review's own repos.
- **Reopening a saved review bound it to whatever repo was current** instead of the repos it was actually run against.
- **A terminal's Quick Prompts injected another repo's base branch** into its templates, because the strip read the global source folder rather than the shell's own working directory.
- **Assignee pickers kept offering the previous project's people** after a connection change. The roster is per project and was cached for the whole session, so the names on offer weren't assignable on the work items being created.
- **Azure DevOps errors lost the detail that explains them.** A rate-limited request reached you as "retry in undefineds" and a server error dropped the excerpt saying what ADO had actually rejected — the error fields were serialized in the wrong case for the frontend reading them.
- **The AI wasted steps on programs that aren't there.** Six of the tools its prompts advertised don't exist on a stock Windows PATH, and `find` and `tree` resolve to unrelated Microsoft binaries of the same name, so `find . -name "*.ts"` failed as "FIND: Parameter format not correct". Each attempt burned a step against the run's budget and stayed in the transcript to be re-sent on every later one. The prompts now lead with git and the app's own read tools, and a missing program points at the tool that replaces it. This worked in development and failed in the shipped app, which is why it survived so long.
- **A generated case could be dropped silently** when the model followed the new path convention, leaving a run that produced nothing and no explanation.
- **A repo-scope chip could re-include repos you had deselected**, when the registry had changed underneath it.
- **Code search hid whole repositories.** Search results were concatenated per repo before being truncated, so one repo's eighty matches could bury another's entirely; they're now interleaved.
- **The settings file was rewritten and broadcast on every launch**, because the saved repos and the freshly-normalised ones were compared as text and their keys came back in a different order.
- **The empty state mounted two copies of the Get source code wizard**, so a request from the Settings window opened one while a click opened the other.
- The branch picker hid any saved-but-unlisted branch whose name appeared inside its "current branch" sentinel value — a real branch called `current` vanished from the list rather than being added to it.

### Changed

- **Files are addressed as `<repo>/<path within repo>` throughout** — in prompts, in the model's answers, in code links, in the code viewer's header and in tab titles. Tab titles only pick up the prefix when two open viewers collide on the same filename.
- **A bare filename opens the copy in the repo that owns it.** The code viewer searches every configured repo instead of silently opening the first one's.
- **There is no fixed tracking-branch option any more.** Code links always track the live branch of the repo each link names; a repo with no branch (detached HEAD, or not a git repo) publishes without one rather than claiming a `main` you never generated from. The per-run "Tag with source branch" switch still controls whether any provenance is stamped at all.
- **The status bar's folder segment opens Settings past one repo**, since picking a directory there would collapse the workspace to that single folder.
- Every repo-git reader shares one poll instead of running its own timer over the same folders.
- A run interrupted by an older version can't be resumed after updating to this one — the saved checkpoint format changed. Interrupted runs started on 0.22.0 onwards resume as normal.

## [0.21.1] - 2026-08-11

### Changed

- Bug report sections now use standard professional headings — SUMMARY, PRECONDITIONS, STEPS TO REPRODUCE, REQUIRED TOOLS (only when a tool is needed), EXPECTED RESULT, ACTUAL RESULT, TECHNICAL NOTES, and ENVIRONMENT — replacing the casual labels introduced in 0.21.0. PRECONDITIONS remains numbered setup steps, and technical detail remains confined to TECHNICAL NOTES.
- Generated wording keeps the plain-language rules but is now explicitly held to a professional documentation tone.

## [0.21.0] - 2026-08-11

### Changed

- Generated test cases and bug suggestions are now written in plain language a QA tester can follow from the running product alone — no unexplained abbreviations or codes, technical terms explained in plain words on first use, and every exact value and button name kept.
- Test cases walk through their own setup: preconditions are numbered setup steps at the start of the case (with the exact account, data, and settings), instead of a state the tester has to figure out how to reach.
- Bug suggestions use a new section layout: WHAT IS BROKEN, SETUP BEFORE YOU START, STEPS TO REPRODUCE (written for a tester with only the running product — no source code, no debugger), TOOLS NEEDED (only when a tool is genuinely required, with plain setup instructions), EXPECTED RESULT, ACTUAL RESULT, NOTES FOR DEVELOPERS (root cause and code references live here), and ENVIRONMENT.
- Bug titles now lead with the visible problem in plain words, readable by both testers and developers.
- Suite Chat follows the same plain-language rules and bug layout when it creates or rewrites cases and bugs from chat.

## [0.20.0] - 2026-08-11

### Added

- **Runs are budgeted by what they cost, not by how many steps they take.** A generation, review, or chat run used to stop after a fixed number of reading steps — which cut a cheap run off early and let an expensive one spend far more than you'd expect. Every surface now has a token budget, priced so a cached read costs what a cached read actually costs, and the step count is only a runaway guard. The run header shows what a run has spent against that budget while it works.
- **Long runs no longer run out of room.** The app measures the real size of every request instead of estimating it, caps what any single file read or pasted block can contribute, and — once a run gets genuinely long — replaces its oldest file reads with a short note telling the model how to fetch that file again if it still needs it. Recent reads are always kept intact. If that still isn't enough, the middle of the conversation is summarised by the cheapest model you have a key for, so the expensive one keeps working instead of hitting the wall.
- **A run that dies can be picked up where it stopped.** Rate limits, dropped connections, a request that didn't fit, or an answer that overran the model's output limit used to lose everything the run had read. Each of those now leaves a resume point: click Resume and the model carries on from its own notes rather than re-reading your codebase. An answer cut off by the output limit retries with more room to write, and a request that was too big comes back smaller than the one that failed. Applies to the generator, its follow-up rounds, and Commit Review.
- **The generator finishes an empty run by itself.** The worst failure this app had was a run that read your code for twenty-odd steps and then wrote nothing — all of the cost, none of the output. It now replays what it read with an instruction to stop reading and write the batch, automatically, before any error is shown. You get test cases instead of an error and a button. A run that stopped because it hit its budget still asks first, because that one wanted more reading rather than less.
- **Follow-up rounds remember each other.** The review pane showed you every follow-up you'd sent and what each one changed, and none of it reached the model — so a round could cheerfully undo the round before it. That history is now part of the prompt, and a follow-up is metered as a continuation of the run it refines rather than as a fresh one.
- **The Ask remembers what it read.** Asking a follow-up question about a draft used to re-read every file from scratch. The conversation now carries the model's own reads with it, and the draft it's shown includes the code references and full repro steps the generator already wrote down — so "explain bug 2" no longer costs sixteen tool calls to recover something the app already knew.

### Fixed

- **The default model failed on every run.** A stale provider package treated Claude 5 as a model it had never heard of, so it forwarded a sampling parameter Anthropic rejects outright, capped answers at 4,096 tokens, and quietly downgraded structured output. Output limits are now decided per model in the app's own config, where a newly launched model can be described the day it ships instead of waiting for a provider release to catch up.
- **Every turn of a chat re-bought the entire conversation.** The thread was rebuilt as prose in the middle of each request — exactly where a prompt cache stops matching — so nothing past the system prompt could ever be a cache hit. Requests are now assembled so each turn extends the previous one, with cache markers where they pay for themselves.
- **A chat turn that stopped without answering showed you its own thinking instead.** When the model spent its reading budget and never reached the answer, you saw "I'll dig into the collect code…" presented as the reply. It now finishes from what it already read and gives you the answer. Both the review-pane Ask and Suite Chat.
- **A run that came back empty could hand you a draft the model had abandoned.** Anything batch-shaped in the model's mid-run thinking could be picked up and presented as the result — publishable to Azure DevOps, or shown in Commit Review as a verified finding with a patch to apply. Only the model's actual final answer is read now.
- **Resume threw away the reads it exists to preserve.** Continuing a failed run handed the model "go read this file again" for most of what it had already read, so it spent the continuation re-reading your code. It carries the full record forward now, and only trims when the run failed because the request was too big to send.
- **Resume was offered when it couldn't possibly work.** A first request too large to send had nothing to continue from, but still showed the button — and clicking it sent the identical request, failed on the spot, and charged you for it.
- **A partly-broken answer no longer loses the good half.** An answer cut off mid-structure keeps the complete cases and bugs that arrived before the cut instead of dropping the batch, and an answer that restated the format before writing the real one no longer gets mistaken for the example it opened with.
- **The generator ignored a case count you asked for.** "Give me 5 cases" produced whatever the model felt like. It also now scales how hard it investigates to the size of what you asked for, rather than always going deep.
- **The broad "where does this live" search under-reported.** It stopped counting at a fixed number of matching lines, so a symbol used heavily in one file came back as "1 file matched" when it was used across twenty.
- **The summariser could replace the question you asked** with a paraphrase of it, on long chat turns.
- Turning code search off between two questions in the same chat made every later question fail with a provider error until you turned it back on.
- A chat answer you stopped halfway was forgotten by the next question, so "keep going from where you stopped" started over.
- A follow-up round could be told that a previous round had reworked bugs it never touched, whenever you'd unchecked a case in the draft.
- A failed run and a silent one are now told apart: the error says whether the model hit its output ceiling, ended its turn without writing, or was cut off mid-read — instead of sending everyone to the same JSON-mode setting.
- The context warning reflects the real size of a request rather than an estimate, so it stops crying wolf on runs with plenty of room left.

### Changed

- Chat answers settle to the answer. While a question is being worked on you see the model's progress and the files it's reading; once it lands, the message shows the answer alone rather than the thinking that preceded it.
- The run header reads at a glance — model, elapsed time, what the run has spent, and what stopped it.

## [0.19.0] - 2026-08-03

### Added

- **Requirement-based test suites.** Azure DevOps has three kinds of test suite and the app only ever understood one of them. You can now create a suite bound to a user story or PBI — right-click a plan, **New suite** → **Requirement-based**, pick the work item — and every case you publish into it links back as **"Tested By"**. That link is the only thing ADO's requirement-coverage reporting reads, so suites created this way show up in coverage instead of sitting outside it. The requirement picker only offers work-item types your project actually treats as requirements, which is process-template dependent and read from your project rather than hardcoded.
- **The generator and Suite Chat now write cases against the requirement.** When a suite tracks a work item, its description and acceptance criteria are handed to the model, which is told to prefer one case per criterion and to say so plainly when a criterion is untestable as written rather than inventing scope. Suite Chat answers coverage questions against those same criteria and names the ones nothing covers — "looks well covered" isn't an answer when a criterion is unaddressed. Both surfaces render the requirement from one shared block, so a coverage answer is always judged against the same text the cases were generated from.
- **Confidence evaluation is graded against the requirement too.** A case in a requirement-bound suite is now scored knowing the acceptance criteria it was written for, so a step whose expected result contradicts a criterion reads as a real risk instead of an unknown.
- **Query-based suites are recognised and protected.** ADO fills these from a work-item query and refuses anything added by hand. Generate, publish, and the Suite Chat create/delete actions are now disabled on them with an explanation of why, rather than letting a full generation run finish and then failing at publish with an opaque server error. Requirement suites likewise refuse renaming and child suites — ADO derives their name from the work item and only nests under static suites.
- **REQ and QUERY badges** on suites throughout the app — the plans tree, the command palette, the generator's target chip, and the generation history — so you can tell at a glance what kind of suite you're about to generate into.

### Fixed

- **A bug's repro steps could silently lose text.** Any `<` in a work item — an acceptance criterion reading `qty < 10 and total > 5`, say — swallowed everything up to the next `>` when the HTML was converted to text, so the model was handed `qty  5` and wrote cases for a requirement nobody had written. Script and style blocks also survived as prompt text, unclosed list items ran two criteria together on one line, and the numeric entities Word and Outlook paste in (`&#8217;`, `&#8212;`) reached the model undecoded.
- **The app could close silently — no error, no dialog — on text containing non-ASCII characters.** Two paths did it: a suite or case whose data Azure DevOps returned in an unexpected shape, and any Azure DevOps error message long enough to be shortened for display. Since error messages routinely quote your own work-item titles and project names, this was reachable by anyone whose ADO content isn't pure ASCII. Both now shorten safely, through one shared helper so a third copy can't reintroduce it.
- Pasting a screenshot into a work item no longer sends the whole embedded image to the AI as if it were requirement text, and pasting a very large document no longer freezes the window while that text is prepared for a prompt.

### Changed

- Newly created static suites now explicitly inherit the plan's default configurations, matching what the Azure DevOps web UI does when you create a suite there.
- Work-item text sent to the AI is now explicitly marked as data rather than as instructions. Descriptions and acceptance criteria are editable by anyone with access to your Azure DevOps project, and they reach prompts that can read your source, so the model is told plainly to treat that text as the requirement to test and never as directions addressed to it.
- Dialogs no longer stretch past their own edges when they contain something long, like a work-item title.

## [0.18.0] - 2026-08-03

### Added

- **Follow-ups in the review phase are resumable.** "Ask follow-up" was the last AI run in the app that could still lose your work: a rate limit, an accidental ESC, or quitting mid-round threw away the whole tool loop, and you had to retype the instruction and pay for it again. Follow-ups now checkpoint every agentic step, exactly like the generator's analyze pass and Commit Review. An interrupted round comes back as a **Resume** card — or a Resume button inside the failure notice when there's an error to explain — and continues on the model it started with, so the steps you already paid for aren't re-run. Your draft only changes if the round completes. Quit with one running and it's still there when you reopen the draft from History.

### Fixed

- **A follow-up that ran out of steps used to report "the model returned an empty refine result".** It's now recognised for what it is — the loop never got as far as writing the revised draft — so it's resumable with a top-up budget and an explicit "finish with what you've read" instruction, instead of reading as if the model had nothing to say.
- **A follow-up could get stuck on its "running" strip forever.** If something failed while the request was still being assembled — no API key configured, an unreachable work item — the error escaped without ever clearing the running state, leaving the composer spinning with no way back.

## [0.17.0] - 2026-08-03

### Added

- **Copy suite link.** A suite's context menu can now copy its Azure DevOps URL, for pasting into a ticket or chat instead of opening it yourself.

### Fixed

- **Published test cases now show up in Azure DevOps' Execute tab.** Execute lists *test points* (test case × configuration), not suite entries — and ADO creates those from the suite's default configurations. A suite with none (inheriting none from its plan) accepted the case and created zero points, so it appeared in ADO's Define tab and in the app's suite list but was invisible under Execute. Publishing now confirms a test point exists and assigns a configuration explicitly when one is missing, so generated cases are runnable. When it genuinely can't be fixed — no configuration exists in the project, or the suite is query/requirement-based — the case still publishes and the publish log explains what to do, including when it means a chosen run outcome went unrecorded.
- **The Settings window can no longer reopen unusably small.** Its size was being saved in physical pixels and restored as logical ones, so a size stored on one display came back divided by the scale factor on a differently-scaled one (720×520 at 100% reopened as 360×260 at 200%). Because the window was also fixed-size, there was no way to drag it back. Settings geometry is no longer persisted at all, which also neutralises any bad size already saved on disk.

### Changed

- The Settings window is resizable, with a sensible minimum, and shrinks to fit when it opens on a display too small for its preferred size.

## [0.16.3] - 2026-07-30

### Fixed

- **A code search that filtered out every file looked identical to a search that
  found nothing.** `grep`'s file count is taken after its glob filter is applied,
  so a glob matching no files reported "0 matches" with nothing read — and the AI
  would conclude the code didn't exist. It now says the glob excluded everything,
  and explains the ways a glob silently matches nothing: a leading `./` or `/`,
  case sensitivity, and directory prefixes that must exist at the top level of
  the repo.
- **The tool activity strip hid the glob a search was scoped to**, showing only
  the pattern, which made an empty result impossible to explain. Searches now
  show their filter.
- **`run_command` rejected pipes and redirection with the wrong error.** There is
  no shell behind it (deliberately — it's read-only), but shell syntax was passed
  through to the program, which failed with its own confusing message: a piped
  `git show` came back as "invalid object", so the AI would blame the commit hash
  and retry against other commits instead of dropping the pipe. Pipes,
  redirection and command substitution are now refused up front with the actual
  reason. Regex alternations like `rg "class A|class B"` still work.

## [0.16.2] - 2026-07-30

### Fixed

- **The AI could not list files in your source directory.** The shared
  `list_files` tool — used by Suite Chat, Commit Review, the Test Case
  Generator, and Confidence — failed in three ways at once:
  - A model that passed an empty-string sub-directory (which the tool's own
    description invited) got `not a directory: <source root>""` back and
    could never get a listing to work.
  - Every successful listing was reported as **"0 entries"** in the tool
    activity strip, no matter how many files came back, because the strip
    read the wrong field off the result. Listings now show their real count
    ("247 files", "120+ files" when capped) and the paths themselves.
  - Each listing row was labelled `list_files list_files` instead of naming
    the directory being listed.
- `read_file` no longer fails when a model wraps the path in quotes.

## [0.16.1] - 2026-07-30

### Fixed

- **BYOK runs failed on every AI surface with Anthropic keys.** Generator, Suite
  Chat, Commit Review, and Confidence all returned a 400 —
  ``​`temperature` is deprecated for this model`` — against Claude Sonnet 5 and
  Claude Opus 5. Sonnet 5 is the default model, so a new user's very first run
  died. The runner no longer sends `temperature` to models whose API removed it.
- **Anthropic runs were capped at 4096 output tokens and used degraded
  structured output.** The bundled Anthropic provider predated the Claude 5
  models and treated them as unknown, falling back to a 4096-token ceiling — for
  models that support 128k — which truncated long generations into "the model
  returned nothing" and "no findings" results. Upgraded the provider so both
  models are recognized.
- **A bad key, an empty credit balance, or any provider 400 could be reported as
  "the model returned nothing."** On structured runs with code search off, real
  provider failures were mistaken for malformed model output and swallowed by
  the schema-repair loop, hiding the actual message. The provider's own error now
  reaches the error panel, with the Resume affordance intact.

### Changed

- Sampling-param support is now a per-model property in the model catalog,
  applied in front of every provider rather than delegated to each provider SDK
  — gateway and custom OpenAI-compatible endpoints forward requests verbatim and
  have no such knowledge. Curated OpenRouter routes to frontier Anthropic and
  OpenAI models carry the flag too.
- As a fallback for custom endpoints and models newer than the app, a run that
  is rejected specifically over a sampling parameter is now retried once without
  it instead of failing outright.

## [0.16.0] - 2026-07-29

### Added

- Interrupted AI runs now resume instead of restarting. Generator analyzes and Commit Reviews checkpoint every agentic step to disk; a run stopped by a quit, crash, rate limit, dropped connection, closed tab, or the Stop button offers a one-click **Resume** that replays the saved transcript — the investigation steps you already paid for are never re-run.
- Interrupted runs are impossible to lose. Reopening the app lands a Commit Review tab directly on its interrupted review (inputs, activity log, and Resume restored — no digging through History), a restarted Generator tab restores its run the same way, and runs whose tab was closed appear as **interrupted** rows in History with open-to-resume and discard actions.
- Structured error panels on both AI surfaces: failures are classified (missing key, rejected credentials, out of credits, rate limit, provider overload, network, context overflow, step budget) with concrete next steps, a collapsed raw error for debugging, and Resume offered whenever it can actually help.
- Busy runs show a quiet stall hint when the provider stops responding, so the automatic retry window (up to a couple of minutes on connection problems) no longer looks like a frozen run.

### Fixed

- Runs that succeeded could report "No test cases generated — the model produced no test cases for this spec." Schema validation ran against the entire multi-step stream instead of the final answer, so a JSON snippet the model quoted mid-investigation could shadow the real batch and "validate" as empty. The same bug could make Commit Review report a false **clean commit** with zero findings.
- Commit Review History could show a dead run as "running" forever — the startup sweep raced the pane's first load, and closing a tab mid-run never persisted the cancellation at all.
- Closing a Generator tab mid-analyze kept the model running (and billing) invisibly in the background; it now aborts immediately and checkpoints the run as cancelled so it's recoverable from History.
- The activity log and the step counter disagreed ("14 steps" vs "step 5/26"): the log badge now counts **actions** (one budgeted step spans several tool calls), the counter shows the step in progress instead of sitting at 0, and resumed runs display a cumulative cap instead of nonsense like "step 27/8".

### Changed

- The resume affordance is one clean card — what happened, where it stopped, when, and Resume/Discard — replacing the stat-stuffed banner, and it looks identical on both AI surfaces. Tooltips across these flows are trimmed to a sentence.

## [0.15.2] - 2026-07-28

### Fixed

- AI runs now ride out provider rate limits instead of dying on them. Retries honor the provider's Retry-After header for up to ~2 minutes (the previous budget gave up after ~6 seconds — useless against per-minute token windows), and aborting still cancels instantly.

### Changed

- Anthropic agentic runs now cache the growing conversation between steps, not just the system prompt and tools. Each step re-reads the prior transcript at ~10% of the input price instead of re-billing all of it, which cuts both cost and tokens-per-minute pressure by roughly an order of magnitude on multi-step Commit Reviews, Suite Chats, and Generator runs — the reason low-tier keys were hitting rate limits at all.

## [0.15.1] - 2026-07-28

### Fixed

- Commit Review no longer misreports provider failures as "The model didn't return findings in the expected format." A rate limit, overload, dropped connection, or timeout mid-run now surfaces the real provider error (and pressing Stop shows "cancelled", not an error). If the verify pass fails after investigation finished, the run returns the findings unverified instead of failing outright.
- Long AI runs no longer freeze the app. Request bodies and streamed chunks crossed the Rust↔webview IPC as per-byte JSON arrays; at agentic-loop sizes that stalled the main thread badly enough that opening tabs and clicking around went dead during a Commit Review (Suite Chat and the Generator shared the path). Both directions now travel as base64.
- A model retired by the 0.15 model prune could linger pinned to a Commit Review tab or a suite-chat thread from an older build and crash the pane's model picker on open. Stale ids now fall back to the global default model.

## [0.15.0] - 2026-07-24

### Added

- Claude Opus 5 (`claude-opus-5`) across every AI surface — the new Anthropic flagship, also available via OpenRouter.

### Changed

- Streamlined the model picker to the best model of each tier. Since same-tier models are priced identically, only the current-generation flagship of each family is shown.

### Removed

- Retired superseded, same-price models: Claude Opus 4.8 / 4.7 / 4.6, Claude Sonnet 4.6, Gemini 2.5 Pro / Flash, and GPT-4.1 mini. Persisted selections, favorites, and recents that pointed at a retired model now fall back gracefully instead of erroring.

## [0.14.0] - 2026-07-24

### Added

- **Context meter on every AI surface.** The Generator, refine composer, Suite Chat, and Commit Review now show a live, model-aware estimate of how much context a run will send, with a breakdown of what's contributing — the spec, dragged-in files, images, and the custom instructions + best-practices files that are injected into every run.
- **Quality guardrail.** The meter turns amber the moment a run grows large enough that answer quality starts to thin, and red when it's heavily bloated or might not fit the selected model — each with an inline note on how to trim. A confirmation only interrupts you when a run genuinely might not fit. Toggle the warnings under Settings (on by default); the passive meter always shows.
- **Best-practices baseline readout in Settings**, so a bloated standards file that quietly inflates every AI run is easy to spot and trim.

## [0.13.0] - 2026-07-02

### Added

- **Get source code** — a new wizard that clones repositories onto this machine so QA testers who don't manage git themselves can get set up without touching a terminal. Launch it from the status-bar git control (the natural next step when no source directory is set). Clone one or more **Azure DevOps** repos — now listed across your entire organization rather than just the connected project, with the owning project shown so same-named repos stay distinct — into a parent folder you choose, each in its own subfolder; or switch to **Other repository** and paste any HTTPS URL with an optional username and password/token. Progress streams live in a glass capsule and an in-flight clone can be cancelled; when the batch finishes, a picker asks which cloned repo should become the app's source directory.
- Azure DevOps clones use your saved PAT automatically — no re-entering it — and, with your opt-in, the credential is remembered in the OS credential store so later branch switches, pulls, and fetches just work. The token is never written into the repo's config and never appears on a command line.
- If git isn't installed, the wizard explains how to install it for your OS (with a copy-paste command and a download link) and offers a **Locate git…** picker to point at an existing install. Git is now resolved from its standard install locations as well as PATH, so a fresh install is found without restarting the app, and a GUI launch that didn't inherit your shell PATH still works.

## [0.12.0] - 2026-06-30

### Added

- Right-click any suite in the Plans explorer and choose **Copy all open bugs** to put that suite's outstanding bugs on your clipboard as a pasteable list — `Bug <id>: <title>` rows with each id hyperlinked to the work item, so a paste into Asana or Notion auto-recognises it (the same format the generation History pane uses). "Open" means any bug whose Azure DevOps state isn't Completed or Removed, so a Resolved bug you still need to re-test is included. A glass capsule in the bottom-left reports the outcome — how many bugs were copied, that the suite has none, or why the lookup failed.
- When Suite Chat proposes creating a bug, the **Apply to ADO** card now includes an "Assign to" developer picker, so you can hand the new bug to a project team member as you file it — previously every bug created from chat landed unassigned. It's the same searchable roster (with an "Unassigned" reset) used in the generator's review pane, loaded only when a card is actually a create-bug card. The assignee is always your choice — the AI never sets it.

### Changed

- In the generator's review step, keeping a bug on a draft case now automatically sets that case's run outcome to **Failed** — a filed bug is concrete evidence the test failed, so it outweighs a confidence verdict that predicted Pass (previously only the verdict drove the auto-outcome, so a confident-pass case with a bug attached still defaulted to Passed). The outcome is recomputed consistently after every keep/skip, bug re-link, content restore, and verdict change, and only ever touches auto-managed cases — a status you set by hand is never overwritten. Unlink or skip the bug and the outcome falls back to the verdict (or clears); the picker's tooltip explains when an outcome was auto-set because of an attached bug.

### Fixed

- You can now **Pull latest** for the current branch from the status-bar branch switcher even when it reads "0 behind". That count only reflects your last fetch, so a branch that had since moved on the remote couldn't be pulled without first switching to another branch and back. Pull is now offered whenever the branch tracks an upstream; because it fast-forwards only after fetching, it's correct when there's something to pull and a harmless no-op when you're already up to date. The behind-count now rides as a small chip on the button, and a manual **Fetch** refreshes the ahead/behind indicators immediately instead of waiting for the next 30-second poll.
- Pulling no longer surfaces git's raw error (or a vague "pull failed") when uncommitted work is in the way. When a fast-forward — the **Pull latest** action or the automatic pull right after a branch switch — would overwrite uncommitted edits, the app now reports a clear, actionable message ("You have uncommitted changes the update would overwrite. Commit or stash them, then pull.") and leaves your working tree untouched.

## [0.11.1] - 2026-06-29

### Fixed

- Azure DevOps now connects with just an organization URL and a PAT. Previously, entering them in Settings left the app stuck on "Not connected" in the status bar and the Plans sidebar — and the Settings panel showed it disconnected again on reopen — because a project had to be selected first, yet the only project picker was hidden until you were already connected.
- The "create a PAT" link in Settings → Azure DevOps is now clickable and opens in your browser.

### Added

- The Plans explorer shows a project switcher as soon as you're connected, and auto-selects the project when your PAT can see exactly one — so plans, suites, and cases load without an extra step. With multiple projects, pick one from the switcher.

### Changed

- Connecting in the Settings window now refreshes the main window immediately, without an app restart.

## [0.11.0] - 2026-06-24

### Added

- The test-case generator's single mode picker is now two independent choices: a **Coverage** control (Happy path, or Full = happy + edge + negative) and a separate **Suggest bugs** toggle. Folding both into one picker meant "bug-hunt" secretly also meant "full coverage" — now they're separate. Older saved drafts and history still load, mapping onto the new settings automatically.
- **Test** button on every provider key card in Settings → Models. It fires one tiny request to confirm the key actually works before you rely on it — catching the failures a format check can't: a wrong-provider key (e.g. an OpenAI key pasted under DeepSeek, which share the `sk-` prefix), a revoked key, or a key with no credits.
- Manual **reload** buttons beside the filter on the Generation history and Commit Review history panes, so you can refresh the list from disk on demand.

### Fixed

- API keys are now reliably found by every AI feature (Generator, Suite Chat, Commit Review, Confidence). Previously a freshly added key could read as a false "missing key" until you restarted the app — keys are now loaded from the OS keychain at launch and kept live as you save or clear them in Settings.
- Cloud models now connect through the app's own networking, fixing spurious "Failed to fetch" / "fetch failed" errors (including when pasting an image) for Anthropic, OpenAI, and other providers.
- A stalled model connection no longer hangs forever: if a provider goes silent mid-response for two minutes, the run ends with a clear error instead of spinning indefinitely.
- Stopping a Suite Chat now actually stops the model — and the billing — by tearing down the request, instead of letting it finish in the background. Stop also works during the brief setup window before streaming begins.
- The generator no longer drops you into a blank review when a model returns nothing. It shows a specific error explaining why (often an OpenAI-compatible or custom endpoint that needs structured-output / JSON mode), with your spec preserved. New, clearer error screens also cover context-overflow, rate limits, out-of-credits, provider overload, and network problems.
- Re-running a generation you reopened from history no longer overwrites the published history entry — and its Azure DevOps work-item links — as a draft.
- Refining a draft no longer turns an "update existing case" choice into a duplicate work item on publish.
- Code links on published cases are only stamped with a branch actually resolved from your source directory — never a fabricated "main" on a non-git or detached-HEAD source.
- Better support for OpenAI-compatible, local, and reasoning models: structured output (strict JSON schema) is requested where supported, sampling parameters that reasoning models reject are omitted, and a pasted image degrades to a text reference on models without vision support instead of erroring.
- A pinned-model badge (generator, Suite Chat, Commit Review) now only appears when the pinned model differs from your current default, so it no longer misleads when they're the same.
- Key fields now show a single password-reveal control (the app's) instead of stacking a second native one from the system webview.

### Changed

- Pasting a key that doesn't match a provider's usual prefix is now a non-blocking warning rather than a hard save-block — providers rotate their prefixes, and some providers share one, so the Test button (not the prefix) is the real check.
- Settings labels, model-availability copy, and run-error guidance now refer to **Settings → Models** consistently and reflect the single bring-your-own-key engine.
- Removing a custom (OpenAI-compatible) provider now also resets its custom context-window limit, so a re-added connector doesn't silently inherit the old value.

## [0.10.0] - 2026-06-18

### Added

- Switch your source-directory git branch right from the status bar: pick any local or remote branch to check out and fast-forward-pull the latest, fetch to refresh the remote branch list, or pull the current branch when it's behind. Pull is fast-forward-only — it never auto-merges or rebases, and reports cleanly when branches have diverged.
- When you switch branches with uncommitted work, the app asks what to do with it — bring your changes to the new branch, or leave them parked on the one you came from so the target opens clean. Branches with parked changes show an indicator and a Restore action, and a conflicting restore keeps your stash intact so nothing is ever lost.
- The status bar now shows whether your working tree is dirty and how far ahead or behind the upstream you are.
- Commit Review can now review your uncommitted changes: a **Local changes** target (staged, unstaged, and new files vs HEAD) lets you review work before you commit, on its own or alongside selected commits. It's re-read live right before each run, so it always reflects the current state of your files.
- Confidence scores now record the branch and commit they were graded against. The case confidence panel flags a score as stale once you switch branches or pull — showing the graded-vs-current branch and commit and prompting a re-evaluate — and confirms when a score still reflects your current source.
- Running confidence across a whole suite now re-scores cases whose code has changed since they were last graded, instead of only skipping cases that were never scored.

### Fixed

- Commit Review now stays in sync with the status-bar source directory: switching branches, pulling, or stashing refreshes an open Commit Review tab's commit list and local changes instead of showing the previous branch.
- The Suite Chat onboarding hint no longer promises code grounding when the global code-search toggle is off — it now requires both a source directory and code search enabled, matching what the assistant actually receives.
- Aligned the severity badge with the category tag in Commit Review finding cards (it no longer drops below the row).

### Changed

- Code links on published test cases now always track the branch you generated from, resolved from your source directory at publish time — switch branches in the status bar and the next publish follows the new one.
- The Azure DevOps settings panel replaces the tracking-branch picker and toggle with a read-only **Code-link branch** explainer showing the branch (and commit) links will use right now.
- The source directory is now picked and shown only in the bottom-left status bar; the duplicate title-bar button has been removed.

### Removed

- Removed the fixed/manual tracking-branch option — code links can no longer be pinned to a branch other than the one you're working on.

## [0.9.0] - 2026-06-17

### Added

- **Commit Review** — a new AI code-review surface. Select one or more commits and get a two-stage review (investigate → verify) that returns severity-ranked bug findings with evidence and one-click applyable patch cards. Reviews persist to SQLite and reopen from History exactly as you left them.

### Changed

- Rewrote the README to be shorter and feature-focused, grounded in the current app (Generator, Confidence scoring, Suite Chat, Commit Review). Refreshed the macOS install guide and updated CLAUDE.md's backend module map (the read-only `command` runner and the `confidence_store` persistence module).

### Removed

- Replaced the whole-branch "Code Review" pane with the new Commit Review surface.
- Dropped the `docs/smoke-test.md` and `docs/manual-test-checklist.md` manual QA checklists.

## [0.8.0] - 2026-06-16

### Added

- **Run confidence on all cases in a suite.** Right-click a suite to score every unscored case for pass-readiness in one pass. A bottom-left progress capsule shows live progress and can be cancelled; already-scored cases are skipped, suites with more than 20 cases ask for confirmation first, and open case tabs update the moment their case is scored.

### Changed

- **Prompt caching across every AI surface.** Generator, Suite Chat, Code Review, and Confidence now reuse a cached system prompt and tool definitions instead of re-sending them on every agentic step — an Anthropic cache breakpoint plus automatic caching on OpenAI and Google. Prompts stay byte-identical, so results are unchanged; only token cost and latency drop, most noticeably on multi-step, multi-run, and bulk scoring.

### Fixed

- The Test Case Generator's running-refine step label no longer overflows its container when a tool call references a long file path.

## [0.7.0] - 2026-06-12

The single-BYOK-engine release, plus a ~90-commit full review of the app.
Every AI surface now flows through one shared task runner on the Vercel AI
SDK, the generator grounds test cases in your real source code, and a
day-zero audit hardened ADO calls, cancellation, chat UX, and the UI type
scale.

### Added

- One shared task runner (`runTask`/`streamTask`) every AI surface flows through.
- Deep, code-grounded test-case generation: the analyzer reads your source
  (read-only Read/Glob/Grep) to ground cases and bug suggestions in real code.
- A read-only command tool (`run_command`) on every AI surface — git history,
  blame, diff, and file inspection, allowlisted so it can never mutate.
- Schema-validated, temperature-0 output on Generator and Confidence, with
  partial-batch salvage so one malformed item never zeroes a generation.
- Global **"Allow AI to read source code"** setting gating every surface.
- Generator review upgrades: accept/reject individual refine changes, assign
  bugs to a developer, warnings for unlinked bugs and for passing a case with
  open bugs, confidence verdicts auto-set the run status, and a similarity
  match can update the existing case instead of duplicating it.
- Suite Chat: bulk outcome skips already-marked cases, #-mentioned work items
  render inline, cases reconcile against ADO before each send, and confidence
  surfaces alongside outcomes.
- Plans explorer: reveal a case in the tree from anywhere it's opened; toolbar
  Refresh force-reloads the cases of expanded suites.
- The assign picker lists members across all project teams.
- AI tool calls render as readable observations with live activity, not raw JSON.

### Fixed

- Cancelling analyze/refine/Ask/generation now aborts the upstream model
  request — per-tab abort handles, no more orphaned streams.
- ADO hardening: project names percent-encoded in every URL, correct
  permanent bug-delete endpoint, suite-referenced cases unlink before delete,
  real error reasons surfaced, graceful fallback to the default team.
- Repro-steps HTML from ADO is sanitized before rendering.
- Custom instructions from Settings now apply on every AI surface.
- Source citations resolve to the real file, not a root+filename guess.
- Duplicated code-review tabs no longer share the saved thread.
- Chat polish: no "malformed block" flash while JSON streams, clickable bug
  refs, diffs no longer overflow, unreadable files survive attachment batches.
- A full type-scale and consistency sweep across the UI kit, and the
  confidence panel no longer steals Esc from active text edits.

### Changed

- **Single BYOK engine.** Every model runs through the Vercel AI SDK;
  per-surface agentic step caps centralized in `SURFACE_STEP_CAPS`.
- Read window raised to 1500 lines / 24 KB so the model pulls whole modules.
- The update notification is now a compact capsule linking to the release
  notes on GitHub instead of inlining the whole changelog.
- Refreshed app icons and logos at every resolution.

### Removed

- The Claude Code CLI engine (Rust `claude` driver, frontend clients,
  per-engine settings, and the `aiEngine`/`claudeAuthMode` prefs — older
  settings files migrate silently).
- A large dead general-coding-agent stack and all write/edit/bash/delegation
  tools — the app is read-only against your source: it suggests artifacts you
  apply, never autonomously edits or runs shell.
- The per-run "allow code search" toggle (replaced by the global setting).
- Dead weight found by the audit: 14 unused UI components, three callerless
  Tauri commands, the workspace-authorization machinery, and `@thesvg/react`.

## [0.6.0] - 2026-05-29

### Added

- Claude Opus 4.8 (`claude-opus-4-8`) in the model selector — Anthropic's
  new flagship, available to both the Vercel AI SDK and Claude Code engines,
  with context-limit and pricing metadata wired up.

### Changed

- Claude Opus 4.7 is now labelled "Powerful" (prior-generation flagship)
  instead of "Best", so Opus 4.8 reads as the current top model.

## [0.5.0] - 2026-05-29

The biggest release since the test-execution work — a full feature wave plus a
ground-up audit. Code Review grows up (Azure DevOps commit/PR/branch sources
with real diffs), AI **confidence evaluation** predicts whether a case will pass
against your current code, **bugs become first-class** across chat (attach as
context, full CRUD, auto-injected), **best-practices files** ground every AI
surface, inline **#id work-item mentions** replace the old pickers, chats now
**show the model's tool calls** and syntax-highlight code, and a closing audit
fixes latent bugs, prunes dead code, and adds test coverage. No breaking changes
to your persisted data or Azure DevOps payloads — existing settings, drafts,
chat threads, and saved runs load unchanged.

### Added

**Code Review**
- Review **Azure DevOps sources**, not just the local working copy: a commit
  (vs its parent), a pull request (source vs target), or a branch (vs base),
  picked from a cmdk source picker with repo + branch + recent-commits + PR
  lists, all fuzzy-searchable with skeleton loaders.
- **Real unified diffs + line counts for ADO sources** — each changed file is
  fetched at both versions and line-diffed (accurate +/−), instead of showing
  whole files with +0/−0.
- Runs on **Claude Code (OAuth)** as well as the BYOK API path; Stop cancels the
  CLI subprocess.
- **Regression-aware reviewer prompt**: traces callers/dependents of changed
  symbols and flags blast radius (signatures, contracts, persisted shapes);
  treats an ADO diff as authoritative over the local checkout.
- **Before/after diffs on patch cards** with persisted apply state — the
  "Applied" badge and the diff survive a reload (snapshot kept on the message).
- Source-aware header (per-source descriptor + tooltips), tab dedup, and ADO
  source restored across reload and Duplicate.

**AI confidence evaluation**
- A new engine that **predicts whether a test case would pass against the
  current code**, with per-step code evidence (file:line or an honest
  "Unknown"), calibrated anchors, optional self-consistency runs, and a SQLite
  verdict store. Dual-engine (Vercel + Claude CLI), cancellable end-to-end.
- A **pass-readiness chip** ("how safe is it to just mark this Passed?") on
  generator review cards and the test-case header — green only when a real Pass
  clears the 90% bar; the model now estimates pass-likelihood directly.
- Inline **re-analyze (↻) and cancel (✕)** on the chip, **"Evaluate all"** in
  the generator review (3 at a time, live progress), and a dismissible
  **detail side panel** with reasoning, per-step evidence (click a file:line to
  open it), and a branch reminder.

**Bugs as first-class**
- **Attach existing bugs as AI context** in every chat (repro, severity,
  embedded code links), via a searchable picker.
- **Bug CRUD in Suite Chat** — create / update / delete / link bugs (not just
  cases), with before/after diff cards, undo, and full persistence.
- **Auto-inject bugs linked to in-scope cases** (Tested-by/Tests relations) so
  the model sees open defects without you attaching them.
- Backend ADO commands: list / update / delete bug (WIQL search, JSON-Patch
  edits, soft-delete to Recycle Bin).

**Best practices & shared AI context**
- Register **best-practices / coding-standards files** (md, text, images — incl.
  network/UNC paths) in Settings → Models; they're read live and injected into
  **every** AI surface (generation, suite chat, review chat, code review), with
  a readability indicator that surfaces offline files before a run.
- A shared context-block mechanism (no-op when empty) and a cross-module
  consistency directive in the analyst/reviewer prompts.

**Mentions, palette & search**
- Inline **#id work-item mentions** in every chat composer *and* the generator
  requirements + Refine boxes — `#123` resolves by id, `#login` title-searches,
  bare `#` lists recent items; spans **all** work-item types with a type tag
  (BUG / TASK / STORY / …). Replaces the old Bugs dropdown.
- The Test Plans tree filter is replaced by the **command palette** (`⌘/Ctrl+K`)
  with live Azure DevOps work-item search; items without an in-app pane are
  flagged as opening in Azure DevOps. Tree search now lazy-loads suite cases so
  matches actually surface.

**Chat experience**
- Chats now **show the model's tool calls** (Read/Glob/Grep) in all surfaces
  (Suite Chat, Code Review, generator Ask) via shared infra — collapsed to a
  one-line "N tool calls" summary by default, auto-expanding while streaming.
- **Syntax-highlighted code blocks** using the in-app editor theme.
- **Multi-range code-reference pills** everywhere — one compact pill per file,
  each line range a clickable segment; back-ticked citations (`Foo.cs:42`) are
  linkified too; widened allowlist for the .NET/web stack.
- Persist the **pinned model per chat** across reload (code review + generator,
  matching suite chat); jump-to-latest pills in Ask and Code Review.
- The Suite Chat **inspectable context chip** shows exactly which cases, linked
  bugs, mentioned items, and best-practice files the model received.

**This release's audit pass**
- **"Tag with source branch"** toggle in the generator input form (default on,
  for git source dirs): stamps the resolved branch onto published cases' code
  links and the source-dir commit onto bug code refs.
- **Custom instructions** UI in Settings → Models (the field fed every AI prompt
  but had no control).
- Test coverage for batch parsing, bug→case linking, branch resolution, and
  confidence readiness; plus `docs/manual-test-checklist.md` and `SECURITY.md`.

### Changed
- Confidence verdicts are framed as pass-readiness, colored by predicted outcome
  (not the raw %), and the detail moved from a hover tooltip → Sheet → workspace
  pane → inline side panel over the release as the UX settled.
- Best practices live as a subsection of the Models settings tab (not a 7th tab).
- Claude `--bare` isolation is now derived from auth mode (API-key isolates,
  OAuth doesn't) instead of a footgun user toggle that broke OAuth runs.
- Keyboard hints adapt to the OS (⌘ on macOS, Ctrl on Windows) everywhere.
- File-path separators are normalized throughout (no more mixed `C:\…/…` paths).
- Suite Chat header drops the redundant "N cases" count beside the context chip;
  verbose tooltips (Narrow-AI-scope, code-review diff stats) tightened; icon-only
  Settings buttons use real tooltips; ADO status polling eased 15s → 30s + focus.

### Fixed
- **Bugs linked to the wrong parent case** when an earlier case was skipped
  before publishing — the link index addressed the unfiltered array; now
  resolved through the full array.
- **Stale confidence verdicts** after editing a case's steps no longer linger;
  the chip resets to "Evaluate" and the stored verdict is cleared.
- **429 Retry-After** read from the response body (never present) instead of the
  HTTP header — rate-limited calls always backed off a hardcoded 30s.
- **Large suites truncated**: `list_suite_cases` now follows ADO continuation
  tokens, so 200+ case suites load fully.
- The model no longer invents a git branch/commit in generated code refs — the
  app stamps real provenance at publish time.
- A **white-screen crash** in Suite Chat (a hook ran after an early return on
  suites without loaded cases).
- A **failed suite-chat turn** no longer reappears broken after reload (the
  reconciled thread is flushed to disk).
- Cross-window settings sync for keyboard shortcuts; a leaked PTY event listener
  when a terminal tab closed during spawn; the code viewer reliably scrolls to +
  highlights a linked line on open; context menus flip up near the screen bottom
  instead of clipping; the local diff no longer corrupts when switching back from
  an ADO source; the command palette's right column stays flush-right; #mention
  dropdowns no longer clip; the generation-history meta row wraps at narrow
  widths; the settings close button can't be pushed off-window.
- Backend no longer panics on a poisoned mutex; case-insensitive SSO detection;
  non-JSON CLI output and dropped autosaves / branch-list failures are now logged.

### Removed
- Dead settings: `vimMode`, `showHidden`, the autocomplete trio, and the unused
  `ado.defaultPlanId` field (existing settings files load fine — leftover keys
  are ignored). The "Run Claude in isolation" toggle (now derived from auth).
- 10 confirmed-unused npm packages, incl. `@anthropic-ai/claude-agent-sdk` (the
  engine is driven by the `claude` CLI, not the SDK).

### Security
- Added `SECURITY.md` documenting the trusted-renderer threat model and why the
  `fs_*` commands aren't path-gated (best-practice files and repos legitimately
  live on arbitrary paths / network shares).

### Notes
- The confidence-verdict JSON shape changed during this cycle; old verdicts still
  render (back-compat), no migration needed.

## [0.4.0] - 2026-05-26

This release brings test execution into the workflow — record Pass / Fail / Blocked outcomes from the test-case tab, Suite Chat, and the generator review tab — adds image & file attachments with real vision to every chat surface, bulk edits in Suite Chat, and a "what the last refine changed" diff in the generator. The stale-case detection feature is removed.

- **Record run outcomes (Pass / Fail / Blocked / N/A).** A minimal outcome dropdown in the test-case header writes the case's test-point outcome in its plan + suite, backed by a new Rust `test_points` module (list points, set outcome, list a case's suites) — the write returns the outcome it set rather than ADO's lagging PATCH echo. Suite Chat can now propose an outcome as an Apply card, and the **generator review tab** lets you pick an outcome per case that's recorded against its test point right after the case publishes.
- **Attachments in every chat.** Drag-drop, paste, or use the paperclip to attach images and text files in Suite Chat, Code Review, and the generator's Refine and Ask composers — matching the generator's input phase. Images are now sent to the model as real **vision** input (Vercel-SDK providers and the Claude CLI alike — the latter via `stream-json` image blocks), and every attachment is persisted, so it's still there when you reopen the chat thread or a saved generation draft.
- **Bulk edits in Suite Chat.** When a change spans many cases, the assistant proposes them as a single card with a checkbox per edit and an expandable diff for each. Apply the whole batch with "Apply all" or cherry-pick with "Apply selected" — one failing edit doesn't abort the rest, and a partially-applied batch stays marked when you reopen the chat. Referenced `#case` chips are clickable.
- **"What the last refine changed."** A review-tab panel diffs the pre-refine draft against the current one — field-labeled per case (description + step diffs) and per bug (severity + repro-steps) — and the snapshot persists in the saved draft, so the panel survives reopening a run from history.
- **Live-streaming Ask chat.** The generator's review-pane Ask panel now streams tokens into the assistant bubble (caret + thinking dots) with a stop button, matching the Suite Chat and Code Review surfaces.
- **Existing suite cases as generation context.** Analyze now feeds the target suite's existing cases — with their steps, capped at 20 — to the model, so it reads prior coverage and writes complementary, style-matched cases instead of deduping on titles alone.
- **Generation History context menu.** Right-click a run to open it in review, open its publish summary, copy the spec, copy case & bug titles, or delete it. Duplicating a review/done generation now confirms first, since the copy becomes its own publishable History entry.

- **The generator prompt demands exact, value-level reproduction steps** and treats the generated cases & bugs as a deliberately-ordered list.
- **Dark mode eases off pure black** toward a softer near-black for more comfortable contrast.

- **Duplicating a generator tab** now clones the full live draft (phase, publish log, cases, bugs, refine snapshot) into an independent session with a fresh run id — instead of dropping you on an empty input form — and the copy survives a reload. Duplicating a deduped tab (test case / bug / code-viewer / Suite Chat) now actually creates a distinct copy instead of reactivating the original.
- **Reopening a draft or published run after a window reload** no longer snaps back to an empty input form.
- **Opening a case from a Suite Chat link** now carries its plan + suite, so the Execute dropdown targets the right test point instead of falling back to the suite picker.
- **The copy tooltip** no longer promises a link on an unpublished draft.

- **Stale-case detection.** The per-branch staleness scanner, the Stale sidebar queue, the "Mark for review" action, and the related command-palette entries and `Ctrl+Shift+S` shortcut are gone. Branch awareness in the status bar and the branch-aware code-link chips on published cases are unaffected — the tracking-branch setting now solely drives those code links.

## [0.3.2] - 2026-05-25

- **Title bar no longer sticks to the cursor.** Clicking the window title bar could drop the window into a drag that kept following the pointer after the mouse button was released. Window dragging now begins only after real pointer movement, so a plain click stays a click.
- **Terminal falls back to an installed shell.** When the saved default-shell path didn't exist on the current machine (settings copied between devices, a different OS, or a moved binary), opening a terminal failed outright. It now falls back to the platform's default shell so a terminal tab always opens.

## [0.3.1] - 2026-05-24

- **Updater toast no longer fills the workspace height when expanded.** Clicking "Show all N changes" on a release with a long changelog used to stretch the bottom-left toast all the way to the top of the workspace. The sections list is now capped at `min(55vh, 420px)` with internal scrolling, so the card stays a glanceable corner notification even on releases with a lot of changes.

## [0.3.0] - 2026-05-24

This release lands two big new surfaces — an embedded terminal and an AI code-review pane — on top of a full workspace tab system rewrite (drag-to-split, recursive panes, persistent reorder/pin), multi-thread persistent Suite Chat with real code grounding, and a Settings UI scale slider. Plus the usual basket of fixes.


- **Embedded terminal (developer mode).** `xterm.js` pane backed by a Rust `portable-pty` driver. Open from the sidebar, the command palette, an in-strip "+" launcher, or `Ctrl+Shift+`` `. Per-pane shell picker (PowerShell / cmd / bash / zsh / fish / Git Bash) renders real brand marks. Quick-Prompts strip with CLI-aware starter prompts that detect the active Claude / Codex / Cursor / Gemini CLI and resolve the source-dir's *real* git default branch. UTF-8 forced on cmd.exe so non-ASCII output renders. Right-click context menu, copy/paste/clear actions, and clean app-close + tab-close lifecycle. Sessions survive pane splits / merges because xterm + the PTY live outside the React lifecycle (module-scoped registry, DOM-move on re-attach). Concurrent-session cap raised from 8 → 16 with synchronous slot release on kill.
- **Code Review pane.** BYOK-grounded review of your current branch diff against a chosen base (defaults to the real default branch, never main-when-you're-on-trunk-flow). Chat-style composer matching Suite Chat — message bubbles, suggested prompts, send/stop, model picker filtered to providers that actually have an API key, branch picker with fuzzy search. **Apply-able patch cards** — when the model proposes an edit, it renders as a click-to-write card; applying patches is now the default surface, not optional. Threads persist in SQLite and surface in the new **Chats** sidebar. Multiple Review tabs can be open at once. ADO marks now come from `@thesvg/react` instead of inline SVG.
- **Workspace tab system rewrite.** A recursive pane renderer replaces five kind-specific stacks. Drag tabs to reorder within a strip, drop them on another pane to move, drop into a leaf's edge zones to split horizontally or vertically; `Ctrl`-drag clones instead of moving. Keyboard splits / focus / move shortcuts. Pin, duplicate, close-others / close-right / close-all, jump-to-N (`Ctrl+1`…`Ctrl+9`), reopen-closed. "+" launcher in three surfaces (sidebar, top bar, in-strip) with Generate + terminal-action shortcuts in the popover. Per-cell store subscriptions for tab state so opening a tab doesn't re-render every other tab.
- **Multi-thread Suite Chat with code grounding.** Each ADO suite now owns multiple persistent threads (SQLite-backed) — keep regression sweeps, exploratory chats, and bug triage separate without context bleed. A "Narrow AI scope" pill replaces the old ambiguous search box; each thread opens in its own tab from the history sidebar. The BYOK runner now has real `fs` tools (read / grep / glob / write) wired in, so the model can actually look at your code instead of pretending. Apply pipeline now covers **create-case** and **delete-case** alongside the existing **devops-edit** flow — proposed ADO mutations land as inline cards you click to apply.
- **Editable test-case steps in TestCasePane.** Click any step to edit in place; the table is stable across edits and keeps focus.
- **Reopen-and-republish drafts.** Generation history rows now open back into the review draft and re-publishing is idempotent — no more duplicate cases on a second click.
- **UI scale slider** (Settings → General → Accessibility). Independent of the OS zoom, 80% floor so dense panes stay readable. The settings window no longer rescales itself when you drag the slider.
- **shadcn `Kbd` / `KbdGroup`** rendering everywhere shortcuts appear — sleeker, more compact, no more context-menu line wrap.
- **`ContextMenuItem` `icon` + `description` props** for Linear/Raycast-style two-line menu rows (label on top, 10.5 px muted subtitle underneath). Use instead of nesting a Tooltip on a Radix menu item.
- **`BranchPicker` shared component** — cmdk Combobox in a Popover, fuzzy search, height-capped at 280 px. Reused by Code Review and Azure DevOps settings.
- **`ProviderIcon` picks real brand marks where available** — simple-icons for Anthropic / Vercel / Google / Mistral / Ollama / OpenRouter / DeepSeek and shell marks (PowerShell from thesvg.org, bash / zsh / fish / Git Bash from simple-icons), with the hugeicons stroke set as a clearly-labelled fallback only for providers without a registered brand (OpenAI, xAI, Cerebras, Groq, LM Studio).
- **Cursor** added to the AI CLI picker in the top bar.


- **Suite-chat render loop** in the `boundThread` activation effect — the pane no longer spins on first open.
- **Suite-chat deleting the active thread** no longer leaves the pane stuck in skeleton state forever.
- **Tab strip overflow** scrolls horizontally without showing a visible scrollbar; in-strip "+" launcher actually opens and sits next to the last tab.
- **Tabs context menu** — right-click now opens; cross-leaf split-leaf now actually moves the tab; drop targets gained nicer focus / drop hints; the focused-pane inset ring was dropped.
- **PTY capacity-slot leak** — slot is freed synchronously on `kill` instead of waiting on the async exit signal. Cap raised to 16. PTY error messages are now readable (the OS error number is wrapped with context) instead of opaque codes leaking through.
- **Terminal quick-prompt clear** — switched from `Ctrl+U` to backspace tracking (Ctrl+U was triggering cmd.exe's command-history menu). Quick prompts now send a single explicit `Ctrl+U` before typing so the prompt isn't appended to stale input.
- **Terminal re-attach** moves the xterm DOM node instead of re-instantiating, so React unmount/remount no longer wipes scrollback or kills the shell.
- **Code-review model picker** is filtered to providers that have an API key configured — no more selecting a model the runner will immediately fail on.
- **Generator narrow-column layout** — 2-column input breakpoint bumped from `@xl` to `@3xl`; container-query responsive layout means a generator tab in a narrow split pane lays out as one column instead of overflowing.
- **Steps-table editing stability** + settings dialog corner radius + scroll gutter alignment.
- **AI / tabs missing-key copy** is now generic instead of mentioning a specific provider that may not be the one you tried to use. Duplicate pin glyph removed from the tab strip.
- **Native webview zoom** wired correctly — 80% lower bound; settings window no longer rescales itself when you change app-wide zoom.


- **Apply-able patches are the default** in Code Review — not behind a feature flag, not an opt-in surface.
- **Review chat** promoted from floating FAB → right-side drawer → flex sibling controlled by `GeneratorPane`, so it survives layout changes and respects pane resizing.
- **Top-bar "+" launcher** dedup — drop the duplicate entry; the sidebar / top-bar / in-strip launchers now share one popover.
- **Suite Chat header** simplified — clearer thread switcher, send-arrow composer that matches Code Review.
- **Tab context menu** trimmed to labels only (no descriptions) — descriptions live on the new ContextMenuItem two-line pattern instead, used where the label isn't self-explanatory.
- **Settings → Models default-model picker** stays in sync across the main and settings windows via the prefs bridge (`emitGenerationBusy` / `onGenerationBusy`).
- **Generator Changesets / Scope Notes field** folded into the Requirements field — one place to paste your spec instead of two near-identical text areas.
- **Branch awareness across panes** — `$current` sentinel resolves at scan-time from the live source-dir branch; quick prompts and code-review base default to the real default branch instead of hard-coded `main`.


- **Generator Changesets / Scope Notes field** as a separate input — its content lives inside Requirements now.
- **Duplicate "+" launcher** in the top bar (one launcher, three surfaces).
- **Floating Q&A FAB** over the review draft — promoted to a docked sibling, see Changed.

## [0.2.0] - 2026-05-22

- **Status-bar update indicator + bottom-left toast** replace the modal that used to pop over the workspace whenever an update landed. The pill in the footer mirrors updater state (available / downloading / restart-ready) and the toast renders a parsed Keep-a-Changelog body — `Added`, `Fixed`, `Changed`, `Removed`, `Security` get tone-coded chips and overflow into a "show all N" affordance. Dismissing the toast remembers the version in `localStorage` so it doesn't re-pop every launch; clicking the pill un-dismisses for that version.
- **ESC cancels in-flight refine.** Rust side adds `claude_cancel_run` that notifies a per-run `tokio::sync::Notify`; the run task races `child.wait()` against the cancel signal via `tokio::select!` and surfaces a new `ClaudeError::Cancelled` variant. JS plumbs the runId through `runQaAnalystClaude` via `onRunStart`; pressing ESC during refine kills the subprocess instead of waiting on the model. The running strip also gets an explicit `cancel` button with an `esc` kbd hint.
- **Settings → Models default-model picker locks during analyze / refine / open draft.** New `emitGenerationBusy` / `onGenerationBusy` events on the prefs bridge so the settings window mirrors the status-bar picker's local behavior across windows. Inline amber "locked" pill explains why.
- **Production right-click guard.** New `installContextMenuGuard` helper called from both window entries suppresses the native Chromium / Edge context menu in release builds (devtools menu stays in development). Opt-in escape: any element marked `data-allow-context-menu` preserves the native menu — useful for CodeMirror surfaces where users want OS copy/paste.
- **"Run Claude in isolation" toggle** (Settings → Models → Advanced runtime) — passes `--bare` so the analyst skips your `~/.claude` hooks, plugins, MCP servers, and `CLAUDE.md`. Tucked behind a collapsed disclosure since most users never need it; the code-1 error message references it by name. Automatically ignored at runtime on Max OAuth (bare skips the keychain read) with an explanatory chip in the UI.
- **Refine "thinking" and "history" chips** moved into the composer's dock header — always visible without eating composer real estate, with hover tooltips and live counts.

- **`<button>` cannot be a descendant of `<button>` hydration error** in `GenerationHistoryPane.RunCard`. The outer toggle is now a `<div>` with the row's toggle + action icons as siblings.
- **Refine history dialog** lists rounds most-recent-first (round numbers still count chronologically so `#03` stays `#03` across views).
- **Analyst.log layout** — long file paths and grep patterns no longer break mid-token. Live composer view gets per-cell horizontal scroll with a slim 4px hover-revealed scrollbar; the rounds-history dialog wraps content instead (shadcn's `ScrollArea` was eating nested horizontal wheel events).
- **Improved code-1 error message** — detects "not logged in" / "invalid api key" stderr and gives a targeted hint about the OAuth + bare-mode conflict; empty-stderr message now enumerates likely causes (hook, MCP, plugin) and points at the activity log for `hook:<name>` rows.

- **Updater dialog removed.** All in-app updater UX flows through the bottom-bar pill + bottom-left toast. Settings → About keeps its own "Check for updates" affordance, unchanged.
- **`claudeBareMode` preference defaults to `true`** on fresh installs — DevOps Studio runs the analyst in an isolated CLI session so your local Claude Code config doesn't bleed into the app's internal AI calls. Existing installs without the stored key inherit the new default; explicit user choices are preserved.

## [0.1.2] - 2026-05-21

### Fixed
- Windows: console windows no longer flash when the app spawns subprocesses.
  `git rev-parse` runs every 30 s for source-directory branch detection, plus
  every Claude CLI invocation (probe, run-query, auth status, etc.) — each of
  those used to pop a brief cmd.exe window. All spawns now pass
  `CREATE_NO_WINDOW` on Windows. This fixed the "terminals keep opening and
  closing" issue that made the app look broken on first launch.

### Added
- macOS builds (.dmg / .app) are back in the release matrix. They're
  intentionally unsigned for now (no Apple Developer Program account); see
  [docs/install-macos.md](docs/install-macos.md) for how to bypass Gatekeeper
  on first launch.
- `scripts/release.sh` — one-shot release helper that bumps the version
  across `package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`,
  prepends an entry to this CHANGELOG, commits, tags, and pushes. See
  [CLAUDE.md → Release process](CLAUDE.md#release-process) for usage.

### Changed
- Release workflow auto-publishes (no more draft step) and pulls release
  notes from the matching CHANGELOG section instead of the static placeholder
  string.

## [0.1.1] - 2026-05-21

First public release. Windows + Linux installers, signed updater artifacts,
auto-update wired through `tauri-plugin-updater`. macOS bundles were skipped
in this build — added back in 0.1.2.

### Added
- Auto-updater: the app polls `latest.json` on the GitHub release every 30 min
  (and on launch), verifies signatures with the embedded minisign pubkey, and
  prompts to download + relaunch.
- Public-release CI / release workflows under `.github/`.

### Fixed
- Test-case generator "ask follow-up" no longer fails silently with
  `Claude exited with code 1` and no message. Stdin / stdout / stderr now
  drain concurrently (was a pipe deadlock on large refine prompts), stderr is
  captured lossily so non-UTF8 console bytes don't truncate the diagnostic,
  and `--allowed-tools` was switched to `--tools` so `bypassPermissions`
  doesn't accidentally re-expose Bash/Write/Edit.
- Refine-history dialog no longer expands sideways when "thinking & tool
  calls" is opened. CSS grid items needed `min-w-0` down the chain plus
  `break-all` / `break-words` on long paths and JSON output.
