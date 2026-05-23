const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const axios = require("axios");
const cheerio = require("cheerio"); 
const crypto = require("crypto"); 
const { GoogleGenerativeAI } = require("@google/generative-ai"); 

if (admin.apps.length === 0) admin.initializeApp();
const db = admin.firestore();

// 同時処理の上限を解放
setGlobalOptions({ maxInstances: 200 });

/**
 * 1. 司令塔（Orchestrator） - 定期実行スケジュール監視
 */
/**
 * 1. 司令塔（Orchestrator） - 定期実行スケジュール監視
 * 🌟画面の『Daily Auto Update』がオフ（DISABLED）の時は、安全にスキップするように修正
 */
exports.automaticDailyCheckSchedule = onSchedule({
  schedule: "every 5 minutes",
  timeZone: "Asia/Tokyo",
  memory: "2GiB",
  timeoutSeconds: 1800
}, async (event) => {
  let shouldTrigger = false;
  let runKeyToSave = "";

  // 🔒【最重要追加】まずは画面上のトグルが「オフ」になっていないか最優先でチェック
  try {
    const systemConfigRef = db.doc("artifacts/seisakuresearch/public/data/config/system");
    const configDoc = await systemConfigRef.get();
    if (configDoc.exists) {
      const configData = configDoc.data();
      // 画面上でスイッチが DISABLED (false) になっていたら、ここで即終了
      if (configData.autoUpdateEnabled === false) {
        console.log("⚠️ 【判定】画面上で『Daily Auto Update』がオフ(DISABLED)にされているため、自動スケジュール巡回を安全にスキップします。");
        return; 
      }
    }
  } catch (configError) {
    console.warn("セーフティロック確認中にエラーが発生しました（処理は続行します）:", configError.message);
  }

  // --- ここから下は既存のスケジュール判定ロジック ---
  await db.runTransaction(async (transaction) => {
    const dailyCheckRef = db.doc("settings/daily_check");
    const doc = await transaction.get(dailyCheckRef);
    if (!doc.exists) return;

    const data = doc.data();
    const schedules = data.schedules || [];
    if (schedules.length === 0) return;

    const now = new Date();
    const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const currentDay = jstDate.getUTCDay();
    const currentHour = jstDate.getUTCHours();
    const currentMinute = jstDate.getUTCMinutes();

    let matchedTime = "";
    for (const s of schedules) {
      if (!s.enabled) continue;
      const safeDays = Array.isArray(s.days) ? s.days : [];
      if (!safeDays.includes(currentDay)) continue;

      const [sHour, sMin] = (s.time || "12:00").split(':').map(Number);
      const scheduleTotalMin = sHour * 60 + sMin;
      const currentTotalMin = currentHour * 60 + currentMinute;

      if (currentTotalMin >= scheduleTotalMin && currentTotalMin < scheduleTotalMin + 5) {
        matchedTime = s.time;
        break;
      }
    }

    if (!matchedTime) return;

    const todayStr = `${jstDate.getUTCFullYear()}-${jstDate.getUTCMonth()+1}-${jstDate.getUTCDate()}`;
    runKeyToSave = `${todayStr}_${matchedTime}`;

    if (data.lastRunKey === runKeyToSave) return; 

    transaction.set(dailyCheckRef, { lastRunKey: runKeyToSave }, { merge: true });
    shouldTrigger = true;
  });

  if (shouldTrigger) {
    console.log("⏰ 自動スケジュールによる一括巡回を開始します:", runKeyToSave);
    await triggerMassiveParallelCheck();
  }
});

/**
 * 手動実行用のAPI（Callable型）
 */
exports.startMassiveCheck = onCall({ 
  memory: "2GiB", 
  timeoutSeconds: 1800 
}, async (request) => {
  console.log("🚀 手動一括チェックの実行リクエストを受信しました。");
  const result = await triggerMassiveParallelCheck();
  return result;
});

/**
 * 安定スロットリング並行巡回エンジン
 */
