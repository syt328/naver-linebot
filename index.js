const express = require('express');
const crypto = require('crypto');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

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
  const limited = messages.slice(0, 5);
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages: limited })
  });
  const data = await res.json();
  console.log('LINE reply:', JSON.stringify(data));
}

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
  return { igUrls, threadsUrls, all: [...igUrls, ...threadsUrls] };
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('Claude API error: ' + data.error.message);
  return data.content[0].text || '';
}

// Google Places API (New) - search and get details
async function getPlaceDetails(query) {
  try {
    // Step 1: Search for the place
    const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.regularOpeningHours,places.rating,places.googleMapsUri'
      },
      body: JSON.stringify({ textQuery: query, languageCode: 'zh-TW' })
    });

    const searchData = await searchRes.json();
    console.log('Places search:', JSON.stringify(searchData));

    if (!searchData.places || searchData.places.length === 0) return null;

    const place = searchData.places[0];

    // Format opening hours
    let hours = null;
    if (place.regularOpeningHours && place.regularOpeningHours.weekdayDescriptions) {
      hours = place.regularOpeningHours.weekdayDescriptions.join('\n');
    }

    return {
      phone: place.internationalPhoneNumber || null,
      hours: hours,
      rating: place.rating || null,
      googleMapsUri: place.googleMapsUri || null
    };
  } catch (err) {
    console.error('Places API error:', err.message);
    return null;
  }
}

const SHARED_RULES = `
PLACE NAME RULES:
- Chinese-speaking regions (Taiwan, Hong Kong, Macau, China): Chinese name first, English after if exists. e.g. "小騙徒潑畫體驗 Paint Baby Studio"
- Korea: Korean name first. Add Chinese if commonly known.
- Japan: Japanese name first. Add Chinese if commonly known.
- Other: Original name first. Add Chinese in brackets if exists. e.g. "Eiffel Tower（艾菲爾鐵塔）"
- city/country: Always Traditional Chinese. e.g. 高雄、台灣、首爾、韓國、東京、日本

SEARCH QUERY RULES:
- Always include city/region in every query.
- naverQuery: Korean place name + Korean city (only for Korean places) e.g. "Planer House 제주도"
- googleQuery: English/romanized place name + English city e.g. "Planer House Jeju"

DESCRIPTION RULES:
- Write a short 1-2 sentence highlight in Traditional Chinese about this place.
- Focus on what makes it special or must-try items.
- e.g. "濟州島必逛漂亮碗盤選品店，品項豐富可以逛很久。"
- If no info available, return null.

JSON fields per place:
{
  "placeName": "formatted name",
  "city": "Traditional Chinese city",
  "country": "Traditional Chinese country",
  "naverQuery": "for Korean places only",
  "googleQuery": "place + city in English",
  "confidence": "high/medium/low",
  "description": "1-2 sentence tip in Traditional Chinese or null"
}`;

async function analyzeMultipleFromText(text) {
  const { all: urls } = extractUrls(text);
  const urlsRemoved = urls.reduce((t, u) => t.replace(u, ''), text).trim();

  const prompt = `You are a location extraction expert for a LINE bot.

User message:
URLs: ${urls.join(', ') || 'none'}
Text: ${urlsRemoved || 'none'}

Extract ALL locations/places mentioned.
${SHARED_RULES}

Respond ONLY with valid JSON array, no markdown:
[place1, place2, ...]

If no locations found, return: []`;

  const result = await callClaude([{ role: 'user', content: prompt }]);
  const jsonMatch = result.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  return JSON.parse(jsonMatch[0]);
}

async function analyzeMultipleFromImage(base64Image) {
  const prompt = `You are a location extraction expert. The user shared a screenshot from Instagram, Threads, or social media.

Identify ALL locations, restaurants, cafes, attractions, or landmarks shown or mentioned.
Check: location tags, place names in captions, store signs, landmark backgrounds, hashtags.

${SHARED_RULES}

Respond ONLY with valid JSON array, no markdown:
[place1, place2, ...]

If no locations found, return: []`;

  const result = await callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
      { type: 'text', text: prompt }
    ]
  }]);

  const jsonMatch = result.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  return JSON.parse(jsonMatch[0]);
}

async function buildLocationMessage(place, index, total) {
  const confidenceEmoji = { high: '✅', medium: '🟡', low: '⚠️' };
  const emoji = confidenceEmoji[place.confidence] || '📍';
  const location = [place.city, place.country].filter(Boolean).join(' ');
  const countryLower = (place.country || '').toLowerCase();
  const isKorea = ['한국', 'korea', 'south korea', '韓國', '韓国'].some(k => countryLower.includes(k));

  // Fetch details from Google Places
  const details = await getPlaceDetails(place.googleQuery || place.placeName);

  const header = total > 1 ? `【${index + 1}/${total}】` : '';
  let text = `${header}${emoji} ${place.placeName}`;
  if (location) text += `\n📍 ${location}`;
  if (place.description) text += `\n💡 ${place.description}`;

  // Add Google Places data if available
  if (details) {
    if (details.rating) text += `\n⭐ ${details.rating}`;
    if (details.phone) text += `\n📞 ${details.phone}`;
    if (details.hours) text += `\n🕐 營業時間：\n${details.hours}`;
  }

  // Map links
  if (isKorea) {
    const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(place.naverQuery || place.placeName)}`;
    text += `\n\n🗺 Naver Maps：\n${naverUrl}`;
  }

  // Use Google Maps direct link if available, otherwise search
  const googleUrl = details && details.googleMapsUri
    ? details.googleMapsUri
    : `https://www.google.com/maps/search/${encodeURIComponent(place.googleQuery || place.placeName)}`;
  text += `\n\n🌐 Google Maps：\n${googleUrl}`;

  return { type: 'text', text };
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  if (!verifySignature(req)) return;

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message') continue;

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
            text: '📸 直接傳截圖給我就好！\n\n或是傳文字地名，例如：\n「首爾弘大這家咖啡廳」'
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
          text: '🔍 找不到景點資訊\n\n試試看：\n📸 傳 IG 或 Threads 的截圖\n✍️ 直接傳地名文字'
        }]);
        continue;
      }

      // Build messages with Google Places details
      const messages = await Promise.all(
        places.slice(0, 5).map((place, i) =>
          buildLocationMessage(place, i, Math.min(places.length, 5))
        )
      );

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
