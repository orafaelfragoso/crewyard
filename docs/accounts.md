# Accounts

An **account** (a provider profile) tells Crewyard how to log in to an agent CLI. Agents use accounts; an account never holds code or tasks. Each account has a reference like `claude/personal` (provider and name).

## Pick a setup

| You want | Use |
|---|---|
| The login you already use in `claude`, `codex` or `opencode` | [Reuse your existing login](#reuse-your-existing-login) |
| A separate login just for Crewyard, or several accounts for one provider | [A separate login](#a-separate-login) |
| An API key instead of a login | [API key](#api-key) |

## Reuse your existing login

```bash
crew account add --provider claude --name personal --use-default-config
crew account test claude/personal
```

Crewyard runs the CLI with its normal configuration, so whatever `claude auth status` (or `codex login status`) shows is what Crewyard uses. Only one account per provider can do this.

## A separate login

Without `--use-default-config`, Crewyard gives the account its own configuration directory, so it never shares settings, sessions or credentials with your own use of the CLI:

```bash
crew account add --provider claude --name work
crew account login claude/work
```

`crew account login` opens the provider's own login (`claude auth login`, `codex login`, `opencode auth login`) inside that account's directory, then checks the result. Log in with the account you want Crewyard to use. Running it again on a logged-in account only reports the status.

Add as many as you need:

```bash
crew account add --provider claude --name work-2
crew account login claude/work-2
```

Where the directory lives: `crewyard/profiles/<provider>/<name>` in the [data directory](installation.md#where-data-lives). To use your own path, pass `--config-root <dir>`.

## API key

```bash
crew account add --provider claude --name api --auth api-key --api-key-stdin
```

It prompts for the key without echoing it and stores it in your OS secret store (macOS Keychain, Windows Credential Manager or Linux Secret Service). The key is never written to Crewyard's database, config files or logs. In scripts, pipe the key in, or use `--api-key-env ANTHROPIC_API_KEY` to read it once from a variable.

API keys work for `claude`, `codex` and `opencode`.

## Local and custom agents

```bash
crew account add --provider ollama --name local --endpoint http://localhost:11434
crew account add --provider generic --name my-agent --command /usr/local/bin/my-agent
```

See the [Ollama](provider-adapters/ollama.md) and [generic process](provider-adapters/generic.md) adapters.

## Use accounts in agents

One account:

```bash
crew agent create --name engineer --provider claude --account claude/work
```

Several accounts in order of preference, so work moves to the next account when one is rate limited or logged out:

```bash
crew account policy claude-pool --profiles claude/work,claude/work-2 --allow-fallback
crew agent create --name engineer --provider claude --policy claude-pool
```

Without `--allow-fallback`, an agent only uses the first account, and its work pauses while that account is rate limited.

## Manage accounts

| Task | Command |
|---|---|
| List accounts | `crew account list` |
| Check one | `crew account test claude/work` |
| Log in again | `crew account login claude/work` |
| Show details | `crew account show claude/work` |
| Remove one, and its stored key | `crew account remove claude/work` (add `--purge-config-root` to delete its directory) |

Per-provider details, such as which environment variable isolates each CLI, are in the [provider adapter docs](provider-adapters/overview.md).
