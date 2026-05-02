/**
 * バックエンド (高精度近接スキャン・最終確定版)
 * [役割]
 * 1. GitHub Actions で定期実行され、官公庁サイトを巡回。
 * 2. 「第N回」の記述を見つけ、その周辺テキストから開催日を特定。
 * 3. 更新があれば Firestore を直接書き換え、Slack に通知。
 */

const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

// 環境変数から設定を読み込み
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const FIREBASE_KEY_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const appId = 'seisakuresearch'; 

// Firebase の初期化
if (!FIREBASE_KEY_JSON) {
  console.error('エラー: FIREBASE_SERVICE_ACCOUNT が設定されていません。');
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(FIREBASE_KEY_JSON))
  });
}

const db = admin.firestore();
// Firestore のパスをフロントエンドと完全に一致させる
const meetingsCol = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('meetings');

// 日付と回次を探すための正規表現
const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/g;
const roundRegex = /第\s*?([0-9０-９]+|元)\s*?回/g;

/**
 * テキストの正規化（全角英数を半角にする、余計な空白を消す）
 */
const normalizeText = (str) => {
  if (!str) return "";
  return str
    .replace(/[！-～]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * 日本語の日付文字列をタイムスタンプに変換
 */
const parseDateToTs = (str) => {
  try {
    const s = normalizeText(str);
    const match = s.match(/(20\d{2}|令和\d+|令和元)年(\d{1,2})月(\d{1,2})日/);
    if (!match) return 0;
    let year;
    if (match[0].includes('令和')) {
      const rYear = match[0].match(/令和(\d+|元)年/)[1];
      year = rYear === '元' ? 2019 : 2018 + parseInt(rYear, 10);
    } else {
      year = parseInt(match[0].match(/(\d{4})年/)[1], 10);
    }
    const month = parseInt(match[0].match(/(\d{1,2})月/)[1], 10) - 1;
    const day = parseInt(match[0].match(/(\d{1,2})日/)[1], 10);
    return new Date(year, month, day).getTime();
  } catch (e) { return 0; }
};

/**
 * Slack への通知
 */
async function notifySlack(name, combinedDate, url) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: `🔔 *更新検知*: ${name}\n📅 日時: ${combinedDate}\n🔗 URL: ${url}`
    });
  } catch (e) {
    console.error('Slack通知失敗:', e.message);
  }
}

/**
 * メインの巡回処理
 */
async function runCheck() {
  const snapshot = await meetingsCol.get();
  console.log(`開始: ${snapshot.size} 件の会議体をチェックします...`);

  for (const doc of snapshot.docs) {
    const meeting = doc.data();
    const rawName = meeting.meetingName || meeting['会議名'];
    const url = meeting.url || meeting['URL'];

    if (!url || !rawName) continue;

    try {
      // キャッシュ回避のためタイムスタンプを付与
      const response = await axios.get(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { 
        timeout: 30000,
        headers: { 'User-Agent': 'Mozilla/5.0' } 
      });

      const $ = cheerio.load(response.data);
      $('script, style, noscript').remove();
      const bodyText = normalizeText($('body').text());

      // 1. 全ての回次（第N回）を特定
      let rounds = [];
      let rMatch;
      roundRegex.lastIndex = 0;
      while ((rMatch = roundRegex.exec(bodyText)) !== null) {
        const num = rMatch[1] === '元' ? 1 : parseInt(rMatch[1], 10);
        rounds.push({ str: rMatch[0], num, index: rMatch.index });
      }

      if (rounds.length > 0) {
        // 最大の回数をターゲットにする
        const targetRound = rounds.reduce((p, c) => (p.num > c.num) ? p : c);

        // 2. ターゲット回次の周辺テキストを切り出し（近接スキャン）
        const start = Math.max(0, targetRound.index - 200);
        const end = Math.min(bodyText.length, targetRound.index + 400);
        const focusSnippet = bodyText.substring(start, end);

        // 3. 切り出した範囲から日付を抽出・スコアリング
        let candidates = [];
        let dMatch;
        dateRegex.lastIndex = 0;
        while ((dMatch = dateRegex.exec(focusSnippet)) !== null) {
          const ts = parseDateToTs(dMatch[0]);
          if (ts > 0) {
            const dist = Math.abs(dMatch.index - 200); // 中央（回次位置）からの距離
            const context = focusSnippet.substring(Math.max(0, dMatch.index - 60), dMatch.index + 60);
            const bonus = /開催|案内|日時|次第|資料|予定/.test(context) ? 100000 : 0;
            const penalty = /更新|作成|公開|最終|Last/.test(context) ? 80000 : 0;
            candidates.push({ str: dMatch[0], ts, score: bonus - penalty - dist });
          }
        }

        const bestDate = candidates.length > 0 ? candidates.reduce((p, c) => (p.score > c.score) ? p : c) : null;
        
        const currentTs = meeting.latestDateTimestamp || 0;
        const currentRoundNum = meeting.meetingRound ? 
          (meeting.meetingRound.match(/\d+/) ? parseInt(meeting.meetingRound.match(/\d+/)[0], 10) : 0) : 0;

        // 4. 更新判定（回数が増えているか、日付が新しいか）
        if (targetRound.num > currentRoundNum || (bestDate && bestDate.ts > currentTs)) {
          const finalDate = bestDate ? bestDate.str : (meeting.latestDateString || "日付不明");
          const combinedStr = `${finalDate} (${targetRound.str})`;

          await doc.ref.update({
            latestDateString: combinedStr,
            '直近開催日': combinedStr,
            latestDateTimestamp: bestDate ? bestDate.ts : currentTs,
            meetingRound: targetRound.str,
            previousDateString: meeting.latestDateString || '',
            status: 'updated',
            isManual: false,
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          console.log(`✨ 更新検知: ${rawName} -> ${combinedStr}`);
          await notifySlack(rawName, combinedStr, url);
        } else {
          // 変更がなくても巡回時刻だけ更新
          await doc.ref.update({ lastCheckedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      }
    } catch (e) {
      console.error(`[エラー] ${rawName}:`, e.message);
    }

    // サーバー負荷軽減のため待機
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('完了: すべての巡回が終了しました。');
}

// 実行
runCheck();
