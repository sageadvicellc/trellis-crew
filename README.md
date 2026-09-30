# trellis-crew

👷🏻‍♀️🌱 Build anything, grow smarter

trellis-crew sets up a small team of agent sessions that split work, hand
off tasks, and report status. It sits on Trellis, an open framework,
and ships free under the MIT licence. Peer messaging runs on three
tiers. Tier one is native: Claude Code and Qwen Code ship a peer list,
an addressed send, and a delivery outcome per message today. Tier two
is a general path: a harness that speaks the Agent2Agent protocol
moves a task to another agent, as Hermes Agent does now. Tier three is
a shared file mailbox, for every other harness checked. Each session
reads and writes its own file in one mailbox folder, and no server
runs. This repository holds the CLI, draft skills, and a manifest, not
yet an installed plugin. The code's permanent home is a
decision still open on the build issue.

## Use the CLI

The `trellis-crew` command line tool installs the plugin on your harness
and starts, lists, and stops your team. A harness is the agent tool that
runs each session, such as Claude Code or Codex CLI.

### Get the CLI

You need Node.js 24 or later. When the package is on npm, install it
with `npm install -g trellis-crew`. From a clone of this repository, run
these commands in its folder:

```
npm ci
npm run build
npm link
```

### Set it up once

Run `trellis-crew install`. The CLI looks for each harness it knows and
asks you to confirm the one it found. Then it installs the plugin on that
harness and writes your choice to `~/.trellis-crew/install.yml`.

- `--harness <name>` picks the harness and skips the search. The names
  are `claude-code`, `qwen-code`, `hermes`, `codex`, `amp`, and
  `opencode`.
- `--transport <name>` picks how sessions send messages. The names are
  `native`, `a2a`, and `file`.
- `--non-interactive` asks no question. It takes the best candidate.
- `--reconfigure` asks again, even when `install.yml` holds a choice.

On Claude Code and Qwen Code, install can also set your user settings
file to accept messages from other sessions. This applies to every
session of that harness for your user, not only the team, and
`trellis-crew stop` does not undo it. Install explains this and asks
first. Add `--yes` to accept with no question, or `--skip-inbound` to
leave the file alone. With no terminal and neither flag, install leaves
the file alone and exits 1. Before it writes, install copies the file to
a dated backup beside it, and it prints both paths.

For the file mailbox, install reads the mailbox folder from
`./sagespec.yml` when that file is in the current folder. It first
shows the same confirm screen as `start`, and then it asks. `--yes`
skips the question.

### Run your team

1. Write your roles file. Copy `sagespec.example.yml` to `sagespec.yml`
   and change it. With no roles file, the CLI starts the default team.
2. Run `trellis-crew start`. It reads `./sagespec.yml`. Pass
   `--roles <file>` to read another file. When `start` finds
   `./sagespec.yml` on its own, it shows a confirm screen. The screen
   prints the file's path, the harness, the transport, and the full
   path of the mailbox folder. It prints each task profile with its
   model and effort. For each session, it prints the name, the kickoff
   message, and any model, effort, and autocompact value. Then it asks
   before it starts anything. A cloned folder can hold another author's
   prompts. Add `--yes` to skip the question in a script. With no
   terminal and no `--yes`, it starts nothing.
3. Run `trellis-crew status` to list each session and its state.
4. Run `trellis-crew stop` to end the team. It ends only the processes
   the CLI started, and then it removes the team record. The CLI checks
   each process ID against the start time in the team record first. If
   the record holds no start time, the CLI warns and asks. With no
   terminal, it signals nothing and keeps the record. Add `--force-stop`
   to signal that process with no question. `respawn` takes the same
   flag.

`trellis-crew start` also takes `--workers N`, which sets the number of
workers. The default team runs a reporting chain, a lead, an auditor,
and the workers. It has no researcher.

To restart one session with new settings, run
`trellis-crew respawn <name>`. It takes `--model`, `--effort`, and
`--autocompact`. A flag that you leave out keeps the value from the
roles file. The session starts again with an empty context. So run it
only between units of work. When the roles file changed since `start`,
respawn shows it and asks again before it stops anything. Add `--yes`
to skip the question.

