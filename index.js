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
  console.log('LINE reply:', JSON.stringify(data));
}

// Download image from LINE
async function downloadLineImage(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` }
  });
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

function extractUrls(text) {
  const igRegex = /https?:\/\/(www\.)?instagram\.com\/[^\s]+/g;
  const threadsRegex = /https?:\/\/(www\.)?threads\.(net|com)\/[^\s]+/g;
  const igUrls = text.match(igRegex) || [];
  const threadsUrls = text.match(threadsRegex) || [];
  return { igUrls, threadsUrls };
}

function detectInputType(text) {
  const { igUrls, threadsUrls } = extractUrls(text);
  if (igUrls.length > 0) return 'ig';
  if (threadsUrls.length > 0) return 'threads';
  return 'text';
}

// Analyze text/URL input
async function analyzeFromText(text) {
  const { igUrls, threadsUrls } = extractUrls(text);
  const url = igUrls[0] || threadsUrls[0] || '';
  const caption = text.replace(url, '').trim();
  const platform = igUrls.length > 0 ? 'Instagram' : threadsUrls.length > 0 ? 'Threads' : '';

  const prompt = `You are a location extraction expert for a LINE bot that helps users find places on Naver Maps.

${url ? `${platform} URL: ${url}` : ''}
${caption ? `User text: ${caption}` : ''}

Extract or infer the location/place name from the above. This could be a restaurant, cafe, attraction, landmark, etc.

Respond ONLY with valid JSON, no markdown:
{"detected":true,"placeName":"name","city":"city","country":"country","naverQuery":"optimized query for Naver Maps (use Korean if Korean place)","googleQuery":"query for Google Maps","confidence":"high","tip":"one short tip in Traditional Chinese max 20 chars"}

If no location found:
{"detected":false,"placeName":null,"city":null,"country":null,"naverQuery":null,"googleQuery":null,"confidence":"low","tip":"請附上景點名稱"}`;

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

  const data = await res.json();
  console.log('Claude text response:', JSON.stringify(data));

  if (data.error) throw new Error('Claude API error: ' + data.error.message);
  const text2 = data.content[0].text || '';
  const jsonMatch = text2.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in: ' + text2);
  return JSON.parse(jsonMatch[0]);
}

// Analyze image input
async function analyzeFromImage(base64Image) {
  const prompt = `You are a location extraction expert. The user has shared a screenshot from Instagram, Threads, or other social media.

Look at the image and identify any location, restaurant, cafe, attraction, or landmark shown or mentioned.
Check for: location tags, place names in captions, store signs, landmark backgrounds, hashtags with place names.

Respond ONLY with valid JSON, no markdown:
{"detected":true,"placeName":"name","city":"city","country":"country","naverQuery":"optimized query for Naver Maps (use Korean if Korean place)","googleQuery":"query for Google Maps","confidence":"high","tip":"one short tip in Traditional Chinese max 20 chars"}

If no location found:
{"detected":false,"placeName":null,"city":null,"country":null,"naverQuery":null,"googleQuery":null,"confidence":"low","tip":"截圖中找不到景點資訊"}`;

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
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64Image
            }
          },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });

  const data = await res.json();
  console.log('Claude image response:', JSON.stringify(data));

  if (data.error) throw new Error('Claude API error: ' + data.error.message);
  const text = data.content[0].text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in: ' + text);
  return JSON.parse(jsonMatch[0]);
}

function buildReplyMessage(result) {
  if (!result.detected || !result.placeName) {
    return [{
      type: 'text',
      text: '🔍 找不到景點資訊\n\n可以試試：\n・貼連結時附上說明文字\n・直接傳地名（例如：首爾弘大烤肉）\n・傳 IG 或 Threads 的截圖'
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

  for (const event of events) {
    if (event.type !== 'message') continue;

    const replyToken = event.replyToken;
    const msgType = event.message.type;

    try {
      let result;

      if (msgType === 'image') {
        // Handle image/screenshot
        console.log('Processing image message');
        const base64 = await downloadLineImage(event.message.id);
        result = await analyzeFromImage(base64);

      } else if (msgType === 'text') {
        const text = event.message.text;
        console.log('Processing text:', text);

        const { igUrls, threadsUrls } = extractUrls(text);
        const hasUrl = igUrls.length > 0 || threadsUrls.length > 0;
        const caption = text.replace(igUrls[0] || threadsUrls[0] || '', '').trim();

        // Skip if only a bare IG/Threads link with no caption
        if (hasUrl && !caption) {
          await replyToLine(replyToken, [{
            type: 'text',
            text: '🔍 只有連結沒辦法找到景點喔！\n\n請附上說明文字，例如：\n「連結 + 首爾弘大這家咖啡廳」\n\n或直接傳截圖給我 📸'
          }]);
          continue;
        }

        result = await analyzeFromText(text);
      } else {
        continue;
      }

      const messages = buildReplyMessage(result);
      await replyToLine(replyToken, messages);

    } catch (err) {
      console.error('Error:', err.message);
      await replyToLine(replyToken, [{
        type: 'text',
        text: '⚠️ 解析時發生錯誤，請稍後再試。'
      }]);
    }
  }
});

app.get('/', (req, res) => res.send('LINE Bot is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
