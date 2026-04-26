const express = require('express');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

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

async function getPlaceDetails(query) {
  try {
    const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.rating,places.googleMapsUri'
      },
      body: JSON.stringify({ textQuery: query, languageCode: 'zh-TW' })
    });
    const searchData = await searchRes.json();
    if (!searchData.places || searchData.places.length === 0) return null;
    const place = searchData.places[0];
    return {
      phone: place.internationalPhoneNumber || null,
      rating: place.rating || null,
      googleMapsUri: place.googleMapsUri || null
    };
  } catch (err) {
    console.error('Places API error:', err.message);
    return null;
  }
}

// Save place to Firestore
async function savePlace(userId, place, details) {
  const docRef = db.collection('users').doc(userId).collection('saved').doc();
  await docRef.set({
    placeName: place.placeName,
    city: place.city || null,
    country: place.country || null,
    category: place.category || '其他',
    description: place.description || null,
    rating: details?.rating || null,
    phone: details?.phone || null,
    googleMapsUri: details?.googleMapsUri || null,
    naverQuery: place.naverQuery || null,
    googleQuery: place.googleQuery || null,
    savedAt: new Date()
  });
  return docRef.id;
}

// Get saved places
async function getSavedPlaces(userId, filter = {}) {
  let query = db.collection('users').doc(userId).collection('saved');
  if (filter.category) query = query.where('category', '==', filter.category);
  if (filter.country) query = query.where('country', '==', filter.country);
  query = query.orderBy('savedAt', 'desc').limit(20);
  const snap = await query.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Delete saved place
async function deletePlace(userId, placeId) {
  await db.collection('users').doc(userId).collection('saved').doc(placeId).delete();
}

const CATEGORY_EMOJI = {
  '餐廳': '🍽',
  '咖啡廳': '☕',
  '景點': '🏛',
  '購物': '🛍',
  '住宿': '🏨',
  '其他': '📍'
};

const SHARED_RULES = `
CRITICAL DEDUPLICATION RULES:
- If a place name and its address appear separately, merge them into ONE entry.
- Region names alone (e.g. "濟州島", "首爾", "東京") are NOT places — do NOT include them.
- Only include actual venues: restaurants, cafes, shops, attractions, landmarks.

CATEGORY RULES - pick ONE per place:
- 餐廳: restaurants, food stalls, izakaya, BBQ, ramen, sushi, etc.
- 咖啡廳: cafes, coffee shops, dessert shops, bakeries
- 景點: parks, temples, museums, beaches, mountains, historical sites
- 購物: shops, markets, malls, select shops, boutiques
- 住宿: hotels, guesthouses, ryokan
- 其他: anything else

PLACE NAME RULES:
- Chinese-speaking regions (Taiwan, Hong Kong, Macau, China): Chinese name first, English after if exists.
- Korea: Korean name first. Add Chinese if commonly known.
- Japan: Japanese name first. Add Chinese if commonly known.
- Other: Original name first. Add Chinese in brackets if exists.
- city/country: Always Traditional Chinese. e.g. 高雄、台灣、首爾、韓國、東京、日本

SEARCH QUERY RULES:
- Always include city/region in every query.
- If only address available, use address as googleQuery.
- naverQuery: Korean place name + Korean city (only for Korean places)
- googleQuery: place name or address + city in English

DESCRIPTION RULES:
- 1-2 sentence highlight in Traditional Chinese. Focus on what makes it special.
- If no info available, return null.

JSON fields per place:
{
  "placeName": "formatted name",
  "city": "Traditional Chinese city",
  "country": "Traditional Chinese country",
  "category": "餐廳|咖啡廳|景點|購物|住宿|其他",
  "naverQuery": "for Korean places only",
  "googleQuery": "place name or address + city in English",
  "confidence": "high/medium/low",
  "description": "tip in Traditional Chinese or null"
}`;

async function analyzeMultipleFromText(text) {
  const { all: urls } = extractUrls(text);
  const urlsRemoved = urls.reduce((t, u) => t.replace(u, ''), text).trim();
  const prompt = `You are a location extraction expert for a LINE bot.
User message:
URLs: ${urls.join(', ') || 'none'}
Text: ${urlsRemoved || 'none'}
Extract ALL actual venues/places mentioned (not region names).
${SHARED_RULES}
Respond ONLY with valid JSON array, no markdown: [place1, place2, ...]
If no locations found, return: []`;
  const result = await callClaude([{ role: 'user', content: prompt }]);
  const jsonMatch = result.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  return JSON.parse(jsonMatch[0]);
}

async function analyzeMultipleFromImage(base64Image) {
  const prompt = `You are a location extraction expert. The user shared a screenshot from Instagram, Threads, or social media.
Identify ALL actual venues: restaurants, cafes, shops, attractions, landmarks.
Check: location tags, place names in captions, store signs, addresses, hashtags.
${SHARED_RULES}
Respond ONLY with valid JSON array, no markdown: [place1, place2, ...]
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

async function buildLocationMessage(place, index, total, userId) {
  const confidenceEmoji = { high: '✅', medium: '🟡', low: '⚠️' };
  const emoji = confidenceEmoji[place.confidence] || '📍';
  const catEmoji = CATEGORY_EMOJI[place.category] || '📍';
  const location = [place.city, place.country].filter(Boolean).join(' ');
  const countryLower = (place.country || '').toLowerCase();
  const isKorea = ['한국', 'korea', 'south korea', '韓國', '韓국'].some(k => countryLower.includes(k));

  const details = await getPlaceDetails(place.googleQuery || place.placeName);

  // Save to Firestore
  const savedId = await savePlace(userId, place, details);

  const header = total > 1 ? `【${index + 1}/${total}】` : '';
  let text = `${header}${emoji} ${place.placeName}`;
  text += `\n${catEmoji} ${place.category || '其他'}`;
  if (location) text += `\n📍 ${location}`;
  if (place.description) text += `\n💡 ${place.description}`;
  if (details?.rating) text += `\n⭐ ${details.rating}`;
  if (details?.phone) text += `\n📞 ${details.phone}`;

  if (isKorea) {
    const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(place.naverQuery || place.placeName)}`;
    text += `\n\n🗺 Naver Maps：\n${naverUrl}`;
  }

  const googleUrl = details?.googleMapsUri
    ? details.googleMapsUri
    : `https://www.google.com/maps/search/${encodeURIComponent(place.googleQuery || place.placeName)}`;
  text += `\n\n🌐 Google Maps：\n${googleUrl}`;
  text += `\n\n🔖 已加入收藏`;

  return { type: 'text', text };
}

