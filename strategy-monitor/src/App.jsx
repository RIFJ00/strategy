/**
 * 会議体ダッシュボード (修正機能・回次保存完全版)
 * --------------------------------------------------
 * [主な修正内容]
 * 1. 手動修正の改善: 日付の修正時に「第N回」も入力すれば、回数として正しく保存・表示されるよう修正。
 * 2. 分野プルダウン: Firestoreの登録順(createdAt)に完全固定。
 * 3. 未読状態の保護: 既読にするまで、何度巡回しても赤色のまま固定。
 * 4. スリープ防止 (Wake Lock): 一括巡回中に画面が暗くなっても処理を継続。
 * 5. リアルタイム同期: Firestore (seisakuresearch) の変更を即座に画面へ反映。
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { 
  getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken 
} from 'firebase/auth';
import { 
  getFirestore, collection, onSnapshot, query, doc, updateDoc, serverTimestamp, writeBatch, getDoc, setDoc
} from 'firebase/firestore';
import { 
  Search, CheckCircle, Clock, AlertTriangle, ExternalLink, 
  RefreshCw, Edit3, X, Database, PlayCircle, Loader2, Tag, Filter, Save, UserCheck, WifiOff, CheckSquare, Square, StopCircle, Play, RotateCcw, Eye, ArrowUpDown, EyeOff, Bookmark, MapPin, Power, Info, HelpCircle
} from 'lucide-react';

// --- Firebase 設定 ---
const firebaseConfig = {
  apiKey: "AIzaSyBx5e752GWfvJDZ3lEx0IcArxjvCEz7S2M",
  authDomain: "seisakuresearch00.firebaseapp.com",
  projectId: "seisakuresearch00",
  storageBucket: "seisakuresearch00.firebasestorage.app",
  messagingSenderId: "356788263577",
  appId: "1:356788263577:web:ecc3782d0c82cb7da43608"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);
const db = getFirestore(app);

const appId = 'seisakuresearch';

// Firestore パスヘルパー
const getMeetingsCol = () => collection(db, 'artifacts', appId, 'public', 'data', 'meetings');
const getMeetingDoc = (id) => doc(db, 'artifacts', appId, 'public', 'data', 'meetings', id);
const getSystemConfigDoc = () => doc(db, 'artifacts', appId, 'public', 'data', 'config', 'system');

// 日本の行政機関の建制順
const MINISTRY_ORDER = ["内閣官房", "内閣府", "デジタル庁", "復興庁", "総務省", "法務省", "外務省", "財務省", "文部科学省", "厚生労働省", "農林水産省", "経済産業省", "国土交通省", "環境省", "原子力規制委員会", "防衛省"];

// --- ユーティリティ ---
const normalizeText = (str) => {
  if (!str) return "";
  return str.replace(/[！-～]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/　/g, " ").replace(/\s+/g, " ").trim();
};

// 日付文字列からタイムスタンプを抽出
const parseDateToTs = (str) => {
  if (!str) return 0;
  try {
    const s = normalizeText(str);
    const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/;
    const match = s.match(dateRegex);
    if (!match) return 0;
    let year, month, day;
    const full = match[0];
    if (full.includes('令和')) {
      const reiwa = full.match(/令和\s*?(\d+|元)年/)[1];
      year = reiwa === '元' ? 2019 : 2018 + parseInt(reiwa, 10);
    } else {
      year = parseInt(full.match(/(\d{4})年/)[1], 10);
    }
    month = parseInt(full.match(/(\d{1,2})月/)[1], 10) - 1;
    day = parseInt(full.match(/(\d{1,2})日/)[1], 10);
    return new Date(year, month, day).getTime();
  } catch (e) { return 0; }
};

// 表示用：西暦変換（ただしカッコ内の「第N回」などは保護する）
const formatToWesternDatePreservingRound = (str) => {
  if (!str) return '';
  const ts = parseDateToTs(str);
  if (ts === 0) return normalizeText(str);
  
  const d = new Date(ts);
  const baseDate = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  
  // 元の文字列にカッコ書き（回数など）があれば抽出して結合
  const roundMatch = str.match(/\((.*?)\)/);
  return roundMatch ? `${baseDate} ${roundMatch[0]}` : baseDate;
};

const formatCheckTime = (ts) => {
  if (!ts) return '-';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// --- メインコンポーネント ---
export default function App() {
  const [user, setUser] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [isAutoUpdateOn, setIsAutoUpdateOn] = useState(true);
  const [loading, setLoading] = useState(true);

  // フィルター
  const [statusFilter, setStatusFilter] = useState('all');
  const [fieldFilter, setFieldFilter] = useState('all');
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // 操作
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [confirmingReadId, setConfirmingReadId] = useState(null); 
  const [editTarget, setEditTarget] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isMarkingAll, setIsMarkingAll] = useState(false);
  const [isClearingErrors, setIsClearingErrors] = useState(false);
  const [checkingId, setCheckingId] = useState(null); 
  const [statusMsg, setStatusMsg] = useState("");

  // 一括巡回
  const [isBulkChecking, setIsBulkChecking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [bulkCheckProgress, setBulkCheckProgress] = useState({ current: 0, total: 0 });
  const [queue, setQueue] = useState([]);
  const [confirmBatchModal, setConfirmBatchModal] = useState(null);

  const wakeLockRef = useRef(null);

  // 1. 統計情報
  const summary = useMemo(() => ({
    total: meetings.length,
    updated: meetings.filter(m => m.status === 'updated' && !m.isManual).length,
    manual: meetings.filter(m => m.status === 'updated' && m.isManual).length,
    unchanged: meetings.filter(m => m.status === 'unchanged').length,
    error: meetings.filter(m => m.status === 'error').length
  }), [meetings]);

  // 2. Firebase 認証
  useEffect(() => {
    let isMounted = true;
    const unsubscribeAuth = onAuthStateChanged(auth, (u) => {
      if (isMounted) setUser(u);
    });
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          try { await signInWithCustomToken(auth, __initial_auth_token); } catch (e) { await signInAnonymously(auth); }
        } else if (!auth.currentUser) { await signInAnonymously(auth); }
      } catch (e) { console.error("Auth Error:", e); }
    };
    initAuth();
    return () => { isMounted = false; unsubscribeAuth(); };
  }, []);

  // 3. リアルタイムデータ同期
  useEffect(() => {
    if (!user) return;
    setLoading(true);

    const unsubscribeConfig = onSnapshot(getSystemConfigDoc(), (snap) => {
      if (snap.exists()) setIsAutoUpdateOn(snap.data().autoUpdateEnabled ?? true);
    });

    const unsubscribeMeetings = onSnapshot(getMeetingsCol(), (snapshot) => {
      const data = snapshot.docs.map(doc => {
        const d = doc.data();
        const rawDateStr = d['直近開催日'] || d.latestDateString || '';
        return {
          id: doc.id,
          meetingName: d['会議名'] || d.meetingName || '無題の会議',
          url: d['URL'] || d.url || '',
          agency: d['所管'] || d['省庁'] || d.agency || '-',
          relatedField: d['関連分野'] || d.relatedField || '-',
          latestDateString: rawDateStr, 
          latestDateTimestamp: d.latestDateTimestamp || parseDateToTs(rawDateStr),
          previousDateString: d.previousDateString || '',
          meetingRound: d.meetingRound || '',
          status: d.status || 'unchanged',
          isManual: d.isManual || false, 
          lastCheckedAt: d.lastCheckedAt,
          errorMessage: d.errorMessage || null,
          createdAt: d.createdAt || null
        };
      });
      setMeetings(data);
      setLoading(false);
    }, (err) => {
      console.error("Firestore sync error:", err);
      setLoading(false);
    });

    return () => { unsubscribeConfig(); unsubscribeMeetings(); };
  }, [user]);

  // --- 並び替えとプルダウン ---

  // [重要] 分野プルダウン: 「登録順 (createdAt順)」に完全固定
  const uniqueFields = useMemo(() => {
    const sortedByRegistration = [...meetings].sort((a, b) => {
      const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (Number(a.createdAt) || 0);
      const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (Number(b.createdAt) || 0);
      return timeA - timeB;
    });
    const fields = [];
    sortedByRegistration.forEach(m => {
      if (m.relatedField && m.relatedField !== '-' && !fields.includes(m.relatedField)) {
        fields.push(m.relatedField);
      }
    });
    return fields;
  }, [meetings]);

  // 表のソート
  const sortedBaseList = useMemo(() => {
    return [...meetings].sort((a, b) => {
      const isUnreadA = a.status === 'updated'; const isUnreadB = b.status === 'updated';
      if (isUnreadA && !isUnreadB) return -1;
      if (!isUnreadA && isUnreadB) return 1;
      const isErrorA = a.status === 'error'; const isErrorB = b.status === 'error';
      if (isErrorA && !isErrorB) return -1;
      if (!isErrorA && isErrorB) return 1;
      const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (Number(a.createdAt) || 0);
      const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (Number(b.createdAt) || 0);
      return timeA - timeB;
    });
  }, [meetings]);

  const uniqueAgencies = useMemo(() => {
    const agencies = Array.from(new Set(meetings.map(m => m.agency).filter(a => a && a !== '-')));
    return agencies.sort((a, b) => {
      const idxA = MINISTRY_ORDER.indexOf(a); const idxB = MINISTRY_ORDER.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1; if (idxB !== -1) return 1;
      return a.localeCompare(b, 'ja');
    });
  }, [meetings]);

  const filteredAndSortedMeetings = useMemo(() => {
    return sortedBaseList.filter(m => {
      const q = searchQuery.toLowerCase();
      const matchesSearch = (m.meetingName || "").toLowerCase().includes(q);
      const matchesField = fieldFilter === 'all' || m.relatedField === fieldFilter;
      const matchesAgency = agencyFilter === 'all' || m.agency === agencyFilter;
      const filterByStatus = () => {
        if (statusFilter === 'all') return true;
        if (statusFilter === 'updated') return m.status === 'updated' && !m.isManual;
        if (statusFilter === 'manual') return m.status === 'updated' && m.isManual;
        return m.status === statusFilter;
      };
      return matchesField && matchesAgency && matchesSearch && filterByStatus();
    });
  }, [sortedBaseList, statusFilter, fieldFilter, agencyFilter, searchQuery]);

  // --- 解析ロジック (回次近接スキャン & 未読永続ガード) ---
  const executeCheck = async (meeting) => {
    if (!meeting.url || !user) return;
    setCheckingId(meeting.id);
    setStatusMsg(`[${meeting.meetingName}] 接続中...`);
    
    const proxies = [
      { name: "CodeTabs", url: (u) => `https://api.codetabs.com/v1/proxy?url=${encodeURIComponent(u)}`, isJson: false },
      { name: "AllOrigins", url: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}&t=${Date.now()}`, isJson: true }
    ];

    let html = ""; let success = false;
    for (const proxy of proxies) {
      try {
        const res = await fetch(proxy.url(meeting.url));
        if (!res.ok) throw new Error();
        html = proxy.isJson ? (await res.json()).contents : await res.text();
        if (html && html.length > 500) { success = true; break; }
      } catch (e) { await new Promise(r => setTimeout(r, 600)); }
    }

    if (!success) {
      const newPayload = { lastCheckedAt: serverTimestamp(), errorMessage: "接続失敗" };
      if (meeting.status !== 'updated') newPayload.status = 'error';
      await updateDoc(getMeetingDoc(meeting.id), newPayload);
      setCheckingId(null); return;
    }

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const bodyText = normalizeText(tempDiv.innerText || tempDiv.textContent || "");
    
    let rounds = [];
    const roundRegex = /第\s*?([0-9０-９]+|元)\s*?回/g;
    let rMatch;
    while ((rMatch = roundRegex.exec(bodyText)) !== null) {
      const num = rMatch[1] === '元' ? 1 : parseInt(normalizeText(rMatch[1]), 10);
      rounds.push({ str: rMatch[0], num, index: rMatch.index });
    }

    if (rounds.length > 0) {
      const targetRound = rounds.reduce((p, c) => (p.num > c.num) ? p : c);
      const start = Math.max(0, targetRound.index - 150);
      const end = Math.min(bodyText.length, targetRound.index + 400);
      const focusSnippet = bodyText.substring(start, end);

      const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/g;
      let candidates = [];
      let dMatch;
      while ((dMatch = dateRegex.exec(focusSnippet)) !== null) {
        const ts = parseDateToTs(dMatch[0]);
        if (ts > 0) {
          const distToRound = Math.abs(dMatch.index - 150); 
          const ctx = focusSnippet.substring(Math.max(0, dMatch.index - 60), dMatch.index + 60);
          const bonus = /開催|案内|日時|次第|資料|予定/.test(ctx) ? 100000 : 0;
          const penalty = /更新|作成|公開|最終|Last/.test(ctx) ? 80000 : 0;
          candidates.push({ str: dMatch[0], ts, score: bonus - penalty - distToRound });
        }
      }

      let bestDate = candidates.length > 0 ? candidates.reduce((p, c) => (p.score > c.score) ? p : c) : null;
      if (!bestDate) {
        let globalDates = [];
        dateRegex.lastIndex = 0;
        while ((dMatch = dateRegex.exec(bodyText)) !== null) {
          const ts = parseDateToTs(dMatch[0]);
          if (ts > 0) globalDates.push({ str: dMatch[0], ts });
        }
        if (globalDates.length > 0) bestDate = globalDates.reduce((p, c) => (p.ts > c.ts) ? p : c);
      }

      const currentTs = meeting.latestDateTimestamp || 0;
      const currentRoundNum = (meeting.meetingRound || "").match(/\d+/) ? parseInt(meeting.meetingRound.match(/\d+/)[0], 10) : 0;

      if (targetRound.num > currentRoundNum || (bestDate && bestDate.ts > currentTs)) {
        const finalDate = bestDate ? formatToWesternDatePreservingRound(bestDate.str) : formatToWesternDatePreservingRound(meeting.latestDateString);
        const combined = `${finalDate} (${targetRound.str})`;
        await updateDoc(getMeetingDoc(meeting.id), {
          latestDateString: combined, '直近開催日': combined,
          latestDateTimestamp: bestDate ? bestDate.ts : currentTs,
          meetingRound: targetRound.str, previousDateString: meeting.latestDateString,
          status: 'updated', isManual: false, lastCheckedAt: serverTimestamp(), errorMessage: null
        });
      } else {
        await updateDoc(getMeetingDoc(meeting.id), { lastCheckedAt: serverTimestamp(), errorMessage: null });
      }
    } else {
      await updateDoc(getMeetingDoc(meeting.id), { lastCheckedAt: serverTimestamp() });
    }
    setCheckingId(null); setStatusMsg("");
  };

  // 一括巡回処理
  const handleBulkStart = async (targets) => {
    setConfirmBatchModal(null); setIsBulkChecking(true); setIsPaused(false);
    setBulkCheckProgress({ current: 0, total: targets.length });
    setQueue([...targets]);
    try {
      if ('wakeLock' in navigator) wakeLockRef.current = await navigator.wakeLock.request('screen');
    } catch (e) { console.warn("Wake Lock Error"); }
  };

  const handleBulkStop = () => {
    setIsBulkChecking(false); setQueue([]);
    if (wakeLockRef.current) { wakeLockRef.current.release(); wakeLockRef.current = null; }
  };

  useEffect(() => {
    if (!isBulkChecking || isPaused || queue.length === 0) return;
    const processNext = async () => {
      await executeCheck(queue[0]);
      if (!isPaused) {
        setQueue(prev => {
          const next = prev.slice(1);
          if (next.length === 0) handleBulkStop();
          return next;
        });
        setBulkCheckProgress(prev => ({ ...prev, current: prev.current + 1 }));
      }
    };
    const timer = setTimeout(processNext, 1200);
    return () => clearTimeout(timer);
  }, [isBulkChecking, isPaused, queue]);

  const handleMarkAllRead = async () => {
    if (!user || isMarkingAll) return;
    const targets = meetings.filter(m => m.status === 'updated');
    if (targets.length === 0) return;
    if (!window.confirm(`${targets.length} 件をすべて既読にしますか？`)) return;

    setIsMarkingAll(true);
    try {
      const batch = writeBatch(db);
      targets.forEach(m => {
        const docRef = doc(db, 'artifacts', 'seisakuresearch', 'public', 'data', 'meetings', m.id);
        batch.update(docRef, { status: 'unchanged', isManual: false, previousDateString: "" });
      });
      await batch.commit();
      setStatusMsg("一括更新完了");
    } catch (e) {
      console.error("Batch update failed:", e);
    } finally {
      setTimeout(() => { setIsMarkingAll(false); setStatusMsg(""); }, 2000);
    }
  };

  // エラー一括解除
  const handleClearAllErrors = async () => {
    if (!user || isClearingErrors) return;
    const targets = meetings.filter(m => m.status === 'error');
    if (targets.length === 0) return;
    if (!window.confirm(`${targets.length} 件のエラー状態をすべて解除し、変更なしに戻しますか？`)) return;

    setIsClearingErrors(true);
    try {
      const batch = writeBatch(db);
      targets.forEach(m => {
        const docRef = doc(db, 'artifacts', 'seisakuresearch', 'public', 'data', 'meetings', m.id);
        batch.update(docRef, { status: 'unchanged', errorMessage: null });
      });
      await batch.commit();
      setStatusMsg("エラー一括解除完了");
    } catch (e) {
      console.error("Batch update failed:", e);
    } finally {
      setTimeout(() => { setIsClearingErrors(false); setStatusMsg(""); }, 2000);
    }
  };

  // --- 手動修正の保存ロジック (回数抽出に対応) ---
  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editTarget || !user || isSaving) return;
    
    setIsSaving(true);
    try {
      const rawInput = normalizeText(editTarget.latestDateString);
      
      // 入力から「第N回」を抽出
      const roundMatch = rawInput.match(/第\s*?([0-9０-９]+|元)\s*?回/);
      const extractedRound = roundMatch ? roundMatch[0] : (editTarget.meetingRound || "");

      // 日付を西暦に変換
      const westernDate = formatToWesternDatePreservingRound(rawInput);
      const newTs = parseDateToTs(westernDate);

      const updatePayload = {
        '直近開催日': rawInput,
        latestDateString: rawInput,
        latestDateTimestamp: newTs,
        meetingRound: extractedRound,
        status: 'unchanged',
        isManual: false,
        errorMessage: null,
        lastModifiedAt: serverTimestamp()
      };

      await updateDoc(getMeetingDoc(editTarget.id), updatePayload);
      setEditTarget(null);
    } catch (err) {
      console.error("Save error:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReadConfirm = (e, meeting) => {
    e.stopPropagation();
    if (confirmingReadId === meeting.id) {
      handleToggleStatus(meeting);
      setConfirmingReadId(null);
    } else {
      setConfirmingReadId(meeting.id);
      setTimeout(() => setConfirmingReadId(null), 5000);
    }
  };

  const handleToggleStatus = async (meeting) => {
    if (!user) return;
    const docRef = getMeetingDoc(meeting.id);
    if (meeting.status === 'updated') {
      await updateDoc(docRef, { status: 'unchanged', isManual: false, previousDateString: "" });
    } else {
      await updateDoc(docRef, { status: 'updated', isManual: true });
    }
  };

  const toggleAutoUpdate = async () => {
    if (!user) return;
    const newVal = !isAutoUpdateOn;
    setIsAutoUpdateOn(newVal);
    try { await setDoc(getSystemConfigDoc(), { autoUpdateEnabled: newVal, lastModifiedAt: serverTimestamp() }, { merge: true }); } catch (e) { }
  };

  if (loading && meetings.length === 0) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 gap-4">
      <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest text-center">Initializing Secure Live Sync...</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 font-sans text-gray-900">
      <div className="max-w-7xl mx-auto space-y-4">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between bg-white p-5 rounded-3xl shadow-sm border border-gray-100">
          <div className="flex flex-col md:flex-row md:items-center gap-6">
            <div>
              <h1 className="text-xl font-black flex items-center gap-3 text-gray-900 leading-none">
                <div className="p-2 bg-indigo-600 rounded-xl text-white shadow-lg"><Database className="w-5 h-5" /></div>
                Strategy Monitor
              </h1>
              <div className="mt-2 flex items-center gap-3 opacity-70">
                <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full ${user ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'} text-[9px] font-black uppercase tracking-wider`}>
                  {user ? <UserCheck className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                  {user ? `READY` : 'OFFLINE'}
                </div>
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest px-1">Live Sync Active</p>
              </div>
            </div>
            <div className="flex items-center gap-3 bg-gray-50 px-4 py-2.5 rounded-2xl border border-gray-100 shadow-inner">
              <div className={`p-2 rounded-xl ${isAutoUpdateOn ? 'bg-green-500 text-white' : 'bg-gray-300 text-white'} transition-colors`}><Power className="w-4 h-4" /></div>
              <div className="flex flex-col">
                <span className="text-[9px] text-gray-400 uppercase tracking-tighter mb-1 leading-none font-black">Daily Auto Update</span>
                <div className="flex items-center gap-2">
                  <span className={isAutoUpdateOn ? 'text-green-600 text-xs font-black' : 'text-gray-400 text-xs font-black'}>{isAutoUpdateOn ? 'ENABLED' : 'DISABLED'}</span>
                  <button onClick={toggleAutoUpdate} className={`relative w-8 h-4 rounded-full transition-colors ${isAutoUpdateOn ? 'bg-green-500' : 'bg-gray-300'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${isAutoUpdateOn ? 'translate-x-4' : ''}`}></div>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 md:mt-0 flex flex-wrap gap-2">
            {summary.error > 0 && (
              <button onClick={handleClearAllErrors} disabled={isClearingErrors || isBulkChecking} className="flex items-center gap-2 px-5 py-2.5 bg-orange-50 text-orange-600 rounded-2xl font-black shadow-sm text-sm hover:bg-orange-100 border border-orange-200 transition-all active:scale-95 disabled:opacity-50">
                {isClearingErrors ? <Loader2 className="w-5 h-5 animate-spin" /> : <AlertTriangle className="w-5 h-5" />} 
                エラーを一括解除
              </button>
            )}
            {(summary.updated + summary.manual) > 0 && (
              <button onClick={handleMarkAllRead} disabled={isMarkingAll || isBulkChecking} className="flex items-center gap-2 px-5 py-2.5 bg-gray-100 text-gray-600 rounded-2xl font-black shadow-sm text-sm hover:bg-gray-200 border border-gray-200 transition-all active:scale-95 disabled:opacity-50">
                {isMarkingAll ? <Loader2 className="w-5 h-5 animate-spin" /> : <Eye className="w-5 h-5" />} 
                全て既読にする
              </button>
            )}
            <button 
              onClick={() => setConfirmBatchModal({ targets: selectedIds.size > 0 ? meetings.filter(m => selectedIds.has(m.id)) : filteredAndSortedMeetings })} 
              disabled={isBulkChecking || !user || meetings.length === 0}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-2xl font-black shadow-lg transition-all active:scale-95 text-sm ${selectedIds.size > 0 ? 'bg-indigo-500 text-white animate-pulse' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-100'}`}
            >
              <RefreshCw className={`w-5 h-5 ${isBulkChecking ? 'animate-spin' : ''}`} /> 
              {isBulkChecking ? '巡回中...' : (selectedIds.size > 0 ? `選択分 (${selectedIds.size}) 更新` : '一括巡回 (今すぐ更新)')}
            </button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <button onClick={() => { setStatusFilter('all'); setSearchQuery(''); }} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'all' ? 'ring-4 ring-indigo-50 border-indigo-500 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-gray-400">総監視数</span>
            <span className="text-2xl font-black text-gray-900">{meetings.length}</span>
          </button>
          <button onClick={() => setStatusFilter('updated')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'updated' ? 'ring-4 ring-red-50 border-red-500 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-red-400">更新あり</span>
            <span className="text-2xl font-black text-red-600 animate-pulse">{summary.updated}</span>
          </button>
          <button onClick={() => setStatusFilter('manual')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'manual' ? 'ring-4 ring-blue-50 border-blue-500 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-blue-400">チェック用</span>
            <span className="text-2xl font-black text-blue-600">{summary.manual}</span>
          </button>
          <button onClick={() => setStatusFilter('unchanged')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'unchanged' ? 'ring-4 ring-gray-100 border-gray-400 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-gray-400">変更なし</span>
            <span className="text-2xl font-black text-gray-900">{summary.unchanged}</span>
          </button>
          <button onClick={() => setStatusFilter('error')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'error' ? 'ring-4 ring-orange-50 border-orange-500 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-orange-400">エラー</span>
            <span className="text-2xl font-black text-orange-600">{summary.error}</span>
          </button>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="relative group md:col-span-2">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="キーワード検索..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full pl-10 pr-4 py-3 bg-white border border-gray-100 rounded-2xl shadow-sm text-sm font-bold focus:ring-2 focus:ring-indigo-50 outline-none" />
          </div>
          <div className="relative">
            <Filter className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select value={fieldFilter} onChange={e => setFieldFilter(e.target.value)} className="w-full pl-10 pr-8 py-3 bg-white border border-gray-100 rounded-2xl appearance-none font-black text-gray-700 text-xs shadow-sm cursor-pointer outline-none">
              <option value="all">全ての分野</option>
              {uniqueFields.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="relative">
            <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select value={agencyFilter} onChange={e => setAgencyFilter(e.target.value)} className="w-full pl-10 pr-8 py-3 bg-white border border-gray-100 rounded-2xl appearance-none font-black text-gray-700 text-xs shadow-sm cursor-pointer outline-none">
              <option value="all">全ての所管</option>
              {uniqueAgencies.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>

        {/* Table Area */}
        <div className="bg-white rounded-[2.5rem] shadow-xl border border-gray-100 overflow-hidden min-h-[450px]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead className="bg-gray-50/50 text-gray-400 font-black border-b border-gray-100 uppercase tracking-widest text-[9px]">
                <tr>
                  <th className="px-4 py-6 w-10 text-center">
                    <button onClick={() => {
                      if (selectedIds.size === filteredAndSortedMeetings.length) setSelectedIds(new Set());
                      else setSelectedIds(new Set(filteredAndSortedMeetings.map(m => m.id)));
                    }} className="p-1 hover:bg-gray-200 rounded transition-colors">
                      {selectedIds.size === filteredAndSortedMeetings.length && filteredAndSortedMeetings.length > 0 ? <CheckSquare className="w-5 h-5 text-indigo-600" /> : <Square className="w-5 h-5 text-gray-300" />}
                    </button>
                  </th>
                  <th className="px-6 py-6 w-60 text-left">状態 / 巡回時間</th>
                  <th className="px-6 py-6 font-black">会議体名 / 分野 / 所管</th>
                  <th className="px-6 py-6 text-center w-64 text-gray-400 font-bold italic">開催日 (最新)</th>
                  <th className="px-8 py-6 text-right font-black">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 font-sans">
                {filteredAndSortedMeetings.map(m => (
                  <tr key={m.id} className={`group hover:bg-gray-50/10 transition-all ${selectedIds.has(m.id) ? 'bg-indigo-50/30' : ''} ${m.status === 'updated' && !m.isManual ? 'bg-red-50/10' : ''}`}>
                    <td className="px-4 py-4 align-middle text-center">
                       <button onClick={() => {
                         const next = new Set(selectedIds);
                         if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                         setSelectedIds(next);
                       }} className="p-1 hover:bg-indigo-100 rounded transition-colors">
                         {selectedIds.has(m.id) ? <CheckSquare className="w-5 h-5 text-indigo-600" /> : <Square className="w-5 h-5 text-gray-200" />}
                       </button>
                    </td>
                    <td className="px-6 py-4 align-middle text-left">
                      <div className="flex flex-col gap-1.5 items-start min-w-[210px]">
                        {m.status === 'updated' ? (
                          <>
                            <div className="flex items-center gap-2">
                              {/* 2段階既読ボタン */}
                              <button onClick={(e) => handleReadConfirm(e, m)} className={`px-3 py-1 text-[9px] font-black rounded-lg shadow-sm flex items-center gap-1 active:scale-95 transition-all ${confirmingReadId === m.id ? 'bg-red-900 text-white scale-105' : 'bg-red-600 text-white hover:bg-red-700'}`}>
                                {confirmingReadId === m.id ? <HelpCircle className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
                                {confirmingReadId === m.id ? '本当によろしいですか？' : '既読にする'}
                              </button>
                              <span className="text-[7.5px] text-gray-400 font-bold opacity-80 uppercase">{formatCheckTime(m.lastCheckedAt)}</span>
                            </div>
                            <div className={`flex items-center gap-1.5 text-[8.5px] font-black px-2 py-0.5 rounded border ${m.isManual ? 'bg-gray-50 text-gray-500 border-gray-200' : 'bg-red-50 text-red-600 border-red-200'}`}>{m.isManual ? <Bookmark className="w-2.5 h-2.5 text-blue-500" /> : <RefreshCw className="w-2.5 h-2.5 animate-spin-slow text-red-500" />}{m.isManual ? 'チェック用' : '未読（新着）'}</div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-2 text-left">
                              <div className={`flex items-center gap-1 text-[8.5px] font-black px-2 py-1 rounded-lg border leading-none ${m.status === 'error' ? 'bg-orange-100 text-orange-700 border-orange-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`}>{m.status === 'error' ? <AlertTriangle className="w-2.5 h-2.5" /> : <CheckCircle className="w-2.5 h-2.5 text-gray-300" />} {m.status === 'error' ? 'エラー' : '変更なし'}</div>
                              <span className="text-[7.5px] text-gray-400 font-bold uppercase">{formatCheckTime(m.lastCheckedAt)}</span>
                            </div>
                            <button onClick={() => handleToggleStatus(m)} className="text-[8px] font-black text-indigo-400 hover:text-indigo-600 px-2 leading-none">未読とする</button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 align-middle">
                      <div className="font-semibold text-gray-900 text-sm leading-tight line-clamp-1 group-hover:text-indigo-600 transition-colors">{m.meetingName}</div>
                      <div className="flex flex-wrap items-center gap-2 mt-1 opacity-70">
                        <span className="flex items-center gap-1 text-[8px] font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 shadow-sm"><Tag className="w-2.5 h-2.5" /> {m.relatedField || '-'}</span>
                        <span className="flex items-center gap-1 text-[8px] font-black text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200 shadow-sm"><MapPin className="w-2.5 h-2.5" /> {m.agency}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 align-middle text-center">
                      <div className="flex flex-col items-center justify-center gap-0.5">
                        <div className={`text-xs font-black ${m.status === 'updated' && !m.isManual ? 'text-red-600 animate-pulse' : 'text-gray-600'}`}>{m.latestDateString || '未定'}</div>
                        {m.previousDateString && <div className="text-[10px] text-gray-400 font-bold opacity-70 line-through leading-none">{m.previousDateString}</div>}
                      </div>
                    </td>
                    <td className="px-8 py-4 align-middle text-right">
                      <div className="flex justify-end items-center gap-1.5 opacity-30 group-hover:opacity-100 transition-opacity">
                        <button onClick={(e) => { e.stopPropagation(); executeCheck(m); }} disabled={checkingId === m.id || isBulkChecking} className="p-2 text-indigo-600 bg-white border border-indigo-50 rounded-xl hover:bg-indigo-600 hover:text-white transition-all shadow-sm active:scale-90 shadow-indigo-100">
                          {checkingId === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); setEditTarget(m); }} disabled={isBulkChecking} className="p-2 text-blue-600 bg-white border border-blue-50 rounded-xl hover:bg-blue-600 hover:text-white transition-all shadow-sm active:scale-90"><Edit3 className="w-4 h-4" /></button>
                        <a href={m.url} target="_blank" rel="noopener noreferrer" className="p-2 text-gray-400 bg-white border border-gray-100 rounded-xl hover:text-indigo-600 transition-all shadow-sm"><ExternalLink className="w-4 h-4" /></a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 巡回パネル (浮遊式コントロールセンター) */}
      {isBulkChecking && (
        <div className="fixed bottom-8 right-8 bg-white p-8 rounded-[2.5rem] shadow-2xl border-2 border-indigo-50 z-50 w-80 animate-in slide-in-from-right-10">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className={`p-3 rounded-2xl shadow-inner ${isPaused ? 'bg-orange-50' : 'bg-indigo-50'}`}>
                <RefreshCw className={`w-6 h-6 ${isPaused ? 'text-orange-600' : 'text-indigo-600 animate-spin'}`} />
              </div>
              <h3 className="font-black text-gray-900 leading-none text-sm">{isPaused ? '一時停止中' : '巡回実行中...'}</h3>
            </div>
            <div className="flex gap-1.5">
              {isPaused ? (
                <>
                  <button onClick={() => setIsPaused(false)} className="p-2.5 bg-green-50 text-green-600 rounded-xl active:scale-90 border border-green-100 shadow-sm"><Play className="w-4 h-4 fill-current" /></button>
                  <button onClick={() => handleBulkStop()} className="p-2.5 bg-red-50 text-red-600 rounded-xl active:scale-90 border border-red-100 shadow-sm"><RotateCcw className="w-4 h-4" /></button>
                </>
              ) : (
                <button onClick={() => setIsPaused(true)} className="p-2.5 bg-orange-50 text-orange-600 rounded-xl active:scale-90 border border-orange-100 shadow-sm"><StopCircle className="w-5 h-5 fill-current" /></button>
              )}
            </div>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-3 mb-4 overflow-hidden shadow-inner">
            <div className={`h-full transition-all duration-700 ${isPaused ? 'bg-orange-400' : 'bg-gradient-to-r from-indigo-500 to-indigo-700'}`} style={{ width: `${(bulkCheckProgress.current / bulkCheckProgress.total) * 100}%` }}></div>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-black text-gray-900 leading-none">{bulkCheckProgress.current}</span>
            <span className="text-xs font-bold text-gray-400">/ {bulkCheckProgress.total} 完了 ({Math.round((bulkCheckProgress.current / bulkCheckProgress.total) * 100)}%)</span>
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-[9px] font-black text-indigo-400 uppercase tracking-tighter italic text-center">
             Wake Lock Active - Sleepless Check
          </div>
        </div>
      )}

      {/* 確認モーダル */}
      {confirmBatchModal && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-md flex items-center justify-center z-[60] p-4 text-center">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-sm p-8 space-y-5 animate-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mx-auto shadow-inner"><RefreshCw className="w-8 h-8" /></div>
            <h3 className="text-xl font-black text-gray-900 tracking-tight leading-tight px-2">巡回チェックを開始しますか？</h3>
            <p className="text-xs text-gray-500 font-bold px-4 leading-relaxed">対象: <span className="text-indigo-600 text-base">{confirmBatchModal.targets.length}</span> 件の会議体</p>
            <div className="pt-4 flex gap-3">
              <button onClick={() => setConfirmBatchModal(null)} className="flex-1 py-4 bg-gray-100 text-gray-400 font-black rounded-2xl hover:bg-gray-200 transition-all text-xs uppercase">戻る</button>
              <button onClick={() => handleBulkStart(confirmBatchModal.targets)} className="flex-1 py-4 bg-indigo-600 text-white font-black rounded-2xl hover:bg-indigo-700 shadow-xl shadow-indigo-100 transition-all active:scale-95 text-xs uppercase">実行する</button>
            </div>
          </div>
        </div>
      )}

      {/* 編集モーダル (改善版) */}
      {editTarget && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-md flex items-center justify-center z-50 p-4 font-sans">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8 border border-gray-100 animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-black text-gray-900 flex items-center gap-2 text-base leading-none"><Edit3 className="w-5 h-5 text-blue-600" /> データの修正</h2>
              <button onClick={() => setEditTarget(null)} className="p-2 text-gray-400 hover:bg-gray-200 rounded-full transition-all"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSaveEdit} className="space-y-6">
              <div>
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 block px-1">対象の会議体</label>
                <div className="px-5 py-4 bg-gray-50 border border-gray-100 rounded-2xl font-bold text-gray-700 text-xs truncate leading-relaxed">{editTarget.meetingName}</div>
              </div>
              <div>
                <label className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-2 block px-1 leading-none font-black mb-2">
                  開催日 (第N回も含めて入力)
                </label>
                <input 
                  type="text" 
                  autoFocus
                  value={editTarget.latestDateString} 
                  onChange={e => setEditTarget({...editTarget, latestDateString: e.target.value})} 
                  className="w-full px-5 py-5 bg-indigo-50 border-2 border-indigo-100 rounded-2xl focus:ring-4 focus:ring-indigo-100 outline-none font-black text-indigo-700 text-base shadow-inner" 
                  placeholder="例: 令和8年4月11日 (第15回)" 
                />
                <p className="mt-2 text-[10px] text-gray-400 px-1 font-bold italic">※「(第〇回)」と書くと回数も保存されます</p>
              </div>
              <div className="pt-4 flex gap-3">
                <button type="button" onClick={() => setEditTarget(null)} className="flex-1 py-4 bg-gray-100 text-gray-400 font-black rounded-2xl hover:bg-gray-200 transition-all text-xs uppercase">キャンセル</button>
                <button type="submit" disabled={isSaving} className="flex-1 py-4 bg-indigo-600 text-white font-black rounded-2xl hover:bg-indigo-700 shadow-xl shadow-indigo-100 transition-all active:scale-95 text-xs uppercase flex items-center justify-center gap-2">
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} 保存する
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}