import {
  aiError,
  type ProviderAnalysis,
  type ReasoningProvider,
  type RecommendationResult,
} from '@seo-agent/ai';

export type FakeAiMode = 'success' | 'timeout' | '429' | '5xx' | 'auth' | 'malformed';

export const fakeRecommendation: RecommendationResult = {
  verdict: 'INVESTIGATE',
  confidence: 'MEDIUM',
  summary: 'ตรวจสอบความสอดคล้องของเจตนาค้นหากับหน้าปัจจุบันก่อนแก้ไข',
  evidence_used: [{ type: 'GSC', fact: 'The persisted signal has 120 impressions at position 8.' }],
  interpretations: [
    { statement: 'The page may benefit from an intent review.', confidence: 'LOW' },
  ],
  recommended_actions: [
    {
      action_type: 'REVIEW_SEARCH_INTENT',
      title: 'ตรวจสอบเจตนาค้นหา',
      description: 'ให้เจ้าของตรวจสอบข้อความในหน้าจริงเทียบกับคำค้นก่อนตัดสินใจ',
      risk: 'LOW',
      expected_goal: 'ยืนยันว่าหน้านี้เหมาะเป็นเจ้าของคำค้น',
      requires_human_review: true,
    },
  ],
  do_not_do: ['Do not promise ranking gains.'],
  additional_evidence_needed: ['Review the page body, which was not persisted.'],
  unknowns: ['Current SERP features and competitor behavior are unknown.'],
};

export class FakeAiProvider implements ReasoningProvider {
  calls = 0;
  constructor(public mode: FakeAiMode = 'success') {}
  async analyze(
    _context: unknown,
    _config: unknown,
    signal: AbortSignal,
  ): Promise<ProviderAnalysis> {
    this.calls++;
    if (signal.aborted || this.mode === 'timeout')
      throw aiError('AI_TIMEOUT', 'AI request timed out', true);
    if (this.mode === '429') throw aiError('AI_RATE_LIMITED', 'Rate limited', true);
    if (this.mode === '5xx') throw aiError('AI_PROVIDER_ERROR', 'Provider failed', true);
    if (this.mode === 'auth') throw aiError('AI_AUTH_ERROR', 'Authentication failed');
    if (this.mode === 'malformed') throw aiError('AI_SCHEMA_INVALID', 'Schema invalid');
    return {
      result: fakeRecommendation,
      providerRequestId: `fake-${this.calls}`,
      inputTokens: 800,
      cachedInputTokens: 200,
      outputTokens: 180,
      latencyMs: 25,
    };
  }
}