// Format saved place for display
function formatSavedPlace(place, index) {
  const catEmoji = CATEGORY_EMOJI[place.category] || '📍';
  const location = [place.city, place.country].filter(Boolean).join(' ');
  let text = `${index + 1}. ${catEmoji} ${place.placeName}`;
  if (location) text += ` (${location})`;
  if (place.rating) text += ` ⭐${place.rating}`;
  return text;
}

// Handle list commands
async function handleCommand(text, userId, replyToken) {
  const cmd = text.trim().toLowerCase();

  // Show all saved
  if (cmd === '收藏' || cmd === '我的收藏' || cmd === 'list') {
    const places = await getSavedPlaces(userId);
    if (places.length === 0) {
      await replyToLine(replyToken, [{ type: 'text', text: '📭 還沒有收藏任何地點！\n\n傳截圖或地名給我，自動幫你存起來 🗺' }]);
      return true;
    }
    let text2 = `🔖 我的收藏（${places.length} 個）\n\n`;
    text2 += places.map((p, i) => formatSavedPlace(p, i)).join('\n');
    text2 += '\n\n輸入「咖啡廳」「餐廳」「景點」「購物」篩選分類\n輸入「韓國」「台灣」「日本」等篩選國家';
    await replyToLine(replyToken, [{ type: 'text', text: text2 }]);
    return true;
  }

  // Filter by category
  const categories = ['餐廳', '咖啡廳', '景點', '購物', '住宿'];
  if (categories.includes(text.trim())) {
    const places = await getSavedPlaces(userId, { category: text.trim() });
    if (places.length === 0) {
      await replyToLine(replyToken, [{ type: 'text', text: `📭 沒有收藏的${text.trim()}` }]);
      return true;
    }
    let text2 = `${CATEGORY_EMOJI[text.trim()]} ${text.trim()}（${places.length} 個）\n\n`;
    text2 += places.map((p, i) => formatSavedPlace(p, i)).join('\n');
    await replyToLine(replyToken, [{ type: 'text', text: text2 }]);
    return true;
  }

  // Filter by country
  const countryKeywords = ['台灣', '韓國', '日本', '香港', '泰國', '新加坡', '美國', '法國', '義大利', '英國', '澳洲'];
  const matchedCountry = countryKeywords.find(c => text.trim() === c);
  if (matchedCountry) {
    const places = await getSavedPlaces(userId, { country: matchedCountry });
    if (places.length === 0) {
      await replyToLine(replyToken, [{ type: 'text', text: `📭 沒有收藏${matchedCountry}的地點` }]);
      return true;
    }
    let text2 = `🌏 ${matchedCountry}（${places.length} 個）\n\n`;
    text2 += places.map((p, i) => formatSavedPlace(p, i)).join('\n');
    await replyToLine(replyToken, [{ type: 'text', text: text2 }]);
    return true;
  }

  // Help
  if (cmd === '?' || cmd === 'help' || cmd === '說明') {
    await replyToLine(replyToken, [{
      type: 'text',
      text: '🗺 使用說明\n\n📸 傳截圖 → 自動找景點並存到收藏\n✍️ 傳地名 → 自動找景點並存到收藏\n\n📋 查看收藏：\n・輸入「收藏」→ 全部\n・輸入「餐廳」「咖啡廳」「景點」「購物」→ 分類篩選\n・輸入「韓國」「日本」「台灣」等 → 國家篩選'
    }]);
    return true;
  }

  return false;
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  if (!verifySignature(req)) return;

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message') continue;

    const replyToken = event.replyToken;
    const msgType = event.message.type;
    const userId = event.source.userId;

    try {
      let places = [];

      if (msgType === 'image') {
        console.log('Processing image');
        const base64 = await downloadLineImage(event.message.id);
        places = await analyzeMultipleFromImage(base64);

      } else if (msgType === 'text') {
        const text = event.message.text;
        console.log('Processing text:', text);

        // Check if it's a command first
        const isCommand = await handleCommand(text, userId, replyToken);
        if (isCommand) continue;

        const { all: urls } = extractUrls(text);
        const caption = urls.reduce((t, u) => t.replace(u, ''), text).trim();

        if (urls.length > 0 && !caption) {
          await replyToLine(replyToken, [{
            type: 'text',
            text: '📸 直接傳截圖給我就好！\n\n或是傳文字地名，例如：\n「首爾弘大這家咖啡廳」\n\n輸入「說明」查看完整使用方法'
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
          text: '🔍 找不到景點資訊\n\n試試看：\n📸 傳 IG 或 Threads 的截圖\n✍️ 直接傳地名文字\n\n輸入「說明」查看使用方法'
        }]);
        continue;
      }

      const messages = await Promise.all(
        places.slice(0, 5).map((place, i) =>
          buildLocationMessage(place, i, Math.min(places.length, 5), userId)
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