async function triggerMassiveParallelCheck() {
  const snapshot = await db.collection("items").get();
  const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const totalCount = items.length;
  
  if (totalCount === 0) {
    return { status: "No items", total: 0 };
  }

  const startTime = Date.now();
  
  // 💡 【改善⑫】過去の lastResult が消えないように merge: true に修正
  await db.doc("settings/status").set({
    isRunning: true,
    isManualRunning: false,
    totalCount: totalCount,
    currentCount: 0,
    progress: 0,
    message: "安定並行スロットリングで巡回中...",
    startTime: startTime,
    lastUpdatedAt: startTime
  }, { merge: true });

  const CONCURRENCY_LIMIT = 30; 
  let activeIndex = 0;
  let completedSuccessCount = 0;
  let lastUpdateTime = Date.now();

  const runWorker = async () => {
    while (activeIndex < items.length) {
      const currentIndex = activeIndex++;
      const item = items[currentIndex];
      
      try {
        await processSingleUrl(item);
      } catch (err) {
        console.error(`❌ [${item.id}] 巡回処理中にエラー:`, err.message);
      }

      completedSuccessCount++;
      const now = Date.now();
      
      if (now - lastUpdateTime > 3000 || completedSuccessCount === totalCount) {
        lastUpdateTime = now;
        const currentProgress = Math.min(Math.round((completedSuccessCount / totalCount) * 100), 100);
        await db.doc("settings/status").update({
          currentCount: completedSuccessCount,
          progress: currentProgress,
          lastUpdatedAt: now
        }).catch(e => console.warn("ステータス更新エラー回避:", e.message));
      }
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, totalCount); i++) {
    workers.push(runWorker());
  }
  await Promise.all(workers);

  const endNow = Date.now();
  const diffSec = Math.floor((endNow - startTime) / 1000);
  const m = Math.floor(diffSec / 60);
  const s = diffSec % 60;
  
  // 💡 【改善④】時間表示ロジックを元の正確なものに修正
  const h = Math.floor(m / 60);
  const remM = m % 60;
  const timeStr = h > 0 ? `${h}時間${remM}分${s}秒` : (m > 0 ? `${m}分${s}秒` : `${s}秒`);

  await db.doc("settings/status").update({
    isRunning: false,
    progress: 100,
    message: "全ての巡回が完了しました",
    lastUpdatedAt: endNow,
    lastResult: {
      startTime: startTime,
      finishedAt: endNow,
      durationStr: `${timeStr} (${totalCount}件完了)`,
      totalChecked: totalCount
    }
  });

  return { status: "Check completed", total: totalCount, duration: timeStr };
}

/**
 * 3. 判定ロジック
 */
