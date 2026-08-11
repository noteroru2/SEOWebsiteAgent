export interface SeoRule {
  code: string;
  evaluate(input: unknown): readonly unknown[];
}