To check for a newer CLI and update the plugin, run
`trellis-crew update`. Add `--check` to change nothing. The CLI prints
your harness's own update command, and it never runs that command.

### Set up and start in one step

`trellis-crew up` runs the install and then `start`, in one command.
It works on Codex CLI and Claude Code.

```
trellis-crew up --harness codex
trellis-crew up --harness claude-code --accept-inbound
```

- `--harness <name>` is required. The names are `codex` and
  `claude-code`. Any other name exits 2.
- On Codex CLI, run `up` at the top of a git worktree. See "The Codex
  CLI sandbox" below.
- The install step runs as `install --harness <name> --non-interactive`.
  So it asks no question.
- `up` takes the flags that `start` takes: `--workers N`,
  `--roles <file>`, and `--yes`.
- `--roles` must name a local regular file. A URL, a `git@` address, or
  a folder exits 2. The last part of the path must not be a symbolic
  link. A parent folder can still be a link. `up` reads the file once,
  and it checks the team before the install. So a bad roles file, or
  one that names another harness, installs nothing. Before `start`, `up`
  checks the file again. If the file changed after `up` read it, `up`
  starts nothing. `start --roles` does not make these checks.
- `--yes` confirms a roles file that `up` finds in the current folder.
  With no `--yes`, `up` starts nothing, because it asks no question.
- `--yes` never changes your settings file. On Claude Code, add
  `--accept-inbound` to set the inbound setting, or `--skip-inbound` to
  leave the file alone. With neither flag, the install step leaves the
  file alone and exits 1. The inbound setting is described under "Set it
  up once".

When `install.yml` already records the same harness, `up` keeps the
transport it records and prints it. `install --harness` does not.

`up` stops at the first step that fails. It prints that step's message,
then a line that names the step, and it exits with that step's code.
When the install step fails, nothing starts. When `start` fails, the
line says that the install step already ran.

A later design plans `trellis-crew up` with a `crew.yml` file, in
`docs/crew-addendum.md`. That design must fit with `up --harness`, which
exists now.

### What each harness does

The launch fields `autocompact`, `model`, and `effort` are checked on
Claude Code only. On every other harness, the CLI ignores each field
that you set and prints a warning that names the session and the field.

- Claude Code starts each session in the background with `claude --bg`.
  The CLI records no process for it. So `stop` and `respawn` cannot end
  it, and `stop` tells you so.
- Qwen Code starts each session as its own `qwen -p` process. The first
  prompt tells the session its name.
- Hermes Agent sessions do not start on their own. The CLI prints the
  `hermes chat -p <name>` command and the kickoff message for each one.
  You start each session in its own terminal.
- Codex CLI sessions start under one supervisor process. `start` returns
  at once. The supervisor starts each `codex exec` process and records
  its process ID. `stop` ends the supervisor and each session.
  Install exports the skills into the project for it, as "The skills on
  Codex CLI" says. See also "The Codex CLI sandbox" below.
- Amp starts each session as a titled thread on the vendor's servers.
  No command to stop a thread is documented. So `stop` leaves each
  thread running and prints its ID when the CLI has it.
- Any other harness, such as OpenCode, gets the kickoff message for
  each session printed. The CLI runs nothing on it.

By default, on every harness except Claude Code and Qwen Code, sessions
talk through a file mailbox. The default folder is
`~/.trellis-crew/mailbox`. Set `mailbox` in the roles file to use
another folder. The value must not hold a `..` part.

### The skills on Codex CLI

