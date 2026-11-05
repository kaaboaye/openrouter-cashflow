// Display names and company grouping for providers and model authors.

/** Providers that belong to the same company are merged in "company" view. */
const COMPANY_OF: Record<string, string> = {
  'google-vertex': 'Google',
  'google-ai-studio': 'Google',
  'amazon-bedrock': 'Amazon',
  'claude-on-aws': 'Amazon',
  azure: 'Microsoft',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  xai: 'SpaceXAI',
  alibaba: 'Alibaba',
  tencent: 'Tencent',
  baidu: 'Baidu',
  'moonshotai': 'Moonshot AI',
  'z-ai': 'Z.ai',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  nebius: 'Nebius',
  modelrun: 'Modular',
  voyageai: 'MongoDB',
  'inference-net': 'inference.net',
};

export function companyOf(providerSlug: string, providerName?: string): string {
  return COMPANY_OF[providerSlug] ?? providerName ?? prettify(providerSlug);
}

const AUTHOR_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
  moonshotai: 'Moonshot AI',
  'z-ai': 'Z.ai',
  'x-ai': 'xAI',
  qwen: 'Qwen',
  'meta-llama': 'Meta Llama',
  meta: 'Meta',
  mistralai: 'Mistral AI',
  minimax: 'MiniMax',
  tencent: 'Tencent',
  xiaomi: 'Xiaomi',
  nvidia: 'NVIDIA',
  stepfun: 'StepFun',
  'stepfun-ai': 'StepFun',
  cohere: 'Cohere',
  amazon: 'Amazon',
  microsoft: 'Microsoft',
  bytedance: 'ByteDance',
  'bytedance-seed': 'ByteDance Seed',
  inclusionai: 'inclusionAI',
  liquid: 'Liquid',
  perplexity: 'Perplexity',
  openrouter: 'OpenRouter',
  typesafe: 'TypeSafe',
  'nousresearch': 'Nous Research',
  'arcee-ai': 'Arcee AI',
  baidu: 'Baidu',
  'ai21': 'AI21',
  ibm: 'IBM',
  'ibm-granite': 'IBM Granite',
  poolside: 'Poolside',
  'particle-ai': 'Particle AI',
  alibaba: 'Alibaba',
};

export function authorName(slug: string): string {
  return AUTHOR_NAMES[slug] ?? prettify(slug);
}

export function prettify(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^[a-z]+$/.test(w) && w !== 'net' ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** "deepseek/deepseek-v4.1-flash-20261017" -> "deepseek-v4.1-flash" (best effort when the catalog has no name) */
export function shortModelName(permaslug: string): string {
  const tail = permaslug.split('/').pop() ?? permaslug;
  return tail.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}