async function processSingleUrl(item) {
  const nowStr = new Date().toISOString();
  let isSelectorDead = false;
  let selectorErrorMessage = "";

  try {
    const result = await fetchHtmlContent(item.url);
    if (result.error) throw new Error(result.error);

    const html = result.html;
    const $ = cheerio.load(html);

    $('script, style, noscript, iframe, svg, canvas, meta, link, form, input, select, textarea, button').remove();
    $('[style*="display: none"], [style*="display:none"], .hidden, [hidden], .sr-only, .visually-hidden').remove();
    $('a[href^="#"]').remove();

    if (item.excludeSelector) {
      try {
        $(item.excludeSelector).remove(); 
      } catch (e) {
        console.warn(`[${item.id}] Invalid exclude selector: ${item.excludeSelector}`);
      }
    }

    let cleanText = "";
    let normalizedLinks = "";

    // 🎯 スナイパーモードの処理
    if (item.targetSelector) {
      if ($(item.targetSelector).length === 0) {
        isSelectorDead = true;
        selectorErrorMessage = `指定された監視エリア「${item.targetSelector}」がページ内に見つかりません。サイト構造が変更された可能性があります。`;
        throw new Error(`【セレクタ失効警告】${selectorErrorMessage}`);
      }
      
      const targetArea = $(item.targetSelector);
      cleanText = targetArea.text().replace(/[\s\u3000\u00A0\t\r\n]+/g, ' ').trim();
      
      let links = [];
      targetArea.find('a[href]').each((i, el) => {
        let href = $(el).attr('href');
        if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
           const cleanHref = href.split('?')[0].split('#')[0];
           const fileName = cleanHref.split('/').pop();
           if (fileName && fileName.length > 3) {
             links.push(fileName.replace(/[a-zA-Z0-9]{25,}/g, 'HASH'));
           }
        }
      });
      normalizedLinks = [...new Set(links)].sort().join('|');
    } 
    // 🛡️ 全自動フィルターモード
    else {
      $('*').each((i, el) => {
        const id = ($(el).attr('id') || '').toLowerCase();
        const cls = ($(el).attr('class') || '').toLowerCase();
        const attrText = id + ' ' + cls;
        
        const isProtected = ['main', 'content', 'article', 'body', 'list', 'result', 'news', 'press', 'info', 'data', 'feed'].some(w => attrText.includes(w));
        if (isProtected) return;
        
        const isNoise = [
          'nav', 'menu', 'side', 'head', 'foot', 'banner', 'util', 'tool',
          'bread', 'path', 'pankuzu', 'share', 'sns', 'social', 'print', 'lang',
          'pagetop', 'page-top', 'warptop', 'sitemap',
          'search-box', 'search_box', 'search-form', 'search_form'
        ].some(word => attrText.includes(word));

        const isExactSidebar = ['sub', 'local', 'left', 'right', 'navi'].some(word => {
          return id === word || cls.split(' ').includes(word) || id.includes('navi') || cls.includes('navi');
        });

        if (isNoise || isExactSidebar) $(el).remove();
      });

      let mainContent = $('main, #main, #contents, #content, .l-contentBody, article, .main-content, #mainContents, .main_contents, #center, #mainArea');
      if (mainContent.length === 0) mainContent = $('body'); 

      cleanText = mainContent.text().replace(/[\s\u3000\u00A0\t\r\n]+/g, ' ').trim();

      cleanText = cleanText.replace(/[\(（][月火水木金土日祝][\)）]/g, ''); 
      cleanText = cleanText.replace(/\d+(秒|分|時間|日|週間|ヶ月|年)[前]/g, '[TIME]'); 
      cleanText = cleanText.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}\b/gi, '[DATE]'); 

      cleanText = cleanText.replace(/(最終)?更新(年月)?日\s*[:：]?\s*.+/g, '[UPDATED]');
      cleanText = cleanText.replace(/((?:令和|平成|昭和|[RHS])?\s*\d{1,4}\s*[年/.-]\s*\d{1,2}\s*[月/.-](?:\s*\d{1,2}\s*[日号])?)\s*(分|期|度|版|公表|発表|速報|確報|次)/g, 'PROTECTED_DATE_$1_$2');
      cleanText = cleanText.replace(/(現在)?\s*[\(（]?\s*(令和|平成|昭和|[RHS])?\s*\d{1,4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}\s*[日]?\s*(現在)?\s*[\)）]?/g, '[DATE]');
      cleanText = cleanText.replace(/\d{1,2}\s*時\s*\d{1,2}\s*分(?:\s*\d{1,2}\s*秒)?/g, '[TIME]');
      cleanText = cleanText.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '[TIME]');
      cleanText = cleanText.replace(/PROTECTED_DATE_(.+?)_(.+?)/g, '$1$2');
      cleanText = cleanText.replace(/[a-zA-Z0-9]{25,}/g, '[HASH]');
      cleanText = cleanText.replace(/\d{5,}/g, '[NUM]');

      let links = [];
      mainContent.find('a[href]').each((i, el) => {
        let href = $(el).attr('href');
        if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
          const cleanHref = href.split('?')[0].split('#')[0];
          const fileName = cleanHref.split('/').pop();
          if (fileName && fileName.length > 3 && !fileName.match(/^[0-9]+$/)) {
             links.push(fileName.replace(/[a-zA-Z0-9]{25,}/g, 'HASH'));
          }
        }
      });
      normalizedLinks = [...new Set(links)].sort().join('|');
    }

    const finalString = `TEXT:${cleanText} LINKS:${normalizedLinks}`;

    const hashString = crypto
      .createHash("sha256")
      .update(finalString)
      .digest("hex");

    const isChanged = (item.contentHash || item.lastHash) !== hashString;

    // 💡 【改善⑥】Firestoreの1MB制限対策（50KB相当で切り捨て）
    const MAX_TEXT_LENGTH = 50000;
    const truncatedText = cleanText.length > MAX_TEXT_LENGTH 
      ? cleanText.slice(0, MAX_TEXT_LENGTH) + '\n...[省略されました]' 
      : cleanText;

    const updateData = {
      lastCheckedAt: nowStr,
      status: isChanged ? 'changed' : 'ok',
      contentHash: hashString,
      lastHash: hashString,
      hasUpdate: isChanged,
      currentText: truncatedText, // 💡 【改善③】最新のテキストは常に currentText に保存
    };

    // 💡 【改善⑨】バッチ処理による安全なデータベース更新
    const batch = db.batch();
    const itemRef = db.collection("items").doc(item.id);

    if (isChanged) {
      // 変化があった時だけ、以前のテキストを previousText に退避
      updateData.previousText = item.currentText || "";
      updateData.lastChangedAt = nowStr;

      const notifRef = db.collection("notifications").doc();
      batch.set(notifRef, {
        itemId: item.id,
        itemName: item.name || "名称未設定",
        url: item.url,
        detectedAt: nowStr,
        type: "update",
        status: "unread",
        message: `${item.name} に更新がありました。`
      });
    }

    batch.update(itemRef, updateData);
    await batch.commit();

  } catch (error) {
    const batch = db.batch();
    const itemRef = db.collection("items").doc(item.id);
    
    batch.update(itemRef, {
      lastCheckedAt: nowStr,
      status: 'error',
      errorMessage: error.message
    });

    // 💡 【改善⑦】セレクタ失効時には、管理者が気付けるように明確な警告通知を発行
    if (isSelectorDead) {
      const notifRef = db.collection("notifications").doc();
      batch.set(notifRef, {
        itemId: item.id,
        itemName: item.name || "名称未設定",
        url: item.url,
        detectedAt: nowStr,
        type: "selector_dead",
        status: "unread",
        message: `【警告】${item.name} の監視エリアが消失しました。サイトが更新された可能性があります。`
      });
    }

    await batch.commit();
  }
}