Codex CLI reads skills from these folders, in this order:
`$CWD/.agents/skills`, `$CWD/../.agents/skills`,
`$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`,
`/etc/codex/skills`, and then its built-in skills. The Codex skills page
lists them
(https://learn.chatgpt.com/docs/build-skills, read 2026-09-30).

On Codex CLI, `install` and `update` copy each approved skill into
`.agents/skills/` at the top of your project. The approved skills are
the ones in the `skills` list of `.claude-plugin/plugin.json`. A folder
under `skills/` that the list leaves out is not copied. The export
never touches `~/.agents/skills/`, because every Codex session on the
machine reads that folder. The CLI never sets `CODEX_HOME`.

Run the command at the top of a git worktree. For any other folder, the
command stops and names the step. It also stops for your home folder
and for `/`. The CLI ignores any `GIT_` variable in your shell for its
git steps, so it always reads the repository in that folder.

The skill export in `install` and `update` does not run the session
checks that `up` and `start` run, such as the `core.hooksPath` check. So
`install --harness codex` can copy skills into a worktree where `up` or
`start` then refuses to start a session. That is not a way out of the
checks, because no session starts there.

Under the workspace-write sandbox, "`<writable_root>/.agents` is
protected as read-only when it exists as a directory". The Codex
approvals and security page says so
(https://learn.chatgpt.com/docs/agent-approvals-security, read
2026-09-30). So a Codex session cannot edit the copies. If someone
deletes `.agents` while Codex sessions run, a session can make it
again, so run the export again before you start new sessions.

The export keeps git clean, and it changes no tracked file:

- It adds one line, `/.agents/skills/<skill>/`, for each copied skill
  to the local exclude file that `git rev-parse --git-path info/exclude`
  names. That file is not tracked, so the copies do not show in
  `git status`. The lines sit in a block between
  `# >>> trellis-crew skills (managed) >>>` and
  `# <<< trellis-crew skills (managed) <<<`. The CLI changes no line
  outside that block. Inside it, the CLI changes only its own skill
  lines, and it warns about any other line. A block with no end line,
  or two blocks, stops the install. It also stops for a link at
  `.git/info` or at the exclude file.
- The CLI adds the lines before it copies a skill. It takes a line out
  only after the skill's folder is gone.
- While it edits the exclude file, the CLI holds a lock file beside it,
  `<exclude>.trellis-crew.lock`. If that lock file is already there, the
  install stops and names it. If no other trellis-crew run is going,
  remove the lock file, then run the command again.
- In a linked worktree, git reads the exclude file of the main
  repository, `<common git folder>/info/exclude`. So every worktree of
  that repository shares one block.
- It never edits `.gitignore`.
- If git tracks any file in `.agents/skills/<skill>/`, in any letter
  case, the CLI treats
  that folder as tracked in git. The install then stops and changes
  nothing.

- Each copied folder holds a marker file, `.trellis-crew-skill.json`. It
  names the skill and the SHA-256 hash of the folder's files. For the
  CLI to own a folder, two things must be true. The marker names this
  package and the same skill. The files still match the hash in the
  marker.
- An older CLI copied the skills with no marker. If a folder has no
  marker and its files match the package exactly, the CLI adopts it: it
  writes the marker and owns the folder. If that folder is for a skill
  the list leaves out, the CLI removes it as stale. A folder with no
  marker that does not match exactly is not the CLI's own.
- A folder of your own with the name of an approved skill is left alone.
  If you edited a folder that the CLI owns, that folder is left alone
  too. In each case, the install stops, names the folder, and exits 1.
  If a folder is not its own, or was edited, the install changes
  nothing. Move or rename the folder, then run the command again.
- The CLI replaces each folder it owns. If a skill is no longer
  approved, the CLI removes the folder it owns for that skill, and its
  exclude line. It also removes its own leftover temp folders. Each
  one is named `.trellis-crew-<skill>-` and six characters, with
  `-old` after them for a swapped-out copy. Each one holds a marker that
  names trellis-crew and the skill, and its files match the hash in the
  marker. If a folder has that name but no such marker, the CLI warns
  and leaves it alone, and the install goes on. An example is
  `.trellis-crew-department-lead-backup`. The CLI touches nothing else
  in `.agents/skills/`, such as a folder named `.trellis-crew-backup`.
- The CLI does not follow a symbolic link. A link in place of a skill
  folder, `.agents`, or `.agents/skills` stops the install.

`trellis-crew update --check` also compares each copy with the package.
It prints one line for each skill, with one of these states:

- in step: the copy matches the package.
- drifted: the CLI owns the copy, and the package changed since the
  copy was made.
- missing: no folder has the skill's name.
- not owned: a folder of your own, a link, or a folder that git tracks
  has the skill's name.
- edited since export: the CLI made the copy, and its files changed
  after that.
- unreadable: reading the folder failed. The line gives the error.
- unmarked copy: the folder has no marker and matches the package. The
  next install or update adopts it.
- stale: the CLI owns the folder, and the skill is no longer approved.

The check exits 1 for drifted, missing, not owned, edited since
export, unreadable, and stale, and it names each such skill. If the
folder is not the top of a git worktree, the check exits 1 too. It warns about
each leftover temp folder, and about each line in the exclude block that
the CLI did not write. A warning does not change the exit code. The
check changes nothing. Run `trellis-crew update` to copy the skills
fresh.

### The Codex CLI sandbox

The CLI sets three things on the `codex exec` command line for each
session.

- The sandbox mode is `--sandbox workspace-write`. The local
  `codex exec --help` of codex-cli 0.157.0 describes `--sandbox` as
  "Select the sandbox policy to use when executing model-generated
  shell commands".
- Network access is off, through
  `-c sandbox_workspace_write.network_access=false`.
- The writable roots are the mailbox folder only, through
  `-c sandbox_workspace_write.writable_roots=[...]`. This list replaces
  the list in your own `~/.codex/config.toml`. With no mailbox, the list
  is empty.

The help lists `-c` as an override that is "parsed as TOML". It does not
list the keys under `sandbox_workspace_write`. The CLI uses the key names
that the codex-cli 0.157.0 binary holds, and a later build must check
them again.

The CLI never uses `danger-full-access` or
`--dangerously-bypass-approvals-and-sandbox`. Codex CLI has no verified
launch flag, so the CLI refuses every launch flag and every bare word
before the prompt. The supervisor checks each session's arguments again
before it starts that session. If the arguments are wrong, it refuses
that session and writes the reason to `codex-supervisor.log` in the
state folder.

The sandbox lets each session write its working folder. So the CLI
starts Codex CLI sessions only at the top of a git worktree. The CLI
runs `git rev-parse --show-toplevel` in the current folder. The answer
must be that same folder, after both paths resolve through any links.
The CLI also refuses your home folder and `/`. It refuses a folder that
holds another git repository one to three levels below it. It follows
no symbolic link during that search. It refuses a folder whose
`core.hooksPath` points inside it, because a session can write a git
hook there. For the same reason, it refuses a command in the git
settings that names a path inside the folder. Examples are
`core.fsmonitor`, `core.sshCommand`, a filter, and an alias that starts
with `!`. Git runs these commands in the worktree top. So in them, a
shell or a runtime, such as `sh` or `python3`, must run an absolute
path outside the folder. This test is not a shell parser. It does
not see a command found on `PATH`, or a path built at run time.
Through `include.path` or `includeIf`, git can read a
settings file from inside the folder. The CLI refuses the folder then.
The folder's own `.git` is allowed, and so is a settings file inside
that `.git`. Each of these git
calls runs with every `GIT_` variable removed, so it sees what plain git
sees. The folder is checked
three times:

- before `up` installs anything
- before the CLI writes the supervisor job
- in the supervisor, before it starts any session

On Codex CLI, the mailbox folder must be inside the state folder,
`~/.trellis-crew`. The CLI resolves the folder through any links first.
Then it refuses each of these folders:

- `/`
- your home folder
- the state folder itself
- a folder that holds the state folder
- a folder that holds the working folder
- a folder outside the state folder

`up` checks this before the install. `start` checks it before it
creates the folder. On the other harnesses, the mailbox rules stay as
they were.

Each Codex CLI session gets only these environment variables:

- `PATH`, `HOME`, `USER`, `LOGNAME`, and `SHELL`
- `TMPDIR`, `TMP`, and `TEMP`
- `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, and `TZ`
- `SSL_CERT_FILE` and `SSL_CERT_DIR`
- `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`
- `OPENAI_API_KEY` and `CODEX_HOME`

No other variable passes, and no other `CODEX_` variable passes.

This is not a full boundary. Your own `~/.codex/config.toml` can still
change other keys.

### Exit codes

- `0`: the command finished.
- `1`: a step failed, or a documented gap stopped a step. The output
  names the step.
- `2`: a flag or the roles file is wrong. Nothing was started or
  stopped.

### Known gaps

Some facts that the CLI needs are not documented yet. The CLI names each
gap when it reaches one, and it never guesses.

- The plugin install source on Qwen Code, Hermes Agent, Amp, and
  OpenCode.
- The session ID format that `claude --bg` prints, and the thread ID
  format that `amp -ox` prints.
- A way to keep a finished `codex exec` process running. The supervisor
  does not restart a session that ends.
- A way to give a new Hermes Agent chat its first prompt.

## Your config: the tree and the prompts

A trellis-crew config has two halves. The roles file, `sagespec.yml`,
sets the team layout: which sessions run, who reports to whom, and how
each one starts. The agent definitions are the other half. They are the
prompts that tell each session how to do its role. The two halves form
one config, and you change either one to change how your team works.

## The agent definitions

The agent definitions ship as skills in `skills/`. Hanna Sage wrote
them, and Sage Advice LLC publishes them as open source under the MIT
licence.

| Skill | What it defines |
|---|---|
| `department-lead` | The lead, who names each peer and sends work |
| `department-standby` | A worker, who waits for a hand-off and claims it |
| `department-auditor` | The auditor, who checks the team on a fixed clock |
| `department-reporting-chain` | The reporting chain, which carries decisions to the operator |
| `department-researcher` | The researcher, who answers one question at a time from cited sources |
| `department-handoff-contract` | The hand-off block that a lead sends with each task |
| `department-audit-log` | The log line that the auditor writes for each check |

## Build your own config

1. Copy `sagespec.example.yml` to `sagespec.yml`, and change the team to
   fit your work.
2. Start from the shipped agent definitions. Run your team on them first.
3. Write your own agent definitions. Change a shipped prompt in
   `skills/`, or write your own skill and name it in the `kickoff`
   message of the session that uses it.

## The sanitizer

This repository is public. The sanitizer keeps private text out of it.
Run it with `npm run sanitize`. It scans every tracked file and the
staged diff. For each commit in a range, it scans the message, the added
lines, and the author and committer names and emails. So a leak that one
commit adds and a later commit removes still fails. It fails on four
classes of text.

1. Secrets: an API key or token prefix followed by a full key, a
   private-key block, a committed `.env` file, and a password inside a
   URL.
2. Internal names from your deny-list.
3. Private paths: an absolute home path, such as `/Users/<name>/` or
   `/home/<name>/`, and socket paths.
4. Ticket links to any GitHub repository other than
   sageadvicellc/trellis-crew, and links to a private tracker.

A finding names the class, the file, and the line. It never prints the
text it found.

### The deny-list file

The deny-list is never committed. Keep it in a local file and point the
`SANITIZE_DENYLIST` environment variable at it. CI writes the same
content from the `SANITIZE_DENYLIST_CONTENT` repository secret.

- Write one term per line. A term matches in any letter case, and only
  as a whole word. A term may hold spaces.
- A line that starts with `#` is a comment.
- A line `allow <path> <term>` clears one term in one file. The path is
  relative to the repository root. The allowance never applies to a
  commit message or to a commit author or committer.
- A line `allow @author <term>` clears one term in the commit author and
  committer names and emails. It clears nothing else. The same term
  still fails in a file, a file name, a commit message, or an added
  line. `@author` is a keyword, not a path, so it never clears a file
  named `@author`. The term matches in any letter case, and only as a
  whole word.

```
# deny-list
project-codename
allow docs/history.md project-codename
allow @author project-codename
```

When `SANITIZE_DENYLIST` is unset, a local run prints a warning and still
runs the other three checks. With `SANITIZE_REQUIRE_DENYLIST=1`, an unset
deny-list fails the run. CI and `prepublishOnly` set that variable, so CI
stays red until the maintainer adds the secret.

### The committed allowlist

`.sanitize-allow` holds reviewed false positives for the secret,
private-path, and ticket-link classes. Each line is `<path> <class>`. It
never holds a deny-list allowance.

### The commit range

`npm run sanitize -- --range <base>..<head>` scans the messages and the
added lines in that range. The `SANITIZE_RANGE` variable does the same. With neither, the
range is `origin/main..HEAD` when `origin/main` exists.

### The pre-push hook

`.githooks/pre-push` runs the sanitizer on the commits you push. Turn it
on once per clone with `git config core.hooksPath .githooks`. CI runs the
same checks on every pull request and push.
