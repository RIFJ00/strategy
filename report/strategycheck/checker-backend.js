/**
 * サーバー/GitHub Actions実行用 バックエンドスクリプト
 * --------------------------------------------------
 * [修正内容]
 * 1. ESM (import) 形式に完全統一（requireを排除）
 * 2. 477件の全件処理と進捗ログ出力
 * 3. Firestore 新パスルール準拠
 */

import fs from 'fs';
import csv from 'csv-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import admin from 'firebase-admin';

// --- 設定 ---
const CSV_FILE_PATH = '会議体リスト_20260413.csv'; 
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const FIREBASE_KEY_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const appId = process.env.APP_ID || 'strategy-checker'; 

if (!SLACK_WEBHOOK_URL || !FIREBASE_KEY_JSON) {
  console.error('環境変数が不足しています。');
  process.exit(1);
}

// --- Firebase Admin 初期化 ---
const serviceAccount = JSON.parse(FIREBASE_KEY_JSON);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// 日付抽出
const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/g;

function parseJapaneseDate(dateStr) {
  try {
    let year, month, day;
    if (dateStr.includes('令和')) {
      const match = dateStr.match(/令和\s*?(\d+|元)年/);
      if (!match) return null;
      const reiwaYearStr = match[1];
      year = reiwaYearStr === '元' ? 2019 : 2018 + parseInt(reiwaYearStr, 10);
    } else {
      const match = dateStr.match(/(\d{4})年/);
      if (!match) return null;
      year = parseInt(match[1], 10);
    }
    const mMatch = dateStr.match(/(\d{1,2})月/);
    const dMatch = dateStr.match(/(\d{1,2})日/);
    if (!mMatch || !dMatch) return null;
    month = parseInt(mMatch[1], 10) - 1;
    day = parseInt(dMatch[1], 10);
    return new Date(year, month, day);
  } catch (e) { return null; }
}

async function notifySlack(meetingName, newDateStr, url, agency) {
  try {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: `🔔 *更新発見*: ${meetingName} (${agency})\n最新日: ${newDateStr}\n${url}`
    });
  } catch (e) { console.error('Slack通知エラー'); }
}

async function runCheck() {
  console.log('--- チェック開始 ---');
  const records = [];
  
  if (!fs.existsSync(CSV_FILE_PATH)) {
    console.error(`ファイルが見つかりません: ${CSV_FILE_PATH}`);
    process.exit(1);
  }

  // csv-parser の読み込み形式を修正
  const stream = fs.createReadStream(CSV_FILE_PATH).pipe(csv());
  for await (const row of stream) {
    records.push(row);
  }

  const total = records.length;
  console.log(`全 ${total} 件の処理を開始します...`);

  const meetingsCol = db.collection('artifacts').doc(appId)
                        .collection('public').doc('data')
                        .collection('meetings');

  for (let i = 0; i < total; i++) {
    const record = records[i];
    const url = record['URL']?.trim();
    const meetingName = record['会議名']?.trim();
    const agency = record['所管'] || '-';
    const logPrefix = `[${i + 1}/${total}]`;

    if (!url || !meetingName) {
      console.log(`${logPrefix} スキップ: データ不備`);
      continue;
    }

    const docId = Buffer.from(url).toString('base64').replace(/\//g, '_').substring(0, 50);

    try {
      console.log(`${logPrefix} 確認中: ${meetingName}`);
      const response = await axios.get(url, { 
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      
      const $ = cheerio.load(response.data);
      $('script, style').remove();
      const bodyText = $('body').text();
      
      let newestDate = null;
      let newestDateStr = '';
      let match;

      while ((match = dateRegex.exec(bodyText)) !== null) {
        const d = parseJapaneseDate(match[0]);
        if (d && (!newestDate || d > newestDate)) {
          newestDate = d;
          newestDateStr = match[0];
        }
      }

      if (newestDate) {
        const docRef = meetingsCol.doc(docId);
        const snap = await docRef.get();
        const prevTimestamp = snap.exists ? (snap.data().latestDateTimestamp || 0) : 0;
        const prevDateString = snap.exists ? (snap.data().latestDateString || '') : '';

        if (newestDate.getTime() > prevTimestamp) {
          console.log(`   ✨ 更新あり: ${newestDateStr}`);
          await notifySlack(meetingName, newestDateStr, url, agency);
          await docRef.set({
            meetingName, agency, url,
            latestDateString: newestDateStr,
            latestDateTimestamp: newestDate.getTime(),
            previousDateString: prevDateString,
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'updated'
          }, { merge: true });
        } else if (!snap.exists) {
          await docRef.set({
            meetingName, agency, url,
            latestDateString: newestDateStr,
            latestDateTimestamp: newestDate.getTime(),
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'unchanged'
          }, { merge: true });
        }
      }
    } catch (error) {
      console.log(`   ⚠️ エラー: ${error.message}`);
      await meetingsCol.doc(docId).set({
        meetingName, agency, url,
        status: 'error',
        errorMessage: error.message,
        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
    }
    
    // 負荷軽減のため 0.5秒 待機
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('--- すべてのチェックが完了しました ---');
}

runCheck();