/**
 * 4. 選択チェック（個別）用の単体実行エンドポイント
 */
exports.checkUrl = onRequest({ timeoutSeconds: 120, memory: "1GiB" }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }
  
  try {
    const url = req.body.data?.url || req.body.url;
    if (!url) return res.status(400).json({ data: { error: "No URL provided" }});
    const result = await fetchHtmlContent(url);
    res.status(200).json({ data: result });
  } catch (e) {
    res.status(500).json({ data: { error: e.message }});
  }
});

/**
 * 5. スクレイピング処理（自動リトライ＆JSレンダリング対応化）
 */
async function fetchHtmlContent(targetUrl, retries = 2) {
  const API_TOKEN = process.env.BRIGHT_DATA_API_TOKEN;
  const ZONE_NAME = process.env.BRIGHT_DATA_ZONE_NAME || 'policy_research';

  if (!API_TOKEN) {
    throw new Error("Bright Data API Token is not configured in the environment.");
  }

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await axios.post(
        'https://api.brightdata.com/request',
        {
          zone: ZONE_NAME,
          url: targetUrl,
          format: 'raw',
          data_format: 'html', // 💡 【改善②】JSレンダリング結果の確実な取得を指定
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_TOKEN}`
          },
          timeout: 60000
        }
      );

      return { html: typeof response.data === 'string' ? response.data : JSON.stringify(response.data) };

    } catch (error) {
      const errMsg = error.response?.data?.message || error.message;
      const status = error.response?.status;
      
      // 💡 【改善⑤】HTTPステータスを見て、404や403など恒久的なエラーの場合はリトライせずに即終了（コスト削減）
      const isRetryable = !status || status >= 500 || status === 429 || status === 408;

      if (!isRetryable || attempt > retries) {
        console.error(`Bright Data API Error (${targetUrl}) [Status: ${status}]:`, errMsg);
        return { error: errMsg };
      }
      
      // リトライ可能なエラーの場合のみ指数バックオフ
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
}

/**
 * 6. AIによるスクリーンショット自動解析API
 */
exports.analyzeScreenshot = onCall({ 
  region: "asia-northeast1", 
  memory: "1GiB" 
}, async (request) => {
  try {
    const base64Image = request.data.image; 
    const apiKey = process.env.GEMINI_API_KEY; 
    
    if (!apiKey) {
      throw new HttpsError('invalid-argument', "Gemini API Key is not configured in the environment.");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: { 
        responseMimeType: "application/json" 
      }
    });

    const prompt = `
      あなたはプロのWebスクレイピングエンジニアです。
      送られた画像は、ある官公庁や研究所のWebサイトの「開発者ツール（検証画面）」のスクリーンショットです。
      この画像から、新着情報や本文のリストを囲んでいる最も適切なメインのHTML要素の class または id を推測してください。
      また、そのリストの中に「毎回変わるノイズ（更新日など）」があれば、除外すべき要素として推測してください。
      
      必ず指定されたフォーマットのJSONオブジェクトのみを返却してください。
      {
        "targetSelector": "#news-list のような監視すべきCSSセレクタ（不明な場合は空文字）",
        "excludeSelector": ".date のような除外すべきCSSセレクタ（不明な場合は空文字）",
        "reason": "なぜそのように判断したか、初心者向けに日本語で優しい解説（200文字以内）"
      }
    `;

    const requestBody = [
      prompt,
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image.split(',')[1]
        }
      }
    ];

    const result = await model.generateContent(requestBody);
    const responseText = result.response.text().trim();
    
    return JSON.parse(responseText);

  } catch (error) {
    console.error("AI Analysis Error:", error);
    throw new HttpsError('internal', 'AIの解析中にエラーが発生しました: ' + error.message);
  }
});

/**
 * 7. 💡 【改善⑧】定期クリーンアップ（古い通知の削除）
 * 毎日深夜3時に動作し、30日以上経過した通知を自動で削除して無限増殖を防ぎます。
 */
exports.cleanupOldNotifications = onSchedule({
  schedule: "0 3 * * *",
  timeZone: "Asia/Tokyo",
  memory: "256MiB"
}, async (event) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  
  const snapshot = await db.collection("notifications")
    .where("detectedAt", "<", thirtyDaysAgo)
    .limit(500)
    .get();

  if (snapshot.empty) {
    console.log("削除対象の古い通知はありません。");
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
  console.log(`${snapshot.size} 件の古い通知を削除しました。`);
});