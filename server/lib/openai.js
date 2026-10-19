// Read per call rather than at module load, so a key set after startup (the test
// harness's OpenAI mock sets it around each mocked call) is picked up.
const apiKey = () => process.env.OPENAI_API_KEY;
const model = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Shared OpenAI chat-completions call that returns the parsed JSON body
 * from the model message. Callers own prompt-building and response validation.
 */
async function chatCompletionJson(prompt, { temperature } = {}) {
  if (!apiKey()) {
    throw new Error('OPENAI_API_KEY is not configured on the server');
  }

  console.log(`[openai] prompt:\n${prompt}`);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: model(),
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[openai] request failed (${res.status}): ${errText}`);
    throw new Error(`OpenAI request failed (${res.status})`);
  }

  const data = await res.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  console.log(`[openai] response:\n${raw}`);
  return JSON.parse(raw);
}

module.exports = { chatCompletionJson };
