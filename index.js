const express = require('express');
const crypto = require('crypto');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function verifySignature(req) {
  const signature = req.headers['x-line-signature'];
  if (!signature) return false;
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest('base64');
  return hash === signature;
}

async function replyToLine(replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
  const data = await res.json();
  console.log('LINE reply result:', JSON.stringify(data));
}

function extractIgUrls(text) {
  const regex = /https?:\/\/(www\.)?instagram\.com\/[^\s]+/g;
  return text.match(regex) || [];
}

async function analyzeLocation(igUrl, caption = '') {
  const prompt = `Extract location from this Instagram URL and caption. Respond with ONLY a JSON object, nothing else.

URL: ${igUrl}
Caption: ${caption}

JSON format:
{"detected":true,"placeName":"name","city":"city","country":"country","naverQuery":"query","googleQuery":"query","confidence":"high","tip":"tip in Chinese"}

If no location found:
{"detected":false,"placeName":null,"city":null,"country":null,"naverQuery":null,"googleQuery":null,"confidence":"low","tip":"請附上說明文字"}`;

  console.log('Calling Claude API...');
  console.log('API Key starts with:', ANTHROPIC_API_KEY ? ANTHROPIC_API_KEY.substring(0, 20) : 'MISSING');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  console.log('Claude API status:', res.status);
  const data = await res.json();
  console.log('Claude API response:', JSON.stringify(data));

  if (data.error) {
    throw new Error('Claude API error: ' + data.error.message);
  }

  if (!data.content || !data.content[0]) {
    throw new Error('No content in response: ' + JSON.stringify(data));
  }

  const text = data.content[0].text || '';
  console.log('Claude text:', text);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON in: ' + text);
  }

  return JSON.parse(jsonMatch[0]);
}

function buildReplyMessage(result) {
  if (!result.detected || !result.placeName) {
    return [{
      type: 'text',
      text: '🔍 找不到景點資訊\n\n把貼文的文字說明也一起傳過來，我再幫你找！'
    }];
  }

  const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(result.naverQuery || result.placeName)}`;
  const googleUrl = `https://www.google.com/maps/search/${encodeURIComponent(result.googleQuery || result.placeName)}`;

  const confidenceEmoji = { high: '✅', medium: '🟡', low: '⚠️' };
  const emoji = confidenceEmoji[result.confidence] || '📍';
  const location = [result.city, result.country].filter(Boolean).join(', ');

  let text = `${emoji} ${result.placeName}`;
  if (location) text += `\n📍 ${location}`;
  if (result.tip) text += `\n💡 ${result.tip}`;
  text += `\n\n🗺 Naver Maps：\n${naverUrl}`;
  text += `\n\n🌐 Google Maps：\n${googleUrl}`;

  return [{ type: 'text', text }];
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  if (!verifySignature(req)) {
    console.log('Invalid signature');
    return;
  }

  const events = req.body.events || [];
  console.log('Events received:', events.length);

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text;
    const replyToken = event.replyToken;
    console.log('Message:', text);

    const igUrls = extractIgUrls(text);
    if (igUrls.length === 0) continue;

    const igUrl = igUrls[0];
    const caption = text.replace(igUrl, '').trim();

    try {
      const result = await analyzeLocation(igUrl, caption);
      const messages = buildReplyMessage(result);
      await replyToLine(replyToken, messages);
    } catch (err) {
      console.error('Error:', err.message);
      await replyToLine(replyToken, [{
        type: 'text',
        text: '⚠️ 錯誤：' + err.message.substring(0, 100)
      }]);
    }
  }
});

app.get('/', (req, res) => res.send('LINE Bot is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
