# Akuki: one-turn Oracle smoke test

This entry point opens Akuki directly, applies the seed, runs exactly one turn, prints token
usage, and closes Borg. It does not start the generic memory sidecar, internalization,
simulation, autonomy, or maintenance schedulers, and it does not install a Bot Arena connector.

## Protected environment file

The application repository is `/opt/akuki/app`, and the process runs as the system user `akuki`.
Prepare the protected configuration and the fresh memory directory as follows:

```sh
sudo install -d -o root -g akuki -m 0750 /etc/akuki
sudo touch /etc/akuki/akuki-smoke.env
sudo chown root:akuki /etc/akuki/akuki-smoke.env
sudo chmod 0640 /etc/akuki/akuki-smoke.env
sudo install -d -o akuki -g akuki -m 0750 /var/lib/akuki/data/akuki-smoke
sudoedit /etc/akuki/akuki-smoke.env
```

Enter the secret only through `sudoedit`. Never put the real key or token in a command, the
repository, or shell history. Choose exactly one authentication block.

For direct Anthropic access use:

```sh
ANTHROPIC_API_KEY=<secret>
```

For Tomek's explicitly approved AI proxy use only these transport settings:

```sh
ANTHROPIC_AUTH_TOKEN=<secret>
ANTHROPIC_BASE_URL=https://<aiproxy-host>
AKUKI_ANTHROPIC_PROXY=1
```

Then add the common smoke-test settings:

```sh
AKUKI_ANTHROPIC_ONLY=1
AKUKI_DATA_DIR=/var/lib/akuki/data/akuki-smoke

# Select the Claude ids explicitly. They may be the same or different.
BORG_MODEL_COGNITION=claude-<model>
BORG_MODEL_EXTRACTION=claude-<model>
BORG_MODEL_RECALL_EXPANSION=claude-<model>
BORG_MODEL_BACKGROUND=claude-<model>
BORG_MODEL_CREATOR_DIRECTIVE=claude-<model>

BORG_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
BORG_EMBEDDING_API_KEY=ollama
BORG_EMBEDDING_MODEL=bge-m3
BORG_EMBEDDING_DIMS=1024
```

The smoke guard runs before `Borg.open()`. It rejects a missing/non-`claude-*` model role,
missing embedding endpoint/model/dimensions, invalid dimensions, and fake embeddings. In this
mode no missing volume role is populated from the normal Kratos default. An explicitly set
`AKUKI_ENDPOINT_MODEL=claude-...` may still populate the four volume roles; validation checks
the final values Borg will read.

Authentication is deliberately unambiguous. Direct mode requires a non-empty
`ANTHROPIC_API_KEY` and no `ANTHROPIC_BASE_URL`. Proxy mode requires
`AKUKI_ANTHROPIC_PROXY=1`, a non-empty `ANTHROPIC_AUTH_TOKEN`, and an absolute HTTP(S)
`ANTHROPIC_BASE_URL`; it rejects a simultaneously configured `ANTHROPIC_API_KEY`. Without the
approval flag, any `ANTHROPIC_BASE_URL` is rejected. The guard also rejects the known Kratos
hosts `inference.kratos.p4.int` and `inference.kratos.omc.hdp.it.p4`. Authentication secrets are
never included in validation errors or logs. The legacy `AKUKI_ANTHROPIC_API_KEY` override is
not accepted in this smoke mode, so it cannot silently supersede the selected standard auth
variables.

All five model ids must be supplied by the operator according to Tomek's proxy configuration.
Do not probe the proxy with `GET /v1/models`; support for that endpoint is not assumed.

## Checks and the one turn

Confirm that Ollama exposes its OpenAI-compatible API and that BGE-M3 is installed:

```sh
sudo -u akuki -H sh -c 'curl -fsS http://127.0.0.1:11434/v1/models'
sudo -u akuki -H sh -c 'ollama list'
```

No separate seed command is needed: the turn command calls `applyAkukiSeed()` before the turn.
If an operator wants to inspect seeding separately, this is safe and idempotent, but opening a
fresh tenant can initialize storage and therefore must use the same 1024D embedding config:

```sh
sudo -u akuki -H sh -c '
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL AKUKI_ANTHROPIC_PROXY
  set -a
  . /etc/akuki/akuki-smoke.env
  set +a
  cd /opt/akuki/app
  exec ./node_modules/.bin/tsx scripts/akuki-seed.ts
'
```

Run exactly one turn (quote the message so it remains one argument):

```sh
sudo -u akuki -H sh -c '
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL AKUKI_ANTHROPIC_PROXY
  set -a
  . /etc/akuki/akuki-smoke.env
  set +a
  cd /opt/akuki/app
  exec ./node_modules/.bin/tsx scripts/akuki-turn.ts \
    "Cześć, Akuki. To jest jedna kontrolowana tura testowa."
'
```

The command ends with a parseable JSON block similar to:

```json
{
  "calls": 6,
  "inputTokens": 12345,
  "outputTokens": 678,
  "cacheReadInputTokens": 900,
  "cacheCreationInputTokens": 1200,
  "byModel": [
    {
      "model": "claude-<model>",
      "calls": 6,
      "inputTokens": 12345,
      "outputTokens": 678,
      "cacheReadInputTokens": 900,
      "cacheCreationInputTokens": 1200
    }
  ]
}
```

The numbers above are illustrative. `TokenUsageEvent.model` contains the model id returned by the
provider when the response exposes one, and otherwise falls back to the requested id. A usage
event is emitted after a response is received, so a request that fails or is interrupted before a
response has no event and cannot be counted here.

Do not use `npm start`: it launches the generic memory sidecar, not Akuki's one-turn entry point.
For this first test do not run `scripts/akuki-internalization.ts`, the simulator, autonomy, or
maintenance. The turn entry point constructs those scheduler facades as part of `Borg.open()` but
does not start their recurring loops.

Keep `/var/lib/akuki/data/akuki-smoke` dedicated to BGE-M3 at 1024 dimensions. Borg compares
existing LanceDB vector field schemas with the configured dimension while opening tables and
fails with `LANCEDB_SCHEMA_MISMATCH` if, for example, this memory is later opened as 4096D. It
also rejects an embedding response whose vector length differs from `BORG_EMBEDDING_DIMS`.

## What seeding does

`applyAkukiSeed()` makes no LLM or embedding calls. It reads the checked-in temperament and
scaffolding, writes four prompt overrides when their compiled text changed, and resolves/assigns
the configured attachment figure as the single creator when needed. It first compares prompt
text and the current creator, so an unchanged second run performs no writes and creates no
identity-event churn. The turn command already applies it, so the standalone command is optional.
