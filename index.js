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
  // 本番では起動失敗の方が気づけて安全
  process.exit(1);
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
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
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
 * ヘルスチェック（Render が生きてるか確認用）
 */
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

/**
 * ✅ LINE Webhook 受信エンドポイント
 * LINE Developers の Webhook URL に: https://<あなたのRenderURL>/webhook
 */
app.post('/webhook', async (req, res) => {
  try {
    // 1) 署名チェック
    const signature = req.headers['x-line-signature'];
    const ok = verifyLineSignature(req.rawBody, signature);

    if (!ok) {
      console.warn('⚠️ Invalid LINE signature');
      return res.sendStatus(401);
    }

    // 2) LINEのevents処理（まずはすぐ200返すのが安定）
    //    ※返信はreplyTokenが有効な間（短時間）に行う必要がある
    const events = req.body.events || [];
    if (!events.length) return res.sendStatus(200);

    // 先に即応答（LINEはタイムアウトにシビア）
    res.sendStatus(200);

    // 3) 各イベント処理（非同期）
    for (const event of events) {
      // メッセージ以外（フォロー/アンフォロー等）は必要なら追加対応
      if (event.type !== 'message') continue;
      if (event.message?.type !== 'text') continue;

      const userText = event.message.text;
      const replyToken = event.replyToken;
      const userId = event.source?.userId || 'unknown';

      // 4) Difyへ問い合わせ
      let botText = 'すみません、うまく返答を作れませんでした。もう一度送ってみてください。';

      try {
        const difyRes = await axios.post(
          DIFY_API_URL,
          {
            inputs: {},
            query: userText,
            response_mode: 'blocking',
            // user は一意にした方が会話の継続/解析が安定しやすい
            user: userId,
          },
          {
            headers: {
              Authorization: `Bearer ${DIFY_API_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );

        // Difyの返りは環境/バージョンで key が違うことがあるため安全に拾う
        botText =
          difyRes?.data?.answer ??
          difyRes?.data?.data?.answer ??
          difyRes?.data?.message ??
          botText;
      } catch (e) {
        // Dify APIキー等の詳細は漏らさない。必要ならRenderログで確認。
        console.error('❌ Dify request failed:', e?.response?.status, e?.response?.data || e.message);
      }

      // 5) LINEへ返信
      try {
        await axios.post(
          'https://api.line.me/v2/bot/message/reply',
          {
            replyToken,
            messages: [{ type: 'text', text: botText }],
          },
          {
            headers: {
              Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          }
        );
      } catch (e) {
        console.error('❌ LINE reply failed:', e?.response?.status, e?.response?.data || e.message);
      }
    }
  } catch (err) {
    console.error('❌ Webhook handler error:', err.message);
    // ここで500を返すとLINE側がリトライすることがあるが、
    // すでに200返しているので通常ここは到達しにくい
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
