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
// LINE allows max 5 messages per reply
const limited = messages.slice(0, 5);
const res = await fetch(‘https://api.line.me/v2/bot/message/reply’, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘Authorization’: `Bearer ${LINE_ACCESS_TOKEN}`
},
body: JSON.stringify({ replyToken, messages: limited })
});
const data = await res.json();
console.log(‘LINE reply:’, JSON.stringify(data));
}

async function downloadLineImage(messageId) {
const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
headers: { ‘Authorization’: `Bearer ${LINE_ACCESS_TOKEN}` }
});
const buffer = await res.arrayBuffer();
return Buffer.from(buffer).toString(‘base64’);
}

function extractUrls(text) {
const igRegex = /https?://(www.)?instagram.com/[^\s]+/g;
const threadsRegex = /https?://(www.)?threads.(net|com)/[^\s]+/g;
const igUrls = text.match(igRegex) || [];
const threadsUrls = text.match(threadsRegex) || [];
return { igUrls, threadsUrls, all: […igUrls, …threadsUrls] };
}

async function callClaude(messages) {
const res = await fetch(‘https://api.anthropic.com/v1/messages’, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘x-api-key’: ANTHROPIC_API_KEY,
‘anthropic-version’: ‘2023-06-01’
},
body: JSON.stringify({
model: ‘claude-haiku-4-5-20251001’,
max_tokens: 1000,
messages
})
});
const data = await res.json();
console.log(‘Claude response:’, JSON.stringify(data));
if (data.error) throw new Error(’Claude API error: ’ + data.error.message);
return data.content[0].text || ‘’;
}

// Extract MULTIPLE locations from text
async function analyzeMultipleFromText(text) {
const { all: urls } = extractUrls(text);
const urlsRemoved = urls.reduce((t, u) => t.replace(u, ‘’), text).trim();

const prompt = `You are a location extraction expert for a LINE bot.

User message:
URLs: ${urls.join(’, ’) || ‘none’}
Text: ${urlsRemoved || ‘none’}

Extract ALL locations/places mentioned. There may be 1 or more places (restaurants, cafes, attractions, etc.).

Respond ONLY with valid JSON array, no markdown:
[
{“placeName”:“name”,“city”:“city”,“country”:“country”,“naverQuery”:“Naver Maps query (Korean if Korean place)”,“googleQuery”:“Google Maps query”,“confidence”:“high”},
…
]

If no locations found, return empty array: []`;

const text2 = await callClaude([{ role: ‘user’, content: prompt }]);
const jsonMatch = text2.match(/[[\s\S]*]/);
if (!jsonMatch) return [];
return JSON.parse(jsonMatch[0]);
}

// Extract MULTIPLE locations from image
async function analyzeMultipleFromImage(base64Image) {
const prompt = `You are a location extraction expert. The user shared a screenshot from Instagram, Threads, or social media.

Identify ALL locations, restaurants, cafes, attractions, or landmarks shown or mentioned in the image.
Check for: location tags, place names in captions, store signs, landmark backgrounds, hashtags with place names.

Respond ONLY with valid JSON array, no markdown:
[
{“placeName”:“name”,“city”:“city”,“country”:“country”,“naverQuery”:“Naver Maps query (Korean if Korean place)”,“googleQuery”:“Google Maps query”,“confidence”:“high”},
…
]

If no locations found, return empty array: []`;

const text = await callClaude([{
role: ‘user’,
content: [
{ type: ‘image’, source: { type: ‘base64’, media_type: ‘image/jpeg’, data: base64Image } },
{ type: ‘text’, text: prompt }
]
}]);

const jsonMatch = text.match(/[[\s\S]*]/);
if (!jsonMatch) return [];
return JSON.parse(jsonMatch[0]);
}

function buildLocationMessage(place, index, total) {
const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(place.naverQuery || place.placeName)}`;
const googleUrl = `https://www.google.com/maps/search/${encodeURIComponent(place.googleQuery || place.placeName)}`;

const confidenceEmoji = { high: ‘✅’, medium: ‘🟡’, low: ‘⚠️’ };
const emoji = confidenceEmoji[place.confidence] || ‘📍’;
const location = [place.city, place.country].filter(Boolean).join(’, ’);

const header = total > 1 ? `【${index + 1}/${total}】` : ‘’;
let text = `${header}${emoji} ${place.placeName}`;
if (location) text += `\n📍 ${location}`;
text += `\n\n🗺 Naver Maps：\n${naverUrl}`;
text += `\n\n🌐 Google Maps：\n${googleUrl}`;

return { type: ‘text’, text };
}

app.post(’/webhook’, async (req, res) => {
res.status(200).send(‘OK’);

if (!verifySignature(req)) return;

const events = req.body.events || [];

for (const event of events) {
if (event.type !== ‘message’) continue;

```
const replyToken = event.replyToken;
const msgType = event.message.type;

try {
  let places = [];

  if (msgType === 'image') {
    console.log('Processing image');
    const base64 = await downloadLineImage(event.message.id);
    places = await analyzeMultipleFromImage(base64);

  } else if (msgType === 'text') {
    const text = event.message.text;
    console.log('Processing text:', text);

    const { all: urls } = extractUrls(text);
    const caption = urls.reduce((t, u) => t.replace(u, ''), text).trim();

    if (urls.length > 0 && !caption) {
      await replyToLine(replyToken, [{
        type: 'text',
        text: '🔍 只有連結沒辦法找到景點喔！\n\n可以試試：\n・連結 + 說明文字\n・直接傳地名\n・傳截圖 📸'
      }]);
      continue;
    }

    places = await analyzeMultipleFromText(text);
  } else {
    continue;
  }

  if (places.length === 0) {
    await replyToLine(replyToken, [{
      type: 'text',
      text: '🔍 找不到景點資訊\n\n可以試試：\n・貼連結時附上說明文字\n・直接傳地名（例如：首爾弘大烤肉）\n・傳 IG 或 Threads 的截圖 📸'
    }]);
    continue;
  }

  // Build one message per place (max 5 for LINE)
  const messages = places.slice(0, 5).map((place, i) =>
    buildLocationMessage(place, i, Math.min(places.length, 5))
  );

  await replyToLine(replyToken, messages);

} catch (err) {
  console.error('Error:', err.message);
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
