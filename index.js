const express = require(‘express’);
const crypto = require(‘crypto’);

const app = express();

app.use(express.json({
verify: (req, res, buf) => { req.rawBody = buf; }
}));

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function verifySignature(req) {
const signature = req.headers[‘x-line-signature’];
if (!signature) return false;
const hash = crypto
.createHmac(‘SHA256’, LINE_CHANNEL_SECRET)
.update(req.rawBody)
.digest(‘base64’);
return hash === signature;
}

async function replyToLine(replyToken, messages) {
await fetch(‘https://api.line.me/v2/bot/message/reply’, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘Authorization’: `Bearer ${LINE_ACCESS_TOKEN}`
},
body: JSON.stringify({ replyToken, messages })
});
}

function extractIgUrls(text) {
const regex = /https?://(www.)?instagram.com/[^\s]+/g;
return text.match(regex) || [];
}

async function analyzeLocation(igUrl, caption = ‘’) {
const prompt = `You are a location extraction expert for a LINE bot that helps users save Instagram places to Naver Maps.

Instagram URL: ${igUrl}
${caption ? `Post caption/text: ${caption}` : ‘’}

Extract the place/location from this Instagram post. If the caption contains location info, use it.

You MUST respond ONLY with a valid JSON object. No markdown, no backticks, no explanation, just raw JSON:
{“detected”:true,“placeName”:“place name”,“city”:“city”,“country”:“country”,“naverQuery”:“search query for Naver Maps”,“googleQuery”:“search query for Google Maps”,“confidence”:“high”,“tip”:“short tip in Traditional Chinese”}

If no location found: {“detected”:false,“placeName”:null,“city”:null,“country”:null,“naverQuery”:null,“googleQuery”:null,“confidence”:“low”,“tip”:“請附上貼文說明文字”}`;

const res = await fetch(‘https://api.anthropic.com/v1/messages’, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘x-api-key’: ANTHROPIC_API_KEY,
‘anthropic-version’: ‘2023-06-01’
},
body: JSON.stringify({
model: ‘claude-sonnet-4-20250514’,
max_tokens: 500,
messages: [{ role: ‘user’, content: prompt }]
})
});

const data = await res.json();
console.log(‘Claude raw response:’, JSON.stringify(data));

if (!data.content || !data.content[0]) {
throw new Error(‘No content in Claude response’);
}

const text = data.content[0].text || ‘’;
console.log(‘Claude text:’, text);

// Extract JSON from response robustly
const jsonMatch = text.match(/{[\s\S]*}/);
if (!jsonMatch) {
throw new Error(’No JSON found in response: ’ + text);
}

return JSON.parse(jsonMatch[0]);
}

function buildReplyMessage(result) {
if (!result.detected || !result.placeName) {
return [{
type: ‘text’,
text: ‘🔍 找不到景點資訊\n\n把貼文的文字說明也一起傳過來，我再幫你找！’
}];
}

const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(result.naverQuery || result.placeName)}`;
const googleUrl = `https://www.google.com/maps/search/${encodeURIComponent(result.googleQuery || result.placeName)}`;

const confidenceEmoji = { high: ‘✅’, medium: ‘🟡’, low: ‘⚠️’ };
const emoji = confidenceEmoji[result.confidence] || ‘📍’;
const location = [result.city, result.country].filter(Boolean).join(’, ’);

let text = `${emoji} ${result.placeName}`;
if (location) text += `\n📍 ${location}`;
if (result.tip) text += `\n💡 ${result.tip}`;
text += `\n\n🗺 Naver Maps：\n${naverUrl}`;
text += `\n\n🌐 Google Maps：\n${googleUrl}`;

return [{ type: ‘text’, text }];
}

app.post(’/webhook’, async (req, res) => {
res.status(200).send(‘OK’);

if (!verifySignature(req)) {
console.log(‘Invalid signature’);
return;
}

const events = req.body.events || [];

for (const event of events) {
if (event.type !== ‘message’ || event.message.type !== ‘text’) continue;

```
const text = event.message.text;
const replyToken = event.replyToken;
const igUrls = extractIgUrls(text);

if (igUrls.length === 0) continue;

const igUrl = igUrls[0];
const caption = text.replace(igUrl, '').trim();

try {
  const result = await analyzeLocation(igUrl, caption);
  const messages = buildReplyMessage(result);
  await replyToLine(replyToken, messages);
} catch (err) {
  console.error('Error details:', err.message);
  await replyToLine(replyToken, [{
    type: 'text',
    text: '⚠️ 解析時發生錯誤，請稍後再試。'
  }]);
}
```

}
});

app.get(’/’, (req, res) => res.send(‘LINE Bot is running!’));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
