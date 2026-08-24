// Akuki: per-role provider routing.
//
// borg resolves ONE LLM client for every model role -- createLlmFactory
// (src/borg/clients.ts:79-93) is `if (llmClient !== undefined) return () => llmClient`.
// The BORG_MODEL_* env vars choose model *ids*, not providers, so "Anthropic for
// cognition, a cheap endpoint for the volume roles" cannot be expressed in
// configuration. This client dispatches on the per-call model id instead.
//
// Streaming is deliberately NOT implemented. streamComplete/streamConverse are
// optional on LLMClient, OpenAICompatibleLLMClient does not provide them, and
// borg's own memory sidecar already runs against a non-streaming client. Declaring
// them here would promise streaming for endpoint models that cannot stream.

import {
  AnthropicLLMClient,
  OpenAICompatibleLLMClient,
  type LLMClient,
  type LLMCompleteOptions,
  type LLMCompleteResult,
  type LLMConverseOptions,
  type LLMConverseResult,
  type TokenUsageSink,
} from "../llm/index.js";

export type AkukiLLMRouterOptions = {
  // Omit to run every role on the OpenAI-compatible endpoint. A claude-* model
  // requested while this is absent is a configuration error, not a silent fallback:
  // quietly demoting Akuki's cognition to a different provider would corrupt any
  // measurement taken across the switch.
  anthropicApiKey?: string;
  // Passed straight to AnthropicLLMClient so borg's own resolver can pick up
  // ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY and, importantly, ANTHROPIC_BASE_URL
  // (src/llm/index.ts:1785 resolveAnthropicAuth, :1834 baseURL) -- which is how a
  // proxy endpoint works without any code of our own.
  anthropicEnv?: NodeJS.ProcessEnv;
  openAiBaseUrl: string;
  openAiApiKey: string;
  requestTimeoutMs?: number;
  usageSink?: TokenUsageSink;
};

// borg's own max-output table keys off this same family shape
// (getModelMaxOutputTokens, src/llm/max-tokens.ts:9).
export function isAnthropicModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("claude-");
}

export class AkukiLLMRouter implements LLMClient {
  private readonly options: AkukiLLMRouterOptions;
  // Built lazily: OpenAICompatibleLLMClient throws in its constructor when the API
  // key is blank (openai-compatible.ts:262). Constructing it eagerly would make an
  // Anthropic-only run impossible even though it never touches the endpoint.
  private openAi?: OpenAICompatibleLLMClient;
  private readonly anthropic?: AnthropicLLMClient;

  constructor(options: AkukiLLMRouterOptions) {
    this.options = options;

    const env = options.anthropicEnv;
    const explicitKey = options.anthropicApiKey?.trim() ?? "";
    const envHasCredentials =
      (env?.ANTHROPIC_API_KEY?.trim() ?? "") !== "" ||
      (env?.ANTHROPIC_AUTH_TOKEN?.trim() ?? "") !== "";

    if (explicitKey !== "") {
      this.anthropic = new AnthropicLLMClient({
        apiKey: explicitKey,
        authMode: "api-key",
        ...(env ? { env } : {}),
        usageSink: options.usageSink,
      });
    } else if (envHasCredentials && env) {
      // authMode stays "auto": with only ANTHROPIC_AUTH_TOKEN set this resolves to
      // the token path and honours ANTHROPIC_BASE_URL, so a proxy just works.
      this.anthropic = new AnthropicLLMClient({ env, usageSink: options.usageSink });
    }
  }

  private pick(model: string): LLMClient {
    if (!isAnthropicModel(model)) {
      this.openAi ??= new OpenAICompatibleLLMClient({
        baseUrl: this.options.openAiBaseUrl,
        apiKey: this.options.openAiApiKey,
        requestTimeoutMs: this.options.requestTimeoutMs,
        usageSink: this.options.usageSink,
      });

      return this.openAi;
    }

    if (this.anthropic === undefined) {
      throw new Error(
        `AkukiLLMRouter: model "${model}" needs an Anthropic key, but none was configured. ` +
          `Set ANTHROPIC_API_KEY (pass show akuki/anthropic-key), or point every ` +
          `BORG_MODEL_* role at an endpoint model.`,
      );
    }

    return this.anthropic;
  }

  async complete(options: LLMCompleteOptions): Promise<LLMCompleteResult> {
    return this.pick(options.model).complete(options);
  }

  async converse(options: LLMConverseOptions): Promise<LLMConverseResult> {
    return this.pick(options.model).converse(options);
  }
}
