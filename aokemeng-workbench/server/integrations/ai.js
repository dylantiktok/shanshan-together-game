'use strict';
/**
 * AI 服务接入：Claude（Anthropic 官方 SDK）与 OpenAI（REST）。
 * 未配置 API Key 时抛出 NotConnectedError。AI 输出仅作运营建议，界面上明确标注。
 */
const { NotConnectedError, PlatformApiError, NetworkError, httpJson } = require('./errors');

const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-4.1' };

async function askClaude(cfg, system, prompt) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 2 });
  let res;
  try {
    // 使用服务端 fallbacks：遇到安全分类器拒答时由平台自动路由到备用模型
    res = await client.beta.messages.create({
      model: cfg.model || DEFAULT_MODELS.anthropic,
      max_tokens: 16000,
      output_config: { effort: cfg.effort || 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new NotConnectedError(`Claude API 密钥无效或无权限: ${e.message}`);
    }
    if (e instanceof Anthropic.APIConnectionError) throw new NetworkError(`无法连接 Claude API: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new PlatformApiError(`Claude API 错误 (${e.status}): ${e.message}`);
    throw e;
  }
  if (res.stop_reason === 'refusal') {
    throw new PlatformApiError(`Claude 拒绝了此请求${res.stop_details?.explanation ? '：' + res.stop_details.explanation : ''}`);
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, model: res.model, usage: res.usage, truncated: res.stop_reason === 'max_tokens' };
}

async function askOpenAI(cfg, system, prompt) {
  const base = cfg.baseUrl || 'https://api.openai.com/v1';
  const { status, body } = await httpJson(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || DEFAULT_MODELS.openai,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
  }, 120000);
  if (status === 401 || status === 403) throw new NotConnectedError(`OpenAI API 密钥无效或无权限`);
  if (status >= 400) throw new PlatformApiError(`OpenAI API 错误 (${status}): ${body.error?.message || ''}`);
  return { text: body.choices?.[0]?.message?.content || '', model: body.model, usage: body.usage };
}

async function ask(provider, cfg, system, prompt) {
  if (!cfg?.apiKey) throw new NotConnectedError(`${provider === 'openai' ? 'OpenAI' : 'Claude'} 未连接：未配置 API Key`);
  if (provider === 'anthropic') return askClaude(cfg, system, prompt);
  if (provider === 'openai') return askOpenAI(cfg, system, prompt);
  throw new NotConnectedError(`不支持的 AI 服务: ${provider}`);
}

module.exports = { ask, DEFAULT_MODELS };
