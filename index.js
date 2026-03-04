'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

/**
 * Render などでは PORT が環境変数で渡される
 */
const PORT = process.env.PORT || 3000;

/**
 * ✅ 環境変数（Render の Environment に設定する）
 * - LINE_CHANNEL_ACCESS_TOKEN : LINE Messaging API のチャネルアクセストークン
 * - LINE_CHANNEL_SECRET       : LINE Messaging API のチャネルシークレット（署名検証用）
 * - DIFY_API_KEY              : Dify の API シークレットキー（絶対にコードに直貼りしない）
 * - DIFY_API_URL              : 任意（デフォルト: https://api.dify.ai/v1/chat-messages）
 */
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const DIFY_API_URL = process.env.DIFY_API_URL || 'https://api.dify.ai/v1/chat-messages';

// 必須環境変数チェック（起動時に落として分かりやすくする）
const missing = [];
if (!LINE_CHANNEL_ACCESS_TOKEN) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
if (!LINE_CHANNEL_SECRET) missing.push('LINE_CHANNEL_SECRET');
if (!DIFY_API_KEY) missing.push('DIFY_API_KEY');
if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

/**
 * ちょい便利：リクエスト単位のID（ログ追跡用）
 */
function makeReqId() {
  return crypto.randomBytes(6).toString('hex'); // 12 chars
}

/**
 * LINE の署名検証用
 * X-Line-Signature = base64(HMAC-SHA256(body, channelSecret))
 */
function verifyLineSignature(rawBody, signature) {
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET);
  hmac.update(rawBody, 'utf8');
  const digest = hmac.digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * express.json で raw body を取る（署名検証のため）
 */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

/**
 * ヘルスチェック（外形監視・Renderの生存確認用）
 */
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

/**
 * 旧 / も残す（ブラウザで開いて確認しやすい）
 */
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

/**
 * LINEへ reply
 */
async function lineReply(replyToken, text) {
  return axios.post(
    'https://api.line.me/v2/bot/message/reply',
    {
      replyToken,
      messages: [{ type: 'text', text }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
}

/**
 * LINEへ push（replyToken失効対策）
 */
async function linePush(toUserId, text) {
  return axios.post(
    'https://api.line.me/v2/bot/message/push',
    {
      to: toUserId,
      messages: [{ type: 'text', text }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
}

/**
 * Difyへ問い合わせ
 */
async function askDify(userId, userText) {
  return axios.post(
    DIFY_API_URL,
    {
      inputs: {},
      query: userText,
      response_mode: 'blocking',
      user: userId, // userは一意が良い
      // conversation_id を扱うならここに渡す（今回はLINE側なのでuserで継続させる）
    },
    {
      headers: {
        Authorization: `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
}

/**
 * ✅ LINE Webhook 受信エンドポイント
 */
app.post('/webhook', async (req, res) => {
  const reqId = makeReqId();
  const t0 = Date.now();

  try {
    // 1) 署名チェック
    const signature = req.headers['x-line-signature'];
    const ok = verifyLineSignature(req.rawBody, signature);

    if (!ok) {
      console.warn(`[${reqId}] ⚠️ Invalid LINE signature`);
      return res.sendStatus(401);
    }

    // 2) LINEのevents処理（すぐ200返す）
    const events = req.body.events || [];
    if (!events.length) return res.sendStatus(200);

    // 先に即応答（重要）
    res.sendStatus(200);

    // 3) 各イベント処理（非同期）
    for (const event of events) {
      if (event.type !== 'message') continue;
      if (event.message?.type !== 'text') continue;

      const userText = event.message.text;
      const replyToken = event.replyToken;
      const userId = event.source?.userId || null;

      // ログ①：受信
      console.log(
        `[${reqId}] 📩 recv userId=${userId || 'unknown'} text=${JSON.stringify(userText)}`
      );

      let botText = 'すみません、うまく返答を作れませんでした。もう一度送ってみてください。';

      // 4) Difyへ問い合わせ（遅い場合に備えて計測）
      const tDify0 = Date.now();
      try {
        const difyRes = await askDify(userId || 'unknown', userText);

        botText =
          difyRes?.data?.answer ??
          difyRes?.data?.data?.answer ??
          difyRes?.data?.message ??
          botText;

        // ログ②：Dify応答
        console.log(
          `[${reqId}] 🤖 dify ok ${Date.now() - tDify0}ms answer_len=${(botText || '').length}`
        );
      } catch (e) {
        console.error(
          `[${reqId}] ❌ dify fail ${Date.now() - tDify0}ms`,
          e?.response?.status,
          e?.response?.data || e.message
        );
      }

      // 5) LINEへ返信（失敗したらpushへ）
      const tLine0 = Date.now();

      // 目安：ここまで来るのが遅すぎたらreplyToken失効しがち → push優先
      const elapsed = Date.now() - t0;
      const shouldPreferPush = elapsed > 25000; // 25秒超えたら危険域（目安）

      try {
        if (shouldPreferPush) {
          if (!userId) throw new Error('no userId for push');
          await linePush(userId, botText);
          console.log(`[${reqId}] ✅ line push ok ${Date.now() - tLine0}ms`);
        } else {
          await lineReply(replyToken, botText);
          console.log(`[${reqId}] ✅ line reply ok ${Date.now() - tLine0}ms`);
        }
      } catch (e) {
        // replyが死んだ（= token失効など）→ push で救済
        console.error(
          `[${reqId}] ❌ line send fail ${Date.now() - tLine0}ms`,
          e?.response?.status,
          e?.response?.data || e.message
        );

        try {
          if (!userId) throw new Error('no userId for push');
          await linePush(userId, botText);
          console.log(`[${reqId}] ✅ line push fallback ok`);
        } catch (e2) {
          console.error(
            `[${reqId}] ❌ line push fallback fail`,
            e2?.response?.status,
            e2?.response?.data || e2.message
          );
        }
      }
    }

    console.log(`[${reqId}] 🧾 done total=${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[${reqId}] ❌ webhook handler error:`, err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
