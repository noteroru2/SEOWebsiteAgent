import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENAI_MAX_RETRIES, createGovernedOpenAiClient } from '@seo-agent/ai';
import { OpenAiSourcePlanProvider, type SourceContext } from '@seo-agent/source-understanding';

const context: SourceContext = {
  repository: { headSha: 'a'.repeat(40), branch: 'main', clean: true },
  routeMapping: {
    routePath: '/',
    status: 'EXACT_STATIC_ROUTE',
    primarySourcePath: 'src/pages/index.astro',
    relatedSourcePaths: [],
    evidence: {},
  },
  files: [],
  totalCharacters: 0,
  redactions: 0,
};

const validPlan = {
  verdict: 'NEEDS_MORE_EVIDENCE',
  confidence: 'LOW',
  batch5_reconciliation: 'NEEDS_MORE_EVIDENCE',
  summary: 'More evidence is required.',
  source_findings: [],
  change_items: [],
  preserve: [],
  additional_evidence_needed: ['Confirm the remaining evidence.'],
  unknowns: ['Current result is bounded.'],
};

function responseBody(output: unknown) {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 3000,
    model: 'gpt-5.6-terra',
    output: [
      {
        id: 'msg_test',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            annotations: [],
            logprobs: [],
            text: JSON.stringify(output),
          },
        ],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: 'medium', summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'json_schema' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 20,
    },
  };
}

function sourceInput() {
  return {
    opportunity: {},
    batch5: {},
    context,
    evidencePacket: {},
  };
}

function ownerResearchSourceInput() {
  return {
    subjectType: 'OWNER_RESEARCH_CASE' as const,
    ownerResearch: {
      subject: { type: 'OWNER_RESEARCH_CASE', id: crypto.randomUUID(), query: 'research query' },
      gsc: { metrics: { clicks: 0, impressions: 15, ctr: 0, position: 5.6 } },
      ownerFacts: [],
      evidence: { serp: 'NONE' },
    },
    context,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('governed OpenAI no-retry transport', () => {
  it('centralizes production clients on maxRetries=0', () => {
    const client = createGovernedOpenAiClient('test-key');
    expect(OPENAI_MAX_RETRIES).toBe(0);
    expect(client.maxRetries).toBe(0);
  });

  for (const [name, status, code] of [
    ['429', 429, 'AI_RATE_LIMITED'],
    ['500', 500, 'AI_PROVIDER_ERROR'],
  ] as const) {
    it(`makes one provider attempt for ${name}`, async () => {
      let attempts = 0;
      vi.stubGlobal('fetch', async () => {
        attempts++;
        return new Response(
          JSON.stringify({ error: { message: 'safe failure', type: 'test_error' } }),
          { status, headers: { 'content-type': 'application/json' } },
        );
      });
      const provider = new OpenAiSourcePlanProvider('test-key');
      await expect(
        provider.generate(sourceInput(), new AbortController().signal),
      ).rejects.toMatchObject({
        code,
      });
      expect(attempts).toBe(1);
    });
  }

  it('makes one provider attempt for a connection error', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts++;
      throw new TypeError('connection failed');
    });
    const provider = new OpenAiSourcePlanProvider('test-key');
    await expect(
      provider.generate(sourceInput(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
    });
    expect(attempts).toBe(1);
  });

  it('makes one provider attempt when the request times out', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      attempts++;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const provider = new OpenAiSourcePlanProvider('test-key');
    const controller = new AbortController();
    const pending = provider.generate(sourceInput(), controller.signal);
    await vi.waitFor(() => expect(attempts).toBe(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(attempts).toBe(1);
  });

  it('uses one request for success and no fallback model', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responseBody(validPlan)), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-test' },
      });
    });
    const provider = new OpenAiSourcePlanProvider('test-key');
    const result = await provider.generate(sourceInput(), new AbortController().signal);
    expect(result.result.verdict).toBe('NEEDS_MORE_EVIDENCE');
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]?.model).toBe('gpt-5.6-terra');
  });

  it('does not issue a repair request for invalid structured output', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts++;
      return new Response(JSON.stringify(responseBody({})), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = new OpenAiSourcePlanProvider('test-key');
    await expect(
      provider.generate(sourceInput(), new AbortController().signal),
    ).rejects.toBeTruthy();
    expect(attempts).toBe(1);
  });

  it('makes one Owner Research provider attempt with no fallback or repair', async () => {
    let attempts = 0;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      attempts++;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responseBody({})), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = new OpenAiSourcePlanProvider('test-key');
    await expect(
      provider.generate(ownerResearchSourceInput(), new AbortController().signal),
    ).rejects.toBeTruthy();
    expect(attempts).toBe(1);
    expect(bodies[0]?.model).toBe('gpt-5.6-terra');
    expect(bodies[0]?.tools).toBeUndefined();
  });
});